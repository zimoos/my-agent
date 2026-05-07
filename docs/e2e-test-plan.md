# my-agent E2E 测试方案（方案 A）

> 架构师 A 出品。目标：让 my-agent 在真实本地模型（Qwen3 + LM Studio）+ 真实 MCP 子进程 + 真实 PTY 下，具备生产级的端到端信心。
>
> 核心理念：**三层金字塔 + flaky 预算 + 证据化报告**。每层职责单一、越往上越真实越慢，用 retry + quorum 抵御 LLM 随机性，用结构化产物代替"log 里翻翻看"。

---

## 0. TL;DR

| 层 | 入口 | 真实度 | 跑多快 | 跑多频 | 关心什么 |
|----|------|--------|--------|--------|----------|
| L1 API | `curl` / `fetch` 直打 `/chat/completions` | 只有模型是真的 | 单 case 5–20s | 每次 CI | 模型本身的 tool-use 能力、messages 结构合法性 |
| L2 Agent | `import { createAgent }` | model 真 + tool 真 + UI 假 | 单 case 20–60s | 每次 CI | agent loop 的正确性（foldMessages、retry、thinking 过滤、错误阻断）|
| L3 CLI | `node-pty spawn ma` | 全真 | 单 case 40–300s | 每日 + 手动 | 终端渲染、快捷键、Session resume、真实用户路径 |

L1 / L2 强制必过；L3 允许 flaky，用 quorum（3 跑 2 过）+ 明确 flaky 标记处理 Qwen3 30–40% 随机失败。

---

## 1. 测试分层

### L1 — API 层（契约层）

**定位**：验证"我们发给模型的 messages 长什么样"和"模型回给我们的 tool_calls 能不能用"。这层完全绕过 agent.ts，直接对 `config.model.baseURL` 发裸 HTTP 请求。

**目的**：
- 锁死 request/response 的 schema 契约（tool schema、tool_choice、message 顺序）。
- 隔离判断：当 L2/L3 挂的时候，先看 L1 — L1 红 = 模型侧 / request 构造问题；L1 绿 = agent loop 的锅。
- 评估模型原生 tool-use 能力基线（不同 prompt 下的 tool_call 触发率）。

**覆盖**：
- 单轮 tool_call 触发（给定 prompt，模型是否调工具）
- 多轮 tool_result 回填（把 assistant.tool_calls + tool 消息回传，是否回答）
- 异常 payload 接收：500 / 非 JSON / 字段缺失 / thinking 前缀泄露到 content
- foldMessages 后的等效 messages（把"压缩后的历史"直接打给模型，看是否还能答）

**实现形态**：
- 首选 `tsx --test test/e2e/api/*.test.ts`（复用现有 `node:test`），内部用 `fetch` 直打，不走 OpenAI SDK，避免 SDK 版本干扰契约判断。
- 保留现有 `test/e2e-model.sh` 作为"无 Node 也能跑"的冒烟版，纳入 L1 但不是主力。

**运行频率**：每次 PR CI。总时长 < 3 分钟。

**环境依赖**：只需要本地模型服务可达（`curl $MA_API/models` 返回 200 且含 `$MA_MODEL`）。

---

### L2 — Agent 层（业务逻辑层）

**定位**：`import { createAgent }` 直接调 `chat()` async generator，吞事件流做断言。**model 是真的**（为了测真实 tool_call 行为），**MCP 是真的**（spawn 子进程，不 mock），只是没有 Ink UI。

**目的**：
- 验证 agent.ts 的所有逻辑分支：foldMessages、compactToolResult、errorHistory 阻断、500 retry-and-truncate、thinking token 过滤、empty-content 续问、danger guard、task stack。
- 断言级别细到 event：`tool:call` / `tool:result` / `thinking:start` / `compact:done` / `task:done` 的出现顺序和字段。
- 快速复现已知 bug（比如"模型调完工具不回答"），不用等 PTY 启动那 12 秒。

**覆盖**：
- 所有"已知问题 1–6"
- 所有业务场景（见 §2），除了纯 UI 相关的（快捷键、图片粘贴、stack render）
- Session store 的 append / load / resume（用临时目录，不污染 `~/.my-agent`）

**实现形态**：
- 单文件 `test/e2e/agent/<scenario>.test.ts`，每个文件一个 scenario group。
- Helper `runAgent(userInput, opts)` 返回 `{ events[], messages[], finalText, toolCalls[] }`，所有断言基于这个结构。
- **禁止 mock model**（项目红线）；**允许 mock 文件系统操作**？不，也不 mock — 在 `fixtures/` 下准备真文件，cwd 切过去。
- 500 / 空回答 / 异常工具返回这类"坏路径"，用 **真实 fault-injection MCP**：准备一个 `test/e2e/fixtures/mcp-fault/` 的 MCP server，按环境变量返回特定失败（真实进程，只是行为可控）。不 mock model 不等于不能注入故障 — 注入点在 MCP 而不是 model。
- 500 retry 这类涉及模型 5xx 的路径，通过一个小的 **local reverse proxy**（第一次请求返回 500，第二次透传到真实模型）实现，而不是 mock OpenAI client。这仍然满足"不 mock"（进程真、HTTP 真、模型真）。

**运行频率**：每次 PR CI。总时长 < 8 分钟。

---

### L3 — CLI 层（用户视角层）

**定位**：`node-pty` 真实 spawn `ma`，靠 stdout 文本 + API debug log 断言。完全用户视角。

**目的**：
- 验证终端渲染、快捷键、Session CLI 子命令、`/` 命令、多轮对话、resume。
- 抓只在"完整栈跑通"时才暴露的 regression（MaxListeners 泄漏、HTML 渲染漏网、ink 重绘抖动）。
- 作为发版前最后一道门。

**覆盖**：
- 至少覆盖 `test/cases/README.md` 里 20 套中最具代表性的 8 套（§2 会挑）。
- 横切检查：`MaxListenersExceededWarning`、HTML 标签泄露（沿用现有 e2e.sh 的规则）。

**实现形态**：
- 沿用 `test/e2e-real.ts` 的模式：`node-pty.spawn` + `waitFor(predicate)` + `stripAnsi`。
- **PTY 注入技巧（mnemo: 923）**：`proc.write(text)` → sleep 800ms → `proc.write('\r')`，禁止合并，否则 Ink 吃不到 `key.return`。
- 每个 test 用独立 cwd（fixture 项目的 tmpfs 副本），跑完 `rm -rf`。
- 用 `~/.my-agent/api-debug.log` 做双重断言（UI 文本 + 真实 request 数）。

**运行频率**：每日一次（GitHub Actions schedule）+ 手动触发 + release 前。总时长 15–30 分钟（含 retry）。

---

## 2. 测试场景分类

> 每个场景下面的 **层** 字段说明要在 L1/L2/L3 中哪些层实现。绝大多数场景在 L2 跑，只有"涉及 UI/快捷键/完整栈"的才进 L3。

### 2.1 项目分析

#### S1.1 简单问（单轮、预期调工具）
- **层**：L2 + L3
- **输入**：`这个项目是干什么的`（cwd = fixtures/simple-node-project）
- **预期**：
  - 至少调用 1 次 `fs__list_directory` 或 `fs__read_file`
  - 最终 assistant content 含中文 ≥ 30 字
  - 无 `tool_calls` 的空 assistant（`contentBuf.trim().length === 0`）
- **通过标准**：
  - L2: `toolCalls.length >= 1 && finalText.match(/[一-鿿]/g).length >= 30 && !events.some(e => e.type === 'tool:result' && e.ok === false)`
  - L3: stdout 含 `✓`（工具成功）+ `完成` + 无 `[error]`/`5\d\d Error`
- **失败标准**：finalText 为空 / 只调工具不回答 / 报 5xx / 中文字数 < 10
- **超时**：L2 60s，L3 180s

#### S1.2 追问（多轮、预期基于上文、不重复调工具）
- **层**：L2 + L3
- **输入**：
  1. `这个项目用了什么技术栈`（等完成）
  2. `详细说说`
- **预期**：
  - 第二轮 `tool_calls.length === 0` **或** 调的工具与第一轮参数不完全相同（允许读新文件，禁止重复读 package.json）
  - 第二轮 finalText 长度 > 第一轮的一半（确保真的"详细了"）
- **通过标准**：
  - L2: 第二轮 messages 里不出现与第一轮 identical 的 tool_call argument
  - L3: `api-debug.log` 里第二轮 tool_calls 数 <= 1 或 0
- **超时**：L2 180s，L3 360s

#### S1.3 深度分析（多轮、触发 create_task）
- **层**：L2（L3 可选，因为耗时）
- **输入**：`帮我分析这个项目的架构设计`
- **预期**：至少一次 `create_task` 或连续 ≥ 3 次不同的 tool_call；最终答复含 "架构" / "模块" / "依赖" 等关键词至少 2 个
- **超时**：L2 300s

---

### 2.2 文件操作

#### S2.1 读文件
- **层**：L2
- **输入**：`读一下 ./package.json 告诉我版本`
- **预期**：调 `fs__read_file`；finalText 提及具体版本号（fixture 控制）

#### S2.2 写文件
- **层**：L2 + L3
- **输入**：`创建 hello.txt 内容是 hello world`
- **预期**：
  - 调 `fs__write_file` 或 `fs-edit__*`
  - fixture 目录下 `hello.txt` 存在且内容匹配
- **清理**：每个 test 用独立 tmpdir

#### S2.3 编辑文件（读-改-写）
- **层**：L2
- **输入**：预置 `README.md` 含 `VERSION: 1.0.0`，输入 `把 README 里的版本改成 2.0.0`
- **预期**：
  - 先 read_file 再 fs-edit__* 或 write_file
  - 结果文件含 `VERSION: 2.0.0` 且不含 `1.0.0`

---

### 2.3 命令执行

#### S3.1 成功
- **层**：L2
- **输入**：`跑 node -v 告诉我版本`
- **预期**：调 `exec__execute_command`；finalText 含 `v\d+\.\d+`

#### S3.2 失败
- **层**：L2
- **输入**：`跑 nonexistent-command-xyz`
- **预期**：
  - 第一次 tool:result `ok: false`
  - **不** 进入无限 retry（`errorHistory` 阻断生效，同一命令 ≤ 2 次）
  - finalText 承认失败，不胡编结果

#### S3.3 超时
- **层**：L2（用 fault-injection MCP 模拟长跑）
- **输入**：`跑一个耗时 60 秒的命令`（让模型调到 fault MCP，fault MCP sleep 然后返回）
- **预期**：在 agent 配置的超时内 abort，tool:result 含 "timeout" / "aborted"

---

### 2.4 搜索

#### S4.1 grep
- **层**：L2
- **输入**：`找一下项目里哪里用了 useState`（fixture 预置含 2 处）
- **预期**：调 `grep__*`；finalText 提及具体文件路径至少 1 个

#### S4.2 web
- **层**：L2（**可 skip**，依赖外网 + DuckDuckGo，不稳定）
- **输入**：`搜一下 React 19 新特性`
- **预期**：调 `web__*`；finalText 长度 > 100 字
- **标记**：默认 `test.skip`，手动 `E2E_WEB=1` 才跑

---

### 2.5 错误恢复（重点，对应"已知问题"）

#### S5.1 工具参数错误
- **层**：L2
- **输入**：让模型读一个不存在的路径（借 S1.1 的变体：`读 /nonexistent/xxx`）
- **预期**：
  - tool:result `ok: false`
  - 模型不重复同一错误调用超过 2 次（**对应 errorHistory MAX_SAME_ERROR=2**）
  - 最终给用户一句"文件不存在"

#### S5.2 500 错误后 retry（对应已知问题 #3）
- **层**：L2（必须，用 local reverse proxy 注入 500）
- **输入**：任意会调工具的问题；proxy 配置：第 2 次请求返回 500
- **预期**：
  - `withRetry` 触发，最终成功完成
  - 如果 retry 3 次仍 500，触发 truncate-and-retry 分支（messages.length > 4 时）
  - 不向用户抛 unhandled rejection

#### S5.3 空回答（对应已知问题 #2）
- **层**：L2（必须）
- **输入**：任意调工具的问题
- **预期**：
  - 如果某一轮 `contentBuf.trim() === ''` 且有 tool_calls 历史 → 下一轮注入 `Please provide your answer based on the tool results above.`
  - 最终 finalText 非空
- **断言**：检查 messages 里出现过那条 nudge user 消息

#### S5.4 thinking token 过滤（对应已知问题 #4）
- **层**：L1 + L2
- **输入**：用会触发 thinking 的 prompt（Qwen3 开思考模式）
- **预期**：
  - event 流里有 `thinking:start` 和 `thinking:end`
  - 最终 finalText **不**含 `<think>`、`</think>`、`<|channel>thought`、`<channel|>`
  - `reasoning_content` 字段出现后切到 content 时触发 thinking:end

#### S5.5 重复错误 tool call 阻断（对应已知问题 #5）
- **层**：L2
- **预期**：构造一个"每次调用都返回 isError: true 且内容相同"的 fault MCP，模型连续调 3 次同参数 → 第 3 次被阻断 → tool:result 内容含"已尝试 X 次均失败"

---

### 2.6 上下文保持（对应已知问题 #1 #6）

#### S6.1 foldMessages 后不丢用户问题（必须）
- **层**：L2
- **步骤**：
  1. 问 A：`这个项目用了什么框架`（等完成）
  2. 问 B：`刚才那个框架有什么优势`
- **预期**：第二轮 request 里能看到 foldSummary 中含问题 A 的原文前 100 字（`[conversation] User asked: "这个项目..."`）
- **断言**：用 `getMessages()` 取内部 messages 数组，找 `role: 'system'` 中 `content` 含 `[conversation] User asked`，且后半段 summary 非空

#### S6.2 多轮对话连续（3 轮不丢线）
- **层**：L2 + L3
- **步骤**：见 test/cases/README.md Case 1（3 轮）
- **预期**：第 3 轮能引用第 1 轮的事实

---

### 2.7 Session

#### S7.1 resume
- **层**：L2 + L3
- **步骤**：
  1. 跑一轮对话，记下 sessionId
  2. 新起 agent，`options.sessionStore + sessionId` resume
  3. 问一个"基于上轮"的问题
- **预期**：新 agent 的 messages 数组在 system 后紧跟着 resume 进来的历史；回答能引用上一轮事实

#### S7.2 CLI sessions 列表
- **层**：L3
- **步骤**：`ma sessions`
- **预期**：stdout 含至少 1 条 session 记录

---

### 2.8 安全

#### S8.1 rm -rf 拦截
- **层**：L2（非 TTY 时自动 deny）+ L3（TTY 时弹确认）
- **输入**：`rm -rf /` 或 `dd if=/dev/zero`
- **预期**：
  - L2（非 TTY）：tool:result `[blocked] <reason>`，skipExecute = true，文件系统无变化
  - L3：出现确认提示，用户按 `n` → `[user denied]`

#### S8.2 白名单放行
- **层**：L2
- **输入**：配 `config.danger.allow = ['rm -rf /tmp/e2e-*']`，跑 `rm -rf /tmp/e2e-foo`
- **预期**：不拦截，正常执行

---

## 3. 测试文件结构

```
test/
  e2e/
    api/                      # L1
      tool-use-single.test.ts       # S1.1 的 L1 版（裸 fetch）
      tool-use-multiround.test.ts   # S1.2 的 L1 版
      thinking-filter.test.ts       # S5.4 的 L1 版
      fold-messages-equivalence.test.ts  # S6.1 的 L1 版（验证折叠后的 prompt 模型还能答）
      error-payloads.test.ts        # 500/非 JSON/字段缺失
      README.md                     # 本层说明 + 如何加 case

    agent/                    # L2
      project-analysis.test.ts      # S1.1–1.3
      file-ops.test.ts              # S2.1–2.3
      exec.test.ts                  # S3.1–3.3
      search.test.ts                # S4.1–4.2
      error-recovery.test.ts        # S5.1–5.5（重点）
      context.test.ts               # S6.1–6.2
      session.test.ts               # S7.1
      safety.test.ts                # S8.1–8.2
      README.md

    cli/                      # L3
      smoke.test.ts                 # 启动、/quit、/tools、/stack
      simple-chat.test.ts           # S1.1
      multi-round.test.ts           # S6.2
      session-resume.test.ts        # S7.1 CLI 版
      danger-confirm.test.ts        # S8.1 TTY 版
      no-html-leak.test.ts          # 横切
      no-maxlisteners.test.ts       # 横切
      README.md

    fixtures/
      simple-node-project/          # package.json + README + src/index.js（2处 useState）
      empty-project/                # 只有 .gitkeep
      big-project/                  # 模拟 Supercell 体量，测 foldMessages 压力
      README.md                     # 每个 fixture 的用途

      mcp-fault/                    # 可控失败的真实 MCP server
        package.json
        server.ts                   # 按 env 变量返回不同错误
        README.md

    helpers/
      pty.ts                        # spawnMa / sendLine / waitFor / stripAnsi（抽离自 e2e-real.ts）
      agent-runner.ts               # runAgent() — 收集 event 流、返回结构化结果
      fetch-llm.ts                  # L1 的裸 fetch 封装
      proxy-500.ts                  # local reverse proxy，注入 500
      fixtures.ts                   # 临时 cwd 管理、cleanup
      assertions.ts                 # hasLlmError / countDone / assertToolCalled / assertChineseMin
      retry.ts                      # withRetry + quorum 封装（§4）
      api-log.ts                    # 读 ~/.my-agent/api-debug.log 的断言 helper

    reports/                        # 运行产物（gitignore）
      <run-id>/
        summary.json                # §5 汇总
        <scenario>/
          events.jsonl
          messages.json
          pty.log                   # L3 的完整 stdout
          verdict.json
```

保留 `test/e2e-real.ts` 和 `test/e2e-model.sh` 作为过渡，逐步迁入 `test/e2e/cli/` 和 `test/e2e/api/`，最终删除。

---

## 4. 稳定性策略

Qwen3 本身有 30–40% 随机失败（tool 不调、答空、thinking 泄露等），这是 L3 flakiness 的根源。我们不改模型（那是另一个项目），只在测试框架层面做三件事：**retry with quorum + flaky 预算 + 分类归因**。

### 4.1 Quorum 策略（核心）

**不是"失败就重跑一次"，而是"跑 N 次取多数"。**

- **L1**：单次必过（1/1）。L1 挂 = 模型或请求真坏了，重跑没意义。
- **L2**：`quorum 2/3`。同一 scenario 最多跑 3 次，至少 2 次通过即整体 PASS。3 次跑完都记录，用于算 flaky 率。
- **L3**：`quorum 2/3`（默认）或 `best-of 1/2`（标记为 unstable 的）。

Quorum 的 N 由 `E2E_QUORUM_N`/`E2E_QUORUM_K` 控制，默认 `3/2`。`K=1` 退化成 best-of-N。

### 4.2 Flaky 预算

每个 scenario 有三种状态：
- `stable`：连续 10 个 CI run 内 pass 率 ≥ 95% — 走默认 quorum，任一 run 失败立即 PR 红
- `unstable`：pass 率 60–95% — 走 quorum 但报告高亮，release 不阻塞但必须列出
- `flaky-quarantined`：pass 率 < 60% — **暂时移出 CI 门禁**，进单独 `test:e2e:flaky` job；每周必须有人看，连续 2 周不动就删或重写

状态机自动根据最近 10 次结果调整，不是人工打标。`test/e2e/.flaky-state.json` 做持久化（commit 进仓库，每次 CI 跑完更新）。

### 4.3 重试不是万能药 — 明确不 retry 的情况

- **契约失败不 retry**（L1 的 schema 错、L2 的 danger guard 没拦住）— 这些是代码 bug，retry 只会掩盖
- **同一轮对话内不 retry**（只在 scenario 粒度 retry）— 避免在一个 flaky case 里无限循环
- **异常类 retry**：timeout / network 错 / `ECONNRESET` 不算 scenario 失败，算"基础设施失败"直接 abort 整个 run，不计入 quorum

### 4.4 超时建议

基于"Qwen3 单次 tool_call round ~3–15s"：

| 场景类型 | L2 超时 | L3 超时 |
|----------|---------|---------|
| 单轮简单（S3.1, S2.1） | 60s | 180s |
| 单轮多工具（S1.1） | 120s | 240s |
| 多轮追问（S1.2, S6.2） | 180s | 360s |
| 深度分析/多 task（S1.3） | 300s | 600s |
| 500 retry（S5.2） | 180s | — |

PTY 启动等 ready：沿用 `e2e-real.ts` 的"先等 session 出现再 sleep 12s"。**如果连这个 12s 都不够说明 ink 启动异常，不要加大。**

### 4.5 并行度

- L1：串行（都打同一个 LM Studio，并发互相拖慢）
- L2：串行（同上，model 是瓶颈）
- L3：**强制串行**（每个 test 占 1 个 PTY + 1 个完整 ma 进程 + 5 个 MCP 子进程 = 容易撞 ulimit）

如果以后切到云模型（有并发配额），L1 可以 5 并行，L2 3 并行。目前不做。

### 4.6 抗 flaky 的 prompt 工程（写 case 时注意）

1. **问得越具体越稳**：`读 package.json 告诉我 name 字段` > `介绍下这个项目`
2. **fixture 越小越稳**：测单文件行为就用 2 文件 fixture，不要扔整个 supercell 进去
3. **断言要有一个"软一个硬"**：硬断言判 pass（调了工具），软断言打分（回答质量），软断言挂不影响 pass 但影响报告分数

---

## 5. 报告格式

### 5.1 单 scenario 报告（`reports/<run-id>/<scenario>/verdict.json`）

```json
{
  "scenario": "S1.1",
  "layer": "L2",
  "runs": [
    {"attempt": 1, "verdict": "pass", "durationMs": 18200, "hard": true, "softScore": 0.83},
    {"attempt": 2, "verdict": "fail", "durationMs": 24100, "reason": "toolCalls.length === 0"},
    {"attempt": 3, "verdict": "pass", "durationMs": 19800, "hard": true, "softScore": 0.71}
  ],
  "quorum": {"n": 3, "k": 2, "passed": 2},
  "finalVerdict": "pass",
  "flakyRate": 0.33,
  "artifacts": {
    "events": "events.jsonl",
    "messages": "messages.json"
  }
}
```

每个 scenario 独立一个目录，artifacts 里存原始事件流、messages 数组、PTY 原始 stdout（L3），便于失败时 `diff` 两次 run 找差异。

### 5.2 汇总报告（`reports/<run-id>/summary.json` + `summary.md`）

```json
{
  "runId": "2026-04-27T10:00:00Z-abc123",
  "model": "qwen/qwen3.6-35b-a3b",
  "baseURL": "http://192.168.21.5:1234/v1",
  "totals": {
    "layers": {
      "L1": {"total": 5, "pass": 5, "fail": 0, "duration": 89000},
      "L2": {"total": 18, "pass": 17, "fail": 1, "duration": 412000},
      "L3": {"total": 8, "pass": 7, "fail": 0, "quarantined": 1, "duration": 1120000}
    },
    "passRate": 0.968,
    "flakyRate": 0.12
  },
  "failed": [
    {"scenario": "S5.3", "layer": "L2", "reason": "空回答未被 nudge", "lastPass": "2026-04-21"}
  ],
  "unstable": ["S4.2"],
  "quarantined": ["S1.3-L3"],
  "regressions": [
    {"scenario": "S6.1", "was": "stable", "now": "unstable", "trigger": "commit abc123"}
  ]
}
```

`summary.md` 给人看，是 `summary.json` 的渲染版，顶部一张表 + 失败详情（带 artifact 链接）+ 最近 7 天趋势图（pass 率折线、flaky 率柱状图）。

### 5.3 CI 产物

- PR CI：只跑 L1 + L2。PR 评论自动贴 `summary.md` 头部 + failed 列表。
- 每日 CI：全跑。发通知：pass 率 drop ≥ 5% 或新增 regression 时，在团队频道 ping。
- release 前：手动 `npm run e2e:full`，要求 L1/L2 100%、L3 ≥ 95%、无 regression。

### 5.4 软断言打分（scenario 级质量分）

0–1 分，不影响 pass/fail，用于趋势分析。每个 scenario 自定义：

- S1.1: `chinese_chars / 50` clamp 到 1（30 字起）
- S6.1: `(fold_summary_has_user_q ? 0.5 : 0) + (answer_references_q ? 0.5 : 0)`
- 等等

一旦某 scenario 软分趋势向下（7 日均值 drop ≥ 0.1），报告里高亮 — 这通常是 prompt 或 agent 改动带来的"质量悄悄变差但没 fail"。

---

## 6. 落地顺序（建议给 leader）

分 3 个 PR，逐步铺开，每一步都能独立 merge：

1. **PR-1：骨架 + L2 error-recovery**
   - 建 `test/e2e/` 目录结构
   - 抽 helpers（agent-runner / fixtures / assertions / retry quorum）
   - 写 S5.1 / S5.3 / S5.4 / S5.5（4 个必过的 L2 错误恢复）
   - CI 接入：PR 必跑 L2
   - **交付点**：6 个已知问题中 4 个有自动化守护

2. **PR-2：L1 + L2 主要场景**
   - 迁 e2e-model.sh → L1 tests（5 个 case）
   - 补齐 S1.1 / S1.2 / S2.* / S3.* / S6.* 的 L2 版
   - 加 fault MCP + proxy-500
   - flaky 状态机上线
   - **交付点**：L1+L2 覆盖 §2 的 90%，pass 率可量化

3. **PR-3：L3 重写 + 报告**
   - 把 e2e-real.ts 拆进 `test/e2e/cli/`
   - 加 session-resume、danger-confirm、横切检查
   - 报告生成器 + summary.md + PR 评论机器人
   - **交付点**：每日 CI 可看、release gate 可用

---

## 7. 红线（必守）

- **不 mock model**（符合"不 mock 测试"红线；用真模型 + quorum 抗 flaky）
- **不 mock MCP**（用真子进程 + fault MCP 注入可控故障）
- **不用 `expect` 脚本驱动 L3**（现有 e2e.sh 不稳，全 node-pty 重写）
- **每个 test 独立 cwd**（tmpdir + cleanup，禁止共用 fixture 目录导致污染）
- **PTY write 文本和回车必须分两次**（mnemo: 923）
- **500 retry 的 local proxy 是真 HTTP 进程**，不是 jest.mock
- **soft assertion 不影响 pass**，只进报告

---

## 附录 A：已知问题 → 测试场景映射

| 已知问题 | 覆盖场景 | 层 |
|----------|----------|-----|
| 1. foldMessages 丢用户上下文 | S6.1 | L1 + L2 |
| 2. 模型调完工具不回答 | S5.3 | L2 |
| 3. 500 错误后 retry | S5.2 | L2（+ L1 触发 payload 变体）|
| 4. thinking token 过滤 | S5.4 | L1 + L2 |
| 5. 重复错误 tool call 阻断 | S5.5 | L2 |
| 6. 连续对话上下文保持 | S6.2 | L2 + L3 |

每个场景 L2 都要有，保证单测级别可快速复现；L1/L3 按需加。

## 附录 B：与现有代码的映射

- 现有 `test/e2e-real.ts` → 迁到 `test/e2e/cli/simple-chat.test.ts` 和 `multi-round.test.ts`，helper 抽到 `test/e2e/helpers/pty.ts`
- 现有 `test/e2e-model.sh` → 迁到 `test/e2e/api/tool-use-*.test.ts`（改 Node + fetch 版本，bash 版作为冒烟保留一份）
- 现有 `test/e2e.sh`（expect 版）→ 废弃，能力并入 L3
- 现有 `test/cases/README.md` → 不动，作为 scenario 的业务需求源文档；`test/e2e/README.md` 里反链它

# L3+ Universal Agent Benchmark — Design (Designer A)

> 2026-04-29 · designer-a · 对应团队任务：L3 通用 benchmark 架构
>
> 前提：M1（L0-L2）已跑到 L0=100 / L1=99 / L2=95，硬断言框架验证可用。L3+ 转向**通用 CLI agent 接入 + 第三方裁判打分**，不再绑定 MA 的 `bootstrap()` 内部 API。
>
> 一句话：**通用 CLI agent 跑在隔离 workspace 里做开放性小开发任务 → 运行指标自动采集 + Claude 三方裁判沿多维评分 → 五维 0-1 分 + 加权综合分 + 参考答案差距，题量 20 道。**

---

## 0. 先说清楚根本诉求

用户要的不是"把 L3 题目堆出来"，是**一个通用评测框架**，目标有三个：

1. **通用**：任何 CLI agent（MA、Claude Code、Codex、AutoGPT、Aider…）都能跑 —— 接入点是 CLI 调用约定，不是内部函数。
2. **及格线测试**：L3 = 能独立完成一个真实的小开发任务（改 bug / 加字段 / 小重构），覆盖多轮推理、跨文件、工具组合。通过 L3 ≈ "这个 agent 能给人干活了"。
3. **裁判可信**：开放性任务没有硬断言兜底，必须靠第三方 agent（Claude）多维打分，且打分要稳、不偏见、可复核。

所以全篇都围绕三件事：**（A）被测接口标准、（B）任务形式、（C）裁判怎么打分**。其他都是支撑。

---

## 1. 被测 Agent 接入标准（核心，决定"通用"）

### 1.1 协议选型：三种方案对比

| 方案 | 举例 | 优点 | 缺点 | 评价 |
|---|---|---|---|---|
| **A. 单次 prompt 模式** | `agent --prompt "修这个 bug" --workdir /tmp/x` | 最简单、所有 agent 都能套 | 只能单轮，多轮交互不支持 | L3 够用，多数小任务一轮就能跑完 |
| **B. stream-json 双向协议** | Claude Code `--input-format stream-json` | 可多轮、可观察 thinking/tool_use | 只有头部 CLI 支持（见 mnemo#277） | 留给 L4/L5 |
| **C. ACP / MCP client** | ACP 官方 39 agent | 统一协议、事件流标准化 | 社区刚起步、很多 agent 没接 | 一年内不现实 |

**L3 选 A**（headless + single-prompt）。理由：

- SWE-bench 的做法就是这个 —— 给 repo + issue，agent 一次跑完输出 patch。
- `claude -p "task"` / `codex exec` / `aider --message "task" --yes` / `gemini --prompt` **全都天然支持**，不用改造。
- MA 自己也能包一个 `ma-cli --prompt X --workdir Y` 壳。

**L4/L5 再考虑**升级到 stream-json（保留扩展口），但 L3 设计不依赖它。

### 1.2 Adapter 接口规范

每个被测 agent 写一个 adapter 文件（YAML），runner 按它调起进程：

```yaml
# test/benchmark/adapters/claude-code.yaml
name: claude-code
version: 1.2.0
command: claude
args:
  - "-p"
  - "${PROMPT}"
  - "--permission-mode=acceptEdits"
  - "--output-format=stream-json"   # optional，用于事件采集
env:
  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
workdir: ${WORKSPACE}                # runner 注入隔离目录
timeout_sec: 900
events:
  stdout_format: stream-json          # none | stream-json | jsonl | text
  tool_call_pattern: 'type":"tool_use"'  # 正则/JSON path，用于计数
termination:
  exit_code: 0                        # 0 = 正常结束
```

```yaml
# test/benchmark/adapters/ma-agent.yaml
name: ma-agent
version: 0.3.1
command: node
args: ["dist/cli.js", "run", "--prompt", "${PROMPT}", "--workdir", "${WORKSPACE}"]
workdir: ${WORKSPACE}
timeout_sec: 900
events:
  stdout_format: jsonl
  tool_call_pattern: '"type":"tool:call"'
```

```yaml
# test/benchmark/adapters/aider.yaml   — 最简情况，无事件流
name: aider
command: aider
args: ["--message", "${PROMPT}", "--yes", "--no-check-update"]
workdir: ${WORKSPACE}
timeout_sec: 900
events:
  stdout_format: text                  # 没法结构化采集
```

### 1.3 Runner 驱动流程（单任务单 run）

```
1. 准备 workspace = copy(fixture) 到 /tmp/bench-<runid>/<taskid>/
2. 渲染 prompt（从 task YAML 的 user_input，可含 {{fixture_path}} 占位）
3. spawn adapter.command(args, env, cwd=workspace)
   ├── 管道 capture stdout/stderr 到 runs/<runid>/<taskid>.stdout.log
   ├── 计时 start_ts → end_ts
   └── 若 stream-json，边读边解析事件计数（tool_calls, turns, tokens）
4. wait(timeout_sec)
   ├── 正常退出 → 记录 exit_code
   ├── 超时 → SIGTERM + 5s → SIGKILL，标记 timed_out=true
5. 收集 artifact：
   ├── workspace_diff = git diff HEAD（fixture 预先 git init commit 过）
   ├── stdout_log / stderr_log
   ├── runtime = { duration_sec, tool_calls, turns, exit_code, tokens? }
6. 运行 post_check（若 task 有）：cd workspace && eval <post_check_cmd>
   └── 例如 `npm test` → 记录 exit_code（客观正确性信号）
7. 提交给 judge 打分（见 §3）
```

### 1.4 三个关键约定

- **workspace 隔离**：每道题每次 run 都是全新的 fixture 副本。跑完不清理（保留给裁判看），整个 run 结束后由 runner 统一清理。
- **`git init` 预处理**：fixture 进 workspace 后先 `git init && git add -A && git commit -m init`。runner 用 `git diff` 得到 agent 的改动，而不是扫文件树 —— 干净、能识别新增/删除/重命名。
- **判定"任务完成"不看 agent 自己说**：agent 可能自信地说"done"但啥也没改。完成信号只有两个来源：
  1. adapter 进程正常退出（`exit_code==0` 且非超时）—— 仅表示"agent 自认为跑完了"。
  2. **post_check 命令**（如 `npm test`）的退出码 —— 这是客观信号。
  agent 自报完成不计分，只看 workspace diff + post_check。

### 1.5 已知兼容性陷阱（提前避坑）

| 陷阱 | 触发 agent | 缓解 |
|---|---|---|
| 交互式 TUI 不肯读 stdin | Aider 默认、Goose | adapter 必须指定 `--yes` / `--no-input` / `--headless` 等非交互 flag |
| 要写 $HOME 配置 | Codex、Claude Code | 给每个 run 注入一次性 `HOME=$WORKSPACE/.home` 隔离 |
| 连网慢/rate-limit | 云端 agent | 失败重试 1 次；连续 2 次 timeout 判 invalid-run，不计分 |
| 不支持指定 workdir | Aider 老版本 | 用 `cd workspace && <cmd>` 包裹，不信任 agent 的 `--workdir` flag |
| 权限询问卡死 | Claude Code 默认 | 统一要求 adapter 写 `--permission-mode=acceptEdits` 或等价 flag |

---

## 2. L3 任务设计

### 2.1 及格线怎么界定（vs L2 / L4）

| Level | 典型任务 | 核心能力 | 任务 surface | 输出评判 |
|---|---|---|---|---|
| L2 | "把 README 版本改成 2.0.0" | 单文件读改写、多轮追问 | 明确告知文件和字符串 | **硬断言**：file_content contains X |
| **L3** | **"修复 `parseConfig` 对空字符串的崩溃"** | **跨 2-3 文件、读懂现有代码再改、跑测试验证** | **只给症状/需求，不指路径** | **裁判 + post_check 综合** |
| L4 | "给这个 CLI 加一个 `--verbose` flag" | 自主规划、跨文件重构、改测试 | 只给目标 | 裁判主导 |

**L3 及格的操作定义**：

> 把 fixture 副本给任何一个**合格初级工程师**（能看懂代码、会用 git），他在 15 分钟内、不问问题、不查文档就能完成的开发任务。
>
> 任务特征：
> - **目的明确但路径开放**：给症状或功能需求，不给具体文件和行号。
> - **规模小**：改动 < 50 行，涉及 1-3 个文件。
> - **有客观正确性信号**：修完能跑 `npm test` / `pytest` 通过，或有明确的 expected behavior 可触发验证。
> - **不需要查外部文档**：项目自足，不涉及第三方库冷门 API。

### 2.2 题量：20 道（v1）

参考 M1 设计（L3=20），和 SWE-bench Lite（300 题但覆盖面更广）。理由：

- **太少**（<15）：单题波动盖过整体信号，裁判偏差放大。
- **太多**（>30）：每题 5-run × 3-config（Raw/MA/Claude）× 900s timeout = 非常贵。20 道 × 5 run × 15min ≈ 25 小时 × 3 config = 75 小时一次完整跑分。20 已经在硬件预算边缘。
- **20 道足以覆盖 6 大类别**（见下），每类 3-4 题即可看出趋势。

### 2.3 任务分类与题目雏形

| 类别 | 题数 | 示例（题面 + fixture 要求） |
|---|---|---|
| **Bug fix 有测试** | 5 | 「`parseConfig('')` 抛 TypeError 而不是返回默认值。修复它」。fixture：带 1 个 failing test 的 node 项目。post_check = `npm test`。|
| **Bug fix 无测试** | 3 | 「README.md 里 install 命令报错 `module not found`。找出原因并修好」。fixture：装依赖缺项。post_check = 重放 README 命令。|
| **加小功能** | 4 | 「给 `formatTable` 加一个 `align` 参数（left/center/right），默认 left，向后兼容」。fixture：已有函数 + 已有调用点。post_check = 新写的 golden test 必须通过 + 旧测试不破。|
| **小重构** | 3 | 「把 `utils.js` 里的 3 个 callback 风格函数改成 async/await，调用点同步更新」。post_check = 全部既有测试仍然过。|
| **文档/配置** | 2 | 「把项目从 CommonJS 迁到 ESM（修 package.json type, 改 require→import, 改入口）」。post_check = `node index.js` 能跑。|
| **诊断定位** | 3 | 「用户报告 `/api/users` 返回 500，日志在 logs/。定位根因并修复」。fixture：埋了一个 typo bug + 真实日志。post_check = 新写的集成测试通过。|

**分布理由**：
- Bug fix 占 40%（8/20）— SWE-bench 最成熟的评测形态，裁判难度低。
- 加功能 20% — 需要 agent 理解意图做扩展。
- 重构 / 迁移 / 诊断 各 15% — 覆盖多文件和跨关注点。
- **不选**纯前端 UI 题（裁判评判成本高）、不选涉及数据库/网络服务的题（fixture 易飘）。

### 2.4 Fixture 规范

每道题一个目录：

```
test/benchmark/tasks/L3/L3-001-parseconfig-empty/
  task.yaml                 # 任务元数据（见 §2.5）
  fixture/                  # agent 看到的初始代码
    package.json
    src/parseConfig.js
    test/parseConfig.test.js
    README.md
  reference/                # 裁判看的参考答案（agent 看不到）
    solution.patch          # git 补丁，人类实现的"一种正确解法"
    rubric.md               # 评分要点（核心要求 + 加分项 + 扣分项）
    post_check.sh           # 正确性验证脚本
  prompts/
    user.md                 # agent 收到的任务描述（只讲症状/需求）
```

**Fixture 体积约束**：< 200 文件、< 1MB 依赖清单。装依赖（`npm install`）由 runner 在拷贝后执行一次，结果缓存到 `.bench-cache/node_modules-<hash>`。

**Fixture 来源**（避免凭空造题）：
1. 从真实开源项目的 commit 反演（找"一行 bug fix"或"小 feature"的 commit，回退到 fix 前作为 fixture）。
2. 从 MA 自己的早期 bug 里提取（dogfood）。
3. 避免直接用 SWE-bench 题目（怕 agent 训练数据污染）。

### 2.5 Task YAML 格式

```yaml
# test/benchmark/tasks/L3/L3-001-parseconfig-empty/task.yaml
id: L3-001
title: 修复 parseConfig 对空字符串输入的崩溃
level: L3
category: bugfix-with-tests
weight: 1.0

fixture:
  dir: ./fixture
  setup:                              # 拷贝后执行一次
    - npm install --no-audit --no-fund --prefer-offline

prompt:
  file: ./prompts/user.md             # agent 收到的完整任务描述

reference:
  solution_patch: ./reference/solution.patch
  rubric: ./reference/rubric.md
  human_time_min: 10                  # 人类参考耗时
  expected_tool_calls: 8              # 参考答案预期轮数
  expected_files_changed: [src/parseConfig.js, test/parseConfig.test.js]

post_check:
  cmd: bash ./reference/post_check.sh
  timeout_sec: 120
  # 输出约定：exit 0 = 全对；exit 1 = 功能对但测试未补；exit 2 = 功能错
  score_map: { 0: 1.0, 1: 0.5, 2: 0.0 }

judge:
  dimensions:                         # 本题强调哪些维度（影响权重，见 §3.3）
    correctness: 0.40
    completeness: 0.25
    efficiency: 0.10
    code_quality: 0.15
    no_regression: 0.10
  rubric_file: ./reference/rubric.md

runtime:
  timeout_sec: 900
  runs: 3                             # 开放性任务 3-run median（见 §4.2）
  layer: cli-adapter
```

---

## 3. 裁判系统

### 3.1 裁判定位与原则

裁判只做**开放性评分**，不做 pass/fail 判定。pass/fail 由 **post_check 客观信号** + **裁判给 correctness 打分 ≥ threshold** 联合决定。

**五条红线**：

1. **裁判模型固定**：Claude Sonnet 4.6 或 Opus 4.6（新版本）。永不用被测 agent 背后的模型打分。
2. **裁判不看被测 agent 名字**：所有提交去 agent 化。裁判拿到的是 `<Submission>`，不知道是谁写的，避免模型偏向自己。
3. **裁判 3 次投票取中位**：同一份提交跑 3 次裁判（temperature=0.1），每维度取中位。单次异常不污染分数。
4. **参考答案只作对比、不作正解**：裁判看 `solution.patch` 是"一种合格解"，不是唯一解。agent 走另一种正确路径不应扣分。rubric.md 必须说清"核心要求"与"可替代实现"。
5. **post_check 失败 → correctness ≤ 0.3 硬上限**：客观测试没过，裁判不能给高分。防止被 agent 的漂亮叙述忽悠。

### 3.2 裁判输入

每次裁判调用拿到完整上下文包：

```
<TaskDescription>         # 任务原文（prompt/user.md）
<Fixture>                 # 初始代码（选关键文件，不全贴）
<ReferenceRubric>         # rubric.md 全文
<ReferenceSolution>       # solution.patch（diff 格式，标注"参考解之一"）
<Submission>
  <WorkspaceDiff>         # git diff，agent 的改动
  <RuntimeLog>            # stdout/stderr 精简摘要（前 500 行 + 后 200 行）
  <PostCheckResult>       # exit_code + 最后 50 行输出
  <RuntimeStats>          # { duration_sec, tool_calls, turns, timed_out }
</Submission>
```

**不给裁判看的**：agent 名称/版本、被测模型、历史分数、其他 agent 的提交。

**fixture 全量 vs 摘要**：若 fixture > 20 文件，runner 预先算一份 "relevant files" 清单（基于 solution.patch 涉及的文件 + 它们的直接依赖），只贴这些文件给裁判。否则 prompt 会爆。

### 3.3 五维评分

| 维度 | 说明 | 0 分 | 0.5 分 | 1 分 | 默认权重 |
|---|---|---|---|---|---|
| **Correctness** | 需求是否满足（核心） | post_check 挂、bug 没修、功能没加 | 主要路径对，边缘 case 漏 | post_check 全过，rubric 核心要求全覆盖 | **0.35** |
| **Completeness** | 交付完整度（测试/文档/边界） | 只改了主代码，没加测试也没改旧测试 | 改了主代码和必要测试，但文档/注释漏 | 代码+测试+必要文档/注释都到位 | 0.20 |
| **Code Quality** | 代码质量（可读、风格一致、无 hack） | hack-y，和既有风格严重偏离 | 能工作但有小问题（命名、风格） | 和原风格无缝融入，无 code smell | 0.15 |
| **Efficiency** | 效率（轮数/时间/token） | > 3× reference | 1.5-3× | ≤ reference | 0.10 |
| **No Regression** | 是否破坏其他功能 | 既有测试被改坏或删掉 | 既有功能可能受影响但无硬证据 | 既有测试仍全过，无改动外延 | 0.20 |

**总分** = Σ(维度 × 权重)。权重可在 task.yaml 里覆盖（`judge.dimensions`）。

**L3 及格阈值**：总分 ≥ 0.65 且 Correctness ≥ 0.5 且 No Regression ≥ 0.5。两个维度设下限，防止靠其他维度刷分。

### 3.4 维度拆解的理由（回答用户原话）

用户提到"任务耗时、任务质量"，实际拆开：

- **质量** = Correctness + Completeness + Code Quality（功能对 + 交付完整 + 代码不烂，三件事）
- **耗时** = Efficiency（一个维度，含时间/轮数/token）
- **破坏** = No Regression（独立维度，避免被质量盖住）

**为什么不加"用户体验"维度**：L3 是小开发任务，没有"最终用户"。L4+ 引入 UI/CLI 体验题再加。

**为什么不加"token 成本"维度**：已经在 Efficiency 里。另外 AUS 报告会独立展示成本数据（见 §5）。

### 3.5 Judge Prompt 模板

```
你是资深 code reviewer，审查一份 agent 提交的代码修改。按五个维度各打 0/0.5/1。

### 任务
{{task_description}}

### 初始代码关键文件
{{fixture_relevant_files}}

### 评分 rubric
{{rubric_md}}

### 参考解法之一（仅供对比，不是唯一正解）
```diff
{{reference_solution_patch}}
```

### 被测提交
改动（git diff）:
```diff
{{workspace_diff}}
```

运行统计:
- 耗时: {{duration_sec}}s
- 工具调用次数: {{tool_calls}}
- 轮数: {{turns}}
- 是否超时: {{timed_out}}
- post_check 退出码: {{post_check_exit}}（0=全过，1=部分过，2=失败）
- post_check 末尾输出:
{{post_check_tail}}

### 你的任务
为每个维度打分 0 / 0.5 / 1，并给一句理由。

评分标准：
- Correctness: 需求是否满足？post_check 结果是首要信号。post_check 非 0 时此项不得超过 0.5。
- Completeness: 代码+测试+必要文档是否齐全？
- Code Quality: 是否融入既有风格？有无 hack？
- Efficiency: 耗时/轮数 vs 参考值（reference_rounds={{ref_rounds}}, human_min={{human_min}}）。≤参考=1，1.5-3倍=0.5，>3倍=0。超时=0。
- No Regression: 是否破坏其他功能？rubric 里列出的"不得改动"项被碰=0。

输出严格 JSON（不要包裹在 markdown 代码块里）：
{
  "correctness": 0|0.5|1,
  "completeness": 0|0.5|1,
  "code_quality": 0|0.5|1,
  "efficiency": 0|0.5|1,
  "no_regression": 0|0.5|1,
  "reasons": {
    "correctness": "一句话",
    "completeness": "一句话",
    "code_quality": "一句话",
    "efficiency": "一句话",
    "no_regression": "一句话"
  },
  "overall_note": "一句综合评价"
}
```

### 3.6 防偏见 / 防作弊

| 风险 | 防御 |
|---|---|
| 裁判偏向 Claude 生态（因为它本身是 Claude） | 3 次 median + fixture 去 agent 化 + 人类 10% 抽查 |
| agent 写漂亮 README 骗裁判 | Correctness 以 post_check 为锚，README 进 Completeness 不进 Correctness |
| agent 改测试让它过 | `No Regression` 明确惩罚改动 ref solution 未涉及的测试文件；rubric.md 列"不得改动的文件"白名单 |
| agent 调用奇怪外部服务作弊 | runner 限制网络（fixture 里禁用 `npm install`-之外的网络访问，用 `iptables` 或 proxy 拦截） |
| 长 prompt / 填充 token 刷长度 | Efficiency 把 token 也算进去 |
| 裁判自己幻觉 | 3-run median + 裁判必须引用 diff 行号作为理由（prompt 强制） |

### 3.7 要不要参考答案？

**要**，但定位是"参考之一"，不是"标准答案"。理由：

- **无参考答案的方案**：裁判得根据 rubric 全盘理解任务。实测（AlpacaEval 早期）裁判方差大、容易被修辞带偏。
- **强参考答案的方案**：裁判变成"diff 比对"，同功能不同实现会被误杀。
- **本方案**：参考解 + rubric 双轨。rubric 写"核心要求"（必须满足）+ "加分项"（非必需但推荐）+ "禁区"（不得改动），参考解演示一条路径。裁判被指示"参考解是一种合格解，不同实现只要满足 rubric 不扣分"。

### 3.8 要不要多裁判投票？

**v1 不做**，理由：

- 3-run 同模型 median 已经能消掉 80% 单次方差（tau-bench 的做法）。
- 跨模型投票（Claude + GPT-4 + Gemini）成本 ×3，但不同模型评分尺度不一致（Claude 严、GPT 宽），需要校准才能融合，工程量大。
- 留作 M2 优化：如果发现 Claude 裁判系统性偏袒某类 agent，再引入二裁判。

### 3.9 人类抽检

每次完整跑分随机抽 10%（2 道 × 每个 agent）给 team-lead 人工复查。发现系统性偏差（比如某类题裁判总给高/低）→ 改 rubric 或加样题 → 重跑。

---

## 4. 综合评分与 M1 的关系

### 4.1 评分管线（每道题）

```
agent 提交 →
  ├── runtime 采集 (duration, tool_calls, turns, exit_code, timed_out)
  ├── post_check 运行 (exit_code → score_map)
  ├── judge 3-run (5 dim scores × 3)
  └── per-dim median → weighted sum → task_score ∈ [0,1]

task_pass = (task_score ≥ 0.65) ∧ (correctness ≥ 0.5) ∧ (no_regression ≥ 0.5)
```

### 4.2 多 run 策略：3 vs 5

- L0-L2 硬断言题：M1 用 5-run median，因为 30B 模型方差大。
- **L3 开放性题：3-run median**。理由：每 run 需要 15min + 裁判 3 次 = 每题单次跑分接近 20min。5-run 太贵。3-run 的代价是 stability 信号弱一点，但 L3 看的是 median 水位，不看 stability。

### 4.3 Level 分数与 gate

沿用 M1 体系：

```
score(L3) = Σ(w_T × score(T)) / Σ(w_T)    for T ∈ L3
pass(L3) = (score(L3) ≥ 0.55) ∧ (task_pass_rate(L3) ≥ 0.70)
```

**cutoff 为什么选 0.55 / 0.70**：M1 设计表给 L3 是 score≥0.55 rate≥70%。保持一致，免得后续对比混乱。

### 4.4 和 M1（L0-L2）的兼容性

**硬断言体系保留**，不废弃：

| 组件 | M1 (L0-L2) | L3+ | 改动 |
|---|---|---|---|
| YAML task loader | 保留 | 扩展 | YAML 增加 `prompt.file` / `reference` / `post_check` / `judge` 块，旧字段兼容 |
| hard assertions | 保留 | 可选 | L3 题**也能**写硬断言（比如"修完后文件 X 必须存在"），作为 post_check 的补充 |
| soft assertions | 保留 | 不用 | L3 交给 judge dimension，不再写 soft |
| LLM-as-judge | 仅 soft.llm_judge | 升级为核心 | M1 的 `llm-judge.ts` 改造为多维裁判，M1 的单维 prompt 仍能跑 |
| runner | 直接调 MA bootstrap | 抽象 adapter | 引入 `cli-adapter` 层：L0-L2 用 `builtin-ma-adapter`（调 bootstrap），L3+ 用 `subprocess-adapter`（spawn CLI） |
| scorer | 硬断言为主 | 多维加权 | scorer 新增 judge score 入口；scoring 公式 §4.5 统一 |
| reporter | JSON+MD+ASCII | 增强 | 报告新增 per-dimension 分布和 judge reasons |

### 4.5 统一评分公式

```
# M1 (L0-L2) 硬断言主导
score_hard(T) = hard_pass × (0.6 + 0.4 × soft_score)

# L3+ 裁判主导，post_check 作锚
score_judge(T) = Σ(dim_weight × dim_median)
  where correctness capped by post_check:
    post_check_exit=0 → no cap
    post_check_exit=1 → correctness ≤ 0.5
    post_check_exit=2 → correctness ≤ 0.3

# 统一
score(T) = {
  L0-L2: score_hard(T)
  L3-L5: score_judge(T)
}
```

两种体系 **互不干扰**，都输出 0-1。Level 聚合、AUS 计算用同一个 `score(T)`。

### 4.6 目录结构增量

```
test/benchmark/
  tasks/
    L0/ L1/ L2/                       # 已有
    L3/<id>/                          # 新增，每题一个目录（fixture+reference+prompts）
  adapters/                           # 新增
    ma-agent.yaml
    claude-code.yaml
    codex.yaml
    aider.yaml
    _schema.ts                        # adapter YAML schema
  runner/
    adapter/                          # 新增
      base.ts                         # Adapter 接口
      builtin.ts                      # L0-L2 用，调 bootstrap
      subprocess.ts                   # L3+ 用，spawn CLI
    workspace.ts                      # 新增：fixture copy + git init + diff
    events.ts                         # 新增：stream-json/jsonl/text 事件解析
    post-check.ts                     # 新增
    assertions/                       # 已有，不动
    scorer.ts                         # 改：增加 judge score 分支
  judge/
    claude-judge.ts                   # 已有，改造为多维
    dimension-prompts.ts              # 新增：五维 prompt 模板
    submission-packager.ts            # 新增：拼 judge 上下文包
  baselines/
    raw-30b.json  ma-agent.json  claude-code.json  aider.json  codex.json
```

---

## 5. 多 agent 对比与报告

### 5.1 单 agent 单 run 报告

每 run 产出一份 `runs/<runid>/<agent>/L3-summary.json`：

```json
{
  "agent": "ma-agent@0.3.1",
  "level": "L3",
  "pass_rate": 0.65,
  "score": 0.61,
  "gate_ok": false,
  "by_dimension": {
    "correctness": 0.70, "completeness": 0.55, "code_quality": 0.60,
    "efficiency": 0.52, "no_regression": 0.75
  },
  "by_category": {
    "bugfix-with-tests": 0.80, "bugfix-no-tests": 0.50,
    "add-feature": 0.55, "refactor": 0.50,
    "docs-config": 0.65, "diagnose": 0.45
  },
  "per_task": {
    "L3-001": {
      "score": 0.85,
      "passed": true,
      "dimensions": {...},
      "runtime": {"duration_sec": 340, "tool_calls": 12, "turns": 7},
      "post_check": {"exit_code": 0, "tail": "..."},
      "judge_reasons": [...],           # 3 次的 overall_note
      "diff_size_loc": 28
    }
  },
  "weakest": [
    {"id": "L3-013", "dim": "correctness", "reason": "post_check exit=2: assertion failed in test/parse.test.js"}
  ]
}
```

### 5.2 多 agent 对比报告

一次完整跑分（多 agent 同 task 同 fixture 同 judge），输出对比表：

```
═══════════════════════════════════════════════════════════════════
  L3 Universal Benchmark — 2026-05-15
  Tasks: 20   Runs per task: 3 (median)   Judge: Claude Sonnet 4.6
═══════════════════════════════════════════════════════════════════

  Agent             Pass Rate   Score   Gate    Cost    Median Time
  claude-code@1.2    90%       0.82    ✓       $2.40    4m/task
  ma-agent@0.3.1     65%       0.61    ✗       $0.00    8m/task
  codex@1.0          70%       0.68    ✓       $1.80    5m/task
  aider@0.85         55%       0.52    ✗       $2.00    7m/task

  ─────── per-Dimension ───────
                    Corr   Comp   Qual   Eff    Regr
  claude-code       0.90   0.80   0.85   0.82   0.85
  ma-agent          0.70   0.55   0.60   0.52   0.75
  codex             0.75   0.70   0.75   0.68   0.80
  aider             0.60   0.55   0.60   0.50   0.55

  ─────── Category Breakdown ───────
                    bugfix-T  bugfix-N  feature  refactor  docs  diagnose
  claude-code        0.95      0.80      0.85     0.80      0.85   0.80
  ma-agent           0.80      0.50      0.55     0.50      0.65   0.45  ← 诊断类最弱
```

### 5.3 和 AUS 的关系

AUS 公式 M1 已定。L3 只是"L 指标"里的一项，通过 weight α_L3=0.25 进 benchmark total score。L3 对 AUS 的贡献 = `α_L3 × (ma_l3 - raw_l3) / (claude_l3 - raw_l3)`。

**Raw30B baseline 对 L3**：直接 HTTP 打 30B，不走 agent loop，不给 MCP tools。对开放性开发任务，Raw30B 预期 pass rate ≈ 0%（给不出有效 diff）。这是**设计如此** —— AUS 正是要量化"agent 层把 0 分拉到多高"。Raw30B 的 correctness 会接近 0，但 Completeness/Code Quality 能拿到 0.3-0.5（能写出看起来合理的代码文本）。AUS 的分母仍然 > 0，不除以零。

---

## 6. 成本与执行预算

### 6.1 单次完整 L3 跑分成本

| 项 | 数量 | 单价 | 小计 |
|---|---|---|---|
| 任务执行（MA 本地） | 20 × 3 run × 8min | 本地免费 | 0 |
| 任务执行（Claude Code） | 20 × 3 run × 4min | $0.12/min | $28.80 |
| 任务执行（Codex） | 20 × 3 run × 5min | $0.08/min | $24.00 |
| Judge 裁判调用 | 20 × 3 run × 3 judge × 4 agent | ~$0.05/call | $36.00 |
| Post_check 执行 | 20 × 3 run × 4 agent × 30s | 本地 | 0 |
| **合计** | | | **~$90** |
| **时长** | 20 × 3 run × 8min × 4 agent（并发 2）| | **~8 小时** |

一周跑一次，月成本 < $400。可接受。

### 6.2 CI 策略

- **PR 门禁**：只跑 L0-L2（M1 已有），~30min，不涉及 L3。
- **Release 门禁**：跑 L3（MA + Claude Code 对比，不跑 Codex/Aider 省成本），~4h。
- **周度全量**：所有 agent × 所有 level（L0-L3），手动触发或定时。
- **L4/L5**：M3 阶段再加，不在 L3 计划里。

---

## 7. 开发里程碑（L3 独立）

### M2-a (2 周)：adapter + workspace + 简单 judge
- `adapters/*.yaml` schema + `subprocess-adapter` 实现（至少支持 MA + Claude Code）
- `workspace.ts`：fixture copy + git init + diff
- `post-check.ts`
- judge 单维先跑通（只打 correctness 一维）
- **交付**：5 道 L3 题能跑通 MA + Claude Code，出单维分数

### M2-b (2 周)：全五维 judge + 完整题库
- 五维 prompt + 3-run median + 10% 人类抽检管线
- 剩余 15 道 L3 题完成（含 fixture + reference + rubric + post_check）
- 多 agent 对比报告
- **交付**：完整 L3 跑分报告，MA vs Claude Code 差距诊断

### M2-c (1 周)：稳定性与扩展
- adapter 增加 Codex/Aider 支持
- 裁判 prompt 调优（看人类抽检结果）
- M1 兼容性回归（L0-L2 仍能跑）
- **交付**：L0-L3 全体系稳定，可作为月度跑分的基线

---

## 8. 开放问题（留给 team-lead 定）

1. **Judge 模型**：Sonnet 4.6 还是 Opus 4.7？Opus 更准但成本 ×5。建议 v1 用 Sonnet，差异样题（人类抽检分歧 >0.3 的）升级 Opus 复判。
2. **Aider / Goose / Amp 等无事件流 CLI 要不要纳入首发**：它们的 Efficiency 维度只能靠 wall-clock + stdout 行数估算，不如 stream-json 准。建议 M2-a 只做 MA + Claude Code，M2-c 再扩。
3. **Fixture 污染**：SWE-bench / HumanEval 题可能被模型训练过。我们自造 20 道时，要不要引入 "freshness guard"（只选 2026 年后的 commit 反演，或自己写）？建议全部自造，不碰公开题库。
4. **Rubric 谁写**：20 道题每道要写 rubric，工作量不小。建议"designer-a/b 各出一半 + 交叉评审"，或用 Claude 起草人类终审。
5. **要不要支持"agent 主动询问"场景**：L3 单 prompt 模式下，agent 卡住不能问。这会惩罚"问对问题比硬猜更高效"的 agent。M2 暂不支持，M3 L5 再加多轮接口。

---

## 9. 关键决策一览

| # | 决策 | 理由 |
|---|---|---|
| 1 | 接入用 single-prompt CLI，不用 stream-json | 所有 agent 都支持，覆盖最广 |
| 2 | workspace 用 git diff 捕获改动 | 干净、识别新增/删除/重命名 |
| 3 | 完成信号用 exit_code + post_check，不看 agent 自报 | agent 会撒谎 |
| 4 | 题量 20 道 | 统计显著 + 预算可承受 |
| 5 | 3-run median（不是 5） | L3 每 run 20min，5 太贵 |
| 6 | 五维评分 + post_check cap correctness | 客观锚 + 主观维 结合 |
| 7 | 参考答案 + rubric 双轨，参考解仅对比 | 避免裁判变成 diff 比对 |
| 8 | 单裁判模型 3-run median，不跨模型投票 | 成本可控，方差已够低 |
| 9 | 硬断言体系保留，L3 只是新增 judge 分支 | M1 投入不浪费，口径一致 |
| 10 | AUS 公式不变，L3 作为 L 项通过 α_L3 进总分 | 不破坏现有指标体系 |

---

## Appendix A：Adapter schema（TypeScript）

```ts
type AdapterSpec = {
  name: string;
  version: string;
  command: string;
  args: string[];                     // 支持 ${PROMPT} ${WORKSPACE} 占位
  env?: Record<string, string>;
  workdir?: string;
  timeout_sec: number;
  events: {
    stdout_format: 'none' | 'stream-json' | 'jsonl' | 'text';
    tool_call_pattern?: string;       // 正则，用于从 stdout 计 tool_calls
    turn_pattern?: string;            // 正则，用于计 turns
  };
  termination?: {
    exit_code?: number;               // 期望的正常退出码
  };
};
```

## Appendix B：Post_check 退出码约定

| exit | 含义 | correctness cap |
|---|---|---|
| 0 | 全部通过 | 无 cap |
| 1 | 功能对，但测试/文档有缺 | ≤ 0.5 |
| 2 | 功能错（测试挂） | ≤ 0.3 |
| ≥ 3 | post_check 脚本自己崩了（不是 agent 的问题）| run invalid，不计分 |

## Appendix C：评分示例

题目 L3-001（修 parseConfig 空字符串），MA 提交：
- post_check exit=0 ✓
- diff: 3 文件改动，18 行
- tool_calls: 14，duration: 9 分钟（reference: 8 调用 / 10 分钟）
- 裁判 3 次结果（median）：correctness=1, completeness=0.5 （没加新测试只改了主代码）, code_quality=1, efficiency=0.5（轮数超），no_regression=1
- task_score = 1×0.35 + 0.5×0.20 + 1×0.15 + 0.5×0.10 + 1×0.20 = **0.85**
- pass ✓（≥0.65 且 corr≥0.5 且 regr≥0.5）

---

**交付完成，等 team-lead 审阅。**

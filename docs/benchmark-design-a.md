# MA Agent Benchmark 评分体系（方案 A）

> 调研员 A 出品。目标：给 my-agent（基于本地 30B 级模型 + MCP 工具集）一个**能精确告诉你"差在哪、差多少、怎么补"**的分级评分体系。不是考试，是尺子。
>
> 核心理念：**5 级能力阶梯 + 原子化题库 + 硬/软双轨评分 + Claude Code 同题基线**。稳定工具调用是 L1 门槛，Level 越高越考验"多步+状态+自恢复"。
>
> 参考但不照抄：SWE-bench（真实 repo + patch 验证）、HumanEval（pass@k）、GAIA（分 Level + 人类可解）、τ-bench（工具调用场景 + LLM-as-judge）、AgentBench（多环境横切）。

---

## 0. TL;DR

| Level | 名字 | 能力门槛 | 代表能力 | 通过门槛 | 对标人类 |
|-------|------|---------|---------|---------|---------|
| L0 | 不会用工具 | 连 tool_call 都触发不了 / 稳定吐 JSON 都做不到 | 闲聊、背书 | — | — |
| L1 | 稳定工具调用 | 单轮单工具，参数正确，结果不乱编 | 读文件、跑 node -v、列目录 | ≥ 90% 题通过 | 实习生第 1 周 |
| L2 | 稳定完成工作 | 多工具串联、多轮保持上下文、错了不重复错 | 改一个 README、加一行日志、找 bug 位置 | ≥ 80% 题通过 | 初级工程师 |
| L3 | 好用（及格线） | 带 plan、会 compact、会自恢复、能读长文件 | 实现一个小 feature、跑通测试、修简单 bug | ≥ 70% 题通过 | 能独立带任务的工程师 |
| L4 | 接近 Claude Code | 跨模块改动、推理架构、会说"我不确定"、能设计 | 重构一个模块、跨文件追踪、读懂陌生仓库 | ≥ 60% 题通过 | 资深工程师 |
| L5 | 追平 Claude Code | 含糊指令能澄清、长时任务不漂、错误日志能定位根因 | 端到端做一个 PR、review 别人代码、写 benchmark 本身 | ≥ 50% 题通过 | 高级/资深 Claude Code |

**综合分**：加权总分 0–100，每个 Level 是一段满分子区间。达到 L_n 的门槛即 `benchmark.score >= Level_n.cutoff`。

不是"过 L3 就拿 70 分"——是"L1+L2+L3 都通过到门槛才有资格算作 L3 等级"。**不能跳级**（Level 单调，L3 先决条件是 L2 通过）。

---

## 1. 分级体系设计

### 1.1 为什么是 5 级（+L0）

用户原话："循序渐进、分级、能达到哪个级别、多少分"。级别太少（比如 3 级）表达力不够、级别太多（比如 10 级）每级边界糊。**5 级是经验值**：

- 对标 SWE-bench 自己也是按 task 复杂度分 lite/full/bench+；GAIA 分 L1/L2/L3。
- L0 是"连门都没进"，不算有效 agent，用于调试模型本身。
- L1–L4 是线性进步，每级是前一级的超集 + 一个新能力维度。
- L5 是"追平天花板"——和 Claude Code 的分数做**差值**，不是绝对满分。

### 1.2 每级的**单一新能力**

这是 Level 设计的核心：**每升一级只加一个新能力维度**，保证评测能明确指出"差的就是这一步"。

| 升级 | 新加的能力维度 | 如果 fail，问题一定在这 |
|------|--------------|----------------------|
| L0→L1 | **稳定触发 tool_call + 参数合法** | 模型本身的工具能力、tool schema 提示、temperature 设置 |
| L1→L2 | **多轮上下文保持 + 错误不重复** | foldMessages、errorHistory、空回答 nudge |
| L2→L3 | **长上下文 / compact + plan 能力** | Token 估算、summarize 质量、task 栈 |
| L3→L4 | **跨文件推理 + 工具组合** | 模型的 reasoning 深度、AGENT.md 使用、file_edit 精度 |
| L4→L5 | **模糊指令澄清 + 长时不漂** | Agentic loop 设计、long-horizon 记忆、主动问反问 |

如果 L2 失败但 L1 通过 → 问题一定在"多轮/错误恢复"环节，不用翻工具调用代码。**这就是分级的价值**：定位，不是评优。

### 1.3 本地优势：无限 token

用户原话："本地优势是无限 token。agent 引导 LLM 做更正确的事"。

反映到 benchmark 里的具体设计：

- **L3 及以上题目故意喂长 fixture**（10K+ 行项目），压 compact 和 agent 的引导能力。
- **不限 token usage 上限**——Claude Code 一次任务可能消耗 50K token，本地模型可以消耗 500K（多轮、多次 compact）。benchmark 只看结果，不看 token 花了多少。
- 但**加一个"效率分（软）"**：同 Level 同题，token 用得少的分高。只做排序，不影响 pass/fail（不然本地会被不公平地惩罚）。

### 1.4 不设 L6+

L5 的定义是"追平 Claude Code"——这是一个动态的靶子，Claude Code 会升级，我们也会升级。定 L6 没有意义，不如把 L5 做成"和 Claude Code 差距百分比"。

---

## 2. 题库设计

### 2.1 题目原子格式（Task）

每道题是一个 **Task**，统一的 YAML fixture 格式（benchmark runner 读它生成测试）：

```yaml
# test/benchmark/tasks/L2-003-fix-readme.yaml
id: L2-003
title: 改 README 版本号
level: L2
category: file-edit
weight: 1.0                    # 同级内权重，默认 1.0

# 环境
fixture:
  project: simple-node-project  # 复用 e2e 已有 fixture
  setup:                         # 可选：前置脚本
    - echo "VERSION: 1.0.0" > README.md

# 输入
user_input: |
  把 README 里的版本号改成 2.0.0

# 期望
expected:
  hard_assertions:               # 全通过才 pass
    - type: tool_called
      tool: fs__read_file
      args_contains: { path: "README.md" }
    - type: tool_called
      tool_matches: "fs(-edit)?__(write|edit)_file"
    - type: file_content
      path: README.md
      contains: "VERSION: 2.0.0"
      not_contains: "VERSION: 1.0.0"
    - type: no_error_5xx
    - type: tool_retry_max
      max_same_error: 2

  soft_assertions:               # 打分用，不影响 pass
    - type: final_text_min_len
      chars: 20
      weight: 0.3
    - type: tool_call_count_max  # 越少越好
      max: 3
      weight: 0.3
    - type: llm_judge
      rubric: "回复是否简洁明确确认修改完成？"
      weight: 0.4

# 参考
reference:
  claude_code_score: 0.95        # Claude Code 跑这题的基线分（§5 建立）
  human_time_sec: 30             # 人类执行时间参考

# 运行
runtime:
  timeout_sec: 120
  retries: 3                     # quorum 2/3
  layer: L2                      # e2e 分层里的哪层（§4.3 规定）
```

### 2.2 Level 对应题库（共 100 道初版）

> 题量平衡：**L1 多、L5 少**。越底层题目越稠密（能稳定定位问题），越顶层题目越精挑（成本高、信号强）。

#### L1 — 稳定工具调用（30 题）

单轮单工具，只验"调对了 + 结果不瞎编"。

| 子类 | 题数 | 示例 |
|------|-----|------|
| **读文件** | 6 | `读 package.json 告诉我 name` / `读 README 前 5 行` |
| **写文件** | 4 | `创建 hello.txt 内容是 "hi"` |
| **列目录** | 4 | `看下 src/ 下有什么` |
| **跑命令** | 6 | `跑 node -v` / `跑 git branch --show-current` |
| **搜索** | 4 | `grep 项目里 useState` |
| **不该调工具** | 4 | `1+1 等于几` / `你好` / `介绍下你自己`（必须 tool_calls.length === 0）|
| **工具名容错** | 2 | `读 "package.json"`（带引号）/ `读 ./package.json`（带 ./）|

**L1 通过门槛**：≥ 90% 题通过（27/30）。稳定工具调用是**基线**，90% 是"实习生水平"。低于此碰不到及格线。

#### L2 — 稳定完成工作（30 题）

多轮、多工具、带错误恢复。

| 子类 | 题数 | 示例 |
|------|-----|------|
| **读-改-写** | 6 | 改 README 版本号 / 在文件末尾追加一行 / 替换配置值 |
| **多轮追问** | 6 | Q1:这项目是啥 → Q2:详细说说（不重复调工具）|
| **工具错后恢复** | 4 | 读不存在的路径 → 模型承认失败不重复试 |
| **命令失败处理** | 3 | 跑 `nonexistent-cmd` → 不胡编 |
| **多步任务** | 5 | 读 package.json，再跑 `npm test`，告诉我结果 |
| **context 不丢** | 4 | 3–4 轮对话后还能引用第 1 轮事实 |
| **空回答自救** | 2 | 触发 empty-content 场景，最终能给答 |

**L2 通过门槛**：≥ 80% 题通过。多工具串联是工程师的日常，80% 表示"能干活"。

#### L3 — 好用（及格线）（20 题）

进入 long-context / plan / compact 区域。

| 子类 | 题数 | 示例 |
|------|-----|------|
| **长 context 不丢** | 5 | 10 轮对话后，compact 触发一次，仍能答第 1 轮问题 |
| **任务拆解** | 4 | "分析项目架构"→ 触发 create_task / 3+ 次不同工具调用 |
| **文件精确编辑** | 3 | 用 file_edit 改 2 处非 unique 串（要求 replace_all）|
| **小 feature 实现** | 4 | 在现有函数加一个参数 / 加一个输出字段 |
| **跑通测试** | 2 | `跑测试并告诉我几个通过` → 不重跑 |
| **resume** | 2 | 跨 session 恢复后引用旧事实 |

**L3 通过门槛**：≥ 70% 题通过（14/20）。**这是及格线**——能稳定完成"好用"级别的小任务。用户所说"勉强及格"对应的是 L2 下限到 L3 下限之间。

#### L4 — 接近 Claude Code（15 题）

跨文件、跨模块、推理深度。

| 子类 | 题数 | 示例 |
|------|-----|------|
| **跨文件追踪** | 4 | `useState 在哪被调用，它们共享什么 state 吗`（需 grep + read + 推理）|
| **小型重构** | 3 | `把这个文件里的 console.log 换成 logger.info`（多处，精确）|
| **根因定位** | 3 | 给一个 bug 现象 + 日志 → 指出哪文件哪行；不用真 fix |
| **读懂陌生仓库** | 2 | 给一个中等 repo（fixture big-project）→ 画出依赖关系 |
| **多 MCP 组合** | 3 | grep → read → edit → exec（运行验证）连贯通过 |

**L4 通过门槛**：≥ 60% 题通过（9/15）。60% 是"在 Claude Code 的射程内，但还差一截"。

#### L5 — 追平 Claude Code（5 题）

**同题 + 同 fixture 上 Claude Code 也跑一次**，对比差距。

| 子类 | 题数 | 示例 |
|------|-----|------|
| **模糊指令澄清** | 1 | `帮我把代码变好点` → 必须问清楚要改什么 |
| **端到端 PR** | 1 | `给项目加一个 --verbose 标志` → 改代码 + 改文档 + 跑测试 |
| **读陌生大仓库** | 1 | 给 my-agent 自己 → 回答"agent.ts 的主循环怎么决定何时 compact" |
| **长时不漂** | 1 | 30+ 轮对话 + 3 次 compact，最后问第 1 轮的细节 |
| **错误日志定位根因** | 1 | 给一个真实的 500 trace → 指根因（对应 mnemo id:510 这种） |

**L5 通过门槛**：≥ 50% 题通过（3/5）+ 每题分 ≥ Claude Code 同题分 × 0.8。

### 2.3 题库分布图（100 题）

```
L1: ██████████████████████████████ 30 (30%)   工具调用基线
L2: ██████████████████████████████ 30 (30%)   干活基线
L3: ████████████████████           20 (20%)   及格线
L4: ███████████████                15 (15%)   追 Claude Code
L5: █████                           5 ( 5%)   天花板
```

### 2.4 题目维度覆盖（横切）

除了 Level 纵切，还要保证**横向维度覆盖**，不能所有题都集中在一个 MCP 上：

| 维度 | 覆盖题数 | 说明 |
|------|---------|------|
| **fs 工具** | ~35 | 读/写/编辑/列 |
| **exec 工具** | ~20 | 跑命令、git、npm |
| **grep 工具** | ~10 | 搜索 |
| **web 工具** | ~5 | 可 skip（外网不稳） |
| **纯对话（不调工具）** | ~10 | 验证"该不该调"的判断 |
| **多工具组合** | ~20 | L3+ 的主力 |

每个 Level 都应覆盖 3+ 个维度，避免单维崩溃导致全 Level 挂。

### 2.5 题目来源

- **e2e-test-plan.md §2 场景** → 改造成 benchmark 题（已经有 20+ 个现成的）
- **test/cases/README.md 20 个 case** → 每个拆成 2–3 道原子 benchmark 题
- **mnemo 已知问题** → id:510 的根因定位直接进 L5，能考"长时稳定"
- **SWE-bench / τ-bench 精选题** → L4/L5 借鉴，但 fixture 本地化
- **真实 bug 记录** → 从 my-agent 自己的 git log 挑 5–10 个修过的 bug 做 L4/L5

---

## 3. 评分算法

### 3.1 单题分（Task Score）

$$
\text{score}(T) = \text{hard\_pass}(T) \times \big( w_h + w_s \cdot \text{soft\_score}(T) \big)
$$

- `hard_pass(T)` ∈ {0, 1}：所有 hard_assertions 通过才 1；不通过直接 0 分。
- `soft_score(T)` ∈ [0, 1]：soft_assertions 加权平均。
- `w_h = 0.6, w_s = 0.4`：硬约束占 60%（有基础分），软质量占 40%。

**意思**：过了硬断言，起步 0.6 分；软分加成最多到 1.0。没过硬断言，0 分，不给"辛苦分"。

#### Quorum 策略

每道题跑 3 次取 **2/3 pass**（见 e2e-test-plan §4.1）。单次的 `score(T)` 是 3 次的**中位数**（不是平均，避免 outlier 拉高）。如果 3 次中 2 次 hard_pass=1，则最终 hard_pass=1。

### 3.2 Level 分（Level Score）

$$
\text{score}(L) = \frac{\sum_{T \in L} w_T \cdot \text{score}(T)}{\sum_{T \in L} w_T}
$$

- 每题 `w_T` 默认 1.0，某些关键题（比如 L1 的"tool_call 触发"）权重可上调到 2.0。

#### Level 通过判定

$$
\text{pass}(L) = \left( \text{score}(L) \geq \text{cutoff}_L \right) \land \left( \text{hard\_pass\_rate}(L) \geq \text{rate}_L \right)
$$

两个门槛都要过：**分数门槛** + **通过率门槛**。

| Level | `cutoff` | `rate` |
|-------|---------|--------|
| L1 | 0.75 | 0.90 |
| L2 | 0.65 | 0.80 |
| L3 | 0.55 | 0.70 |
| L4 | 0.45 | 0.60 |
| L5 | 0.40 | 0.50 |

**为什么两个门槛**：只看 pass rate 会让"勉强过的题"拉高分数；只看 score 会让 soft 分掩盖 hard fail。双门槛更严。

### 3.3 综合分（Benchmark Score）

$$
\text{Benchmark Score} = \sum_{L=1}^{5} \alpha_L \cdot \text{score}(L)
$$

加权：

| Level | `α_L` | 满分贡献 | 累计 |
|-------|------|---------|------|
| L1 | 15 | 15 | 15 |
| L2 | 20 | 20 | 35 |
| L3 | 25 | 25 | 60 |
| L4 | 25 | 25 | 85 |
| L5 | 15 | 15 | 100 |

**总分 0–100**。Level 中心：L1=15, L2=35, L3=60, L4=85, L5=100。中间分数表示"在两级之间"。

#### 最终等级判定

```
final_level = max { L : pass(L1) ∧ pass(L2) ∧ ... ∧ pass(L) }
```

不能跳级。如果 L2 没过但 L4 的题跑通了几道——那也只是 "L1+L4 题分"，不能声称"达到 L4"。因为 L2 的稳定性本身是更高级能力的基础，跳级等于地基没打好。

### 3.4 维度分（Dimension Score，附加）

除了 Level，给 6 个能力维度单独打分（0–100），用于**定位"差在哪"**：

| 维度 | 影响 | 计算 |
|------|------|------|
| **Tool Stability** | 工具调用正确率 | hard_pass 里 tool_called 类断言的通过率 |
| **Context Retention** | 长对话不丢 | 所有"多轮引用上文"题的 hard_pass 率 |
| **Error Recovery** | 错了能自救 | 所有 error_recovery 题的 hard_pass 率 |
| **Planning** | 复杂任务拆解 | 所有含 `create_task` 或多步任务的 hard_pass 率 |
| **Code Quality** | 代码修改精度 | file_edit / write_file 类题的 soft_score 均值 |
| **Efficiency** | 步数 + token | 所有题的 `tool_call_count` / `token_usage` 归一化 |

输出示例：

```
Tool Stability:    92% ████████████████████░
Context Retention: 71% ██████████████░░░░░░░
Error Recovery:    58% ████████████░░░░░░░░░
Planning:          45% █████████░░░░░░░░░░░░
Code Quality:      80% ████████████████░░░░░
Efficiency:        67% █████████████░░░░░░░░
```

一眼看出"planning 最弱"，下一步就知道改 agent.ts 里 create_task 逻辑。这是分级体系的**核心副产品**。

---

## 4. 测试手段（自动化评分）

### 4.1 断言类型清单

#### Hard Assertions（二值 pass/fail）

| 类型 | 实现 | 备注 |
|------|------|------|
| `tool_called` | 扫 agent event 流中 `tool:call` 事件 | 可配 args_contains、args_matches 正则 |
| `tool_not_called` | 同上，检查没有 | 用于"不该调工具"题 |
| `tool_retry_max` | 统计 errorHistory 里同命令重复次数 | 默认 max=2 |
| `file_content` | 读磁盘 diff | contains / not_contains / regex / exact |
| `file_exists` | fs.existsSync | 创建题必用 |
| `no_error_5xx` | 扫 event 流无 `error` 类型 5xx | 基础断言 |
| `final_text_contains` | 扫最后一条 assistant 消息 | 支持正则、关键词列表（OR / AND）|
| `final_text_min_chars` | 字数下限 | 中文字数按 `[一-鿿]` 匹配 |
| `final_text_no_html` | 无 `<...>` 泄露 | 沿用 e2e 现有规则 |
| `messages_count_max` | messages 数组长度上限 | 防死循环 |
| `event_sequence` | 事件顺序断言 | 比如 `tool:call → tool:result → task:done` |

#### Soft Assertions（0–1 分）

| 类型 | 实现 | 备注 |
|------|------|------|
| `final_text_min_len` | 字数对应 weight | 超过目标字数给满分 |
| `tool_call_count_max` | 调用次数越少越好 | `min(1, max/actual)` |
| `token_usage_max` | token 越少越好 | 同上 |
| `duration_max` | 耗时越短越好 | 同上 |
| `llm_judge` | 调判官模型打分 | §4.2 |
| `reference_match_ratio` | 和参考答案的 embedding 余弦相似度 | 0–1 |

### 4.2 LLM-as-judge（判官模型）

**用谁判**：**不能用被测模型自己**。选三选一：

1. **Claude Sonnet 4** 做判官（推荐，准、快、便宜）。
2. **另一个本地模型**（如 DeepSeek V3）做判官——纯本地闭环。
3. **本地 + 云双判官投票**：本地给 score，云给 score，差异 > 0.3 则人工 review。

**判官 prompt 模板**（每道题都有一个 rubric）：

```
你是一个代码 agent 的评分员。评分范围 0.0–1.0，精确到 0.1。

用户问题：{user_input}
Agent 最终回答：{final_text}
参考答案（如有）：{reference_answer}
评分维度：{rubric}

只输出一个 JSON：{"score": 0.0-1.0, "reason": "简短说明"}
```

**判官的 known bug**：
- 倾向给"长答案"高分 → rubric 里强调"越简洁越高分"。
- 容易被谄媚语言骗 → 加一条"带有'当然可以'/'非常好'等虚词的扣 0.1"。
- 对代码细节判不准 → 代码类题目用 `file_content` 等**可验证**的 hard assertion 替代，**不用 llm_judge**。

**红线**：**llm_judge 不用于 hard assertion**（别让一个随机模型决定 pass/fail）。只做 soft 打分。

### 4.3 Benchmark runner 实现

基于 e2e-test-plan §3 的 `test/e2e/` 结构扩展：

```
test/benchmark/
  tasks/
    L1-001-read-file.yaml         # 每题一个 YAML
    L1-002-list-dir.yaml
    ...
    L5-005-long-horizon.yaml
  
  runner/
    index.ts                      # 入口：读 YAML → 跑 → 出报告
    task-loader.ts                # 解析 YAML + schema 校验
    assertions/
      hard.ts                     # 所有 hard 类型实现
      soft.ts                     # 所有 soft 类型实现
      llm-judge.ts                # 判官封装
    scorer.ts                     # score(T) / score(L) / Benchmark Score 计算
    reporter.ts                   # JSON + MD + 控制台图表
  
  fixtures/                       # 复用 test/e2e/fixtures/
  
  baselines/
    claude-code.json              # §5 Claude Code 跑一遍的结果
    local-qwen3-30b.json          # 本地模型的结果
    local-qwen3-30b-history.jsonl # 历次跑的趋势
  
  reports/
    <run-id>/
      summary.json
      summary.md
      per-task/<task-id>.json
```

运行入口：

```bash
# 跑全部
npm run benchmark

# 只跑 L2
npm run benchmark -- --level L2

# 单题
npm run benchmark -- --task L2-003

# 和 baseline 对比
npm run benchmark -- --compare baselines/claude-code.json
```

### 4.4 层对齐（不重复建轮子）

**benchmark 不是第 4 层**，它**复用 e2e 的 L1/L2/L3 基础设施**：

| Task 层 | 走 e2e 哪层 | 说明 |
|---------|-----------|------|
| L1 题（单轮单工具） | e2e L1 (API) 或 L2 (Agent) | 看题是否涉及 agent loop |
| L2 题（多轮多工具） | e2e L2 (Agent) | 主力 |
| L3/L4 题（复杂） | e2e L2 (Agent) | 基本都在 L2，不进 PTY |
| L5 题（端到端） | e2e L3 (CLI) 部分 | 只有"长时交互"类需要 |

YAML 里 `runtime.layer: L2` 告诉 runner 复用哪个 helper。**不用新搭测试框架**——e2e 的 `agent-runner.ts` / `pty.ts` / quorum 直接用。

### 4.5 稳定性（抗 Qwen3 flaky）

直接继承 e2e-test-plan §4 的 quorum + flaky 预算：

- L1 题：quorum 3/3（基线，必须稳）
- L2–L4 题：quorum 2/3
- L5 题：quorum 2/3 + 每周人工 review

**Benchmark 不为 flaky 降分**——quorum 2/3 过就算 pass，但在报告里**额外标出** flaky rate（3 次跑了 3 次才过？还是 1 次就过？）——这本身是一个**质量信号**，虽然不进 score 但进报告。

---

## 5. 对标 Claude Code

### 5.1 基线建立

**同一套题、同一套 fixture、Claude Code 跑一遍**，把结果固化为 baseline。

实施：
1. 在 Anthropic API 配一个 Claude Code 账号 / 用 `claude -p` CLI。
2. 写一个 `run-baseline.ts`，对每道题：
   - 启动 Claude Code 进程 / API session
   - 把 `user_input` 喂进去
   - 收集输出 + 检查 fixture 修改
   - 按**完全一样的 hard/soft assertions** 打分
3. 输出 `baselines/claude-code.json`：
```json
{
  "model": "claude-sonnet-4-6",
  "timestamp": "2026-04-29T10:00:00Z",
  "tasks": {
    "L1-001": { "score": 1.0, "hard_pass": true, "duration_sec": 3.2 },
    "L2-003": { "score": 0.95, "hard_pass": true, "duration_sec": 12.4 },
    ...
  },
  "aggregate": {
    "L1_score": 0.98,
    "L2_score": 0.94,
    "L3_score": 0.87,
    "L4_score": 0.81,
    "L5_score": 0.72,
    "total": 86.4
  }
}
```

### 5.2 对比维度

my-agent 跑完得到一份同格式 result，和 baseline 对比输出：

```
Benchmark Score:      my-agent: 48.2  |  Claude Code: 86.4  |  gap: -38.2
Final Level:          L2        |  L4          |  gap: -2 levels

Level-by-level:
  L1: 0.92 ✓        vs 0.98       gap: -0.06  (基本追平)
  L2: 0.78 ✓        vs 0.94       gap: -0.16  (稳定性掉队)
  L3: 0.41 ✗        vs 0.87       gap: -0.46  (compact/plan 差距大)
  L4: 0.22 ✗        vs 0.81       gap: -0.59  (跨文件能力差)
  L5: 0.08 ✗        vs 0.72       gap: -0.64  (长时任务漂)

Dimension breakdown (gap):
  Tool Stability:    -6%   (微弱)
  Context Retention: -23%  (中等)
  Error Recovery:    -35%  (明显)
  Planning:          -45%  ← 优先修
  Code Quality:      -20%
  Efficiency:        -50%  ← 本地优势本该强，说明没用到

Top gap tasks (前 5 名差距最大):
  1. L4-007 "useState 跨文件追踪":  my=0.1, cc=1.0 → 查 grep 多文件拼装
  2. L3-012 "10 轮对话 compact":    my=0.0, cc=0.9 → 查 summarize 质量
  3. L5-003 "读 my-agent 自己":     my=0.2, cc=0.8 → 查 AGENT.md 利用
  ...
```

**这才是"差在哪、差多少、怎么补"的输出**。不是一个总分，是一张诊断卡。

### 5.3 Baseline 维护

- Claude Code 升级了（比如 Sonnet 4 → Opus 4）→ baseline 重跑，存历史。
- my-agent 每次 release → benchmark 自动跑，写入 history。
- 生成趋势图：**my-agent 和 Claude Code 的差距随时间的变化**。

---

## 6. 落地路径

### 6.1 三个里程碑（建议给 leader）

#### 里程碑 1（2 周内）：L1 + L2 MVP

- 建 `test/benchmark/` 骨架
- 写 30 道 L1 + 30 道 L2 题（复用 e2e-test-plan 场景 + test/cases/README 内容）
- runner 跑通 + hard assertions 全实现
- llm_judge 先用 Claude Sonnet，soft 先只做"长度/次数"类简单软断言
- **交付点**：能输出一份 L1+L2 的分数报告，告诉我们 my-agent 在及格线以下还是以上

#### 里程碑 2（4 周内）：L3/L4 + Claude Code baseline

- 补 20 道 L3 + 15 道 L4
- 建立 Claude Code baseline（跑一遍存 JSON）
- 维度分实现
- 对比报告生成（my vs cc）
- **交付点**：第一张"差在哪"诊断卡

#### 里程碑 3（6 周内）：L5 + 长期趋势

- 5 道 L5 题（每题工作量大，但数量少）
- history 持久化 + 趋势图
- 集成到 CI：每次 release 自动跑 + 通知
- **交付点**：benchmark 成为 release gate + 持续监控

### 6.2 红线

- **不 mock 模型**：benchmark 必须跑真实本地模型（继承 e2e 红线）
- **不 mock 判官**：判官必须是真实 Claude / 另一个真模型
- **Task YAML 是单源真相**：不在代码里写死题目
- **baseline 每季度重建一次**：模型/代码/Claude Code 都会变，避免用过期参照
- **llm_judge 只参与 soft**：pass/fail 必须能机械验证
- **不跳级**：Level 单调，低级不过不能声称达到高级

### 6.3 给用户的"一句话报告"

每次跑完 benchmark，顶部一句话总结：

> **my-agent 当前等级：L2（综合 48 分）。距 Claude Code 差 38 分，主要差在 Planning（-45%）和 Efficiency（-50%）。下一步优先修 `agent.ts` 的 create_task 触发 + compact prompt 质量。**

---

## 7. 附录

### 7.1 与现有设计的映射

| 现有资产 | Benchmark 里的角色 |
|---------|-------------------|
| `test/cases/README.md` 20 case | 拆成 L1–L3 的原子题源头 |
| `test/e2e/` 三层金字塔 | Runner 的底层执行引擎，benchmark 复用不重建 |
| `docs/e2e-test-plan.md` §2 场景 | L1/L2 题的现成蓝本 |
| `docs/v2-plan.md` 5 功能 | L3/L4 的能力检测点（compact→L3、file_edit→L3、AGENT.md→L4 等） |
| mnemo id:510 根因 | L5 的"日志找根因"真实题 |
| mnemo id:946 e2e 方案 | 抗 flaky 策略直接继承 |

### 7.2 为什么不直接套 SWE-bench / HumanEval / GAIA

- **SWE-bench**：全是 Python repo + GitHub issue，我们的场景是"本地小项目 + 终端对话"，场景不对。
- **HumanEval**：纯代码补全，没工具调用，丢了 agent 能力的 80%。
- **GAIA**：太偏"用工具找信息"，我们场景 50% 是代码改写，GAIA 测不出。
- **τ-bench**：最接近我们的 agentic tool-use 场景，**借鉴了它的 LLM-as-judge 和多轮设计**，但它偏客服场景，我们是代码。

我们的 benchmark 是**定制化的**：分级体系参考 GAIA + SWE-bench lite/full；打分算法参考 τ-bench + AgentBench；题目风格参考 HumanEval 的原子化。**但场景全部本地化**。

### 7.3 开放问题（留给 leader 定）

1. **判官模型是否必须本地**：如果红线是"完全离线"，llm_judge 必须用本地第二模型；如果允许云端，Claude Sonnet 最稳。**建议**：允许 Claude Sonnet 做判官（成本可接受、准度高）。
2. **L5 题需要人工复核吗**：L5 题质量要求高，LLM-as-judge 可能判不准。**建议**：L5 题 llm_judge + 人工 review 双轨，每季度抽样核对判官质量。
3. **benchmark 进 CI 还是手动跑**：全量跑一次 30–60 分钟（100 题 + quorum 3），比较重。**建议**：PR 只跑 L1+L2（~10 分钟），release 跑 L1–L4（~40 分钟），手动触发跑全量 + L5。
4. **Baseline 要不要做多个模型**：除了 Claude Code，是否也跑 GPT-4 / Gemini 做横向对比。**建议**：先只做 Claude Code（我们的北极星），多模型等需要竞品数据时再加。

# L3+ Universal Agent Benchmark — 共识设计

> 署名：designer-a + designer-b · 2026-04-29
>
> 本文档合并自 `l3-benchmark-design-a.md`（designer-a）和 `l3-benchmark-design-b.md`（designer-b），经两轮 battle 对齐，剩余分歧 0。
>
> **一句话定位**：任何 CLI agent 都能通过 UAI 协议接入，跑固定题库；第三方裁判（Claude Sonnet 4.6 主 / GPT-4o 备）按 6 维打分；统一 runner 复用 M1 框架，仅在 adapter 层抽象；共识来自分歧逐条逼近，不是简单取并集。

---

## 0. 根本诉求与设计原则

用户三个诉求：
1. **通用**：任何 CLI agent 都能接入，不绑任何 agent 的内部 API。
2. **及格线**：L3 = 能独立完成完整小开发任务（改 bug、加功能、重构）。
3. **三方裁判**：开放性任务由 Claude 家族（或异源模型）按多维打分。

由此推出本设计的五条**不可妥协红线**（两人共识）：

| # | 红线 | 来源 |
|---|---|---|
| R1 | 只看外部可观察物（fs diff、stdout、exit code、post_check），不碰被测 agent 内部事件流 | designer-b |
| R2 | 被测与裁判不得同源：若被测 `underlying_model` 以 `claude-` 开头，裁判自动切 GPT-4o | designer-b |
| R3 | post_check 客观结果 cap correctness（exit=0 无 cap / exit=1 ≤0.5 / exit=2 ≤0.3），客观锚不可被 LLM 叙述推翻 | designer-a |
| R4 | NoRegression = 1 是硬门槛：既有测试一个都不能挂 | 两人达成 |
| R5 | 所有 objective_checks 必须原子化（一条命令只证明一件事）+ 显式 weight_into 绑定维度 | designer-b |

---

## 1. Universal Agent Interface (UAI) — 被测接入协议

### 1.1 协议选型

L3 选 **single-prompt CLI 模式**（而非 stream-json），理由：
- SWE-bench 验证成熟，所有主流 CLI agent 原生支持
- 覆盖面最广：Claude Code / Codex / Aider / Gemini / MA 全部适配
- stream-json 留给 L4/L5 升级（保留扩展口）

### 1.2 执行合约

```
输入:
  - workdir: 从 fixture 复制好的临时目录
  - prompt: 自然语言任务描述（≤ 2KB）
  - env: 可选（API key / 超时 / max_rounds）

执行:
  cd $workdir
  <AGENT_CMD> "$PROMPT" > stdout.log 2> stderr.log
  EXIT_CODE=$?

评测框架只关心:
  1. 进程是否退出（超时则 SIGTERM+5s → SIGKILL）
  2. 退出码
  3. stdout 中 "最终回复"（见 §1.3）
  4. workdir 的 git diff（相对于 fixture 初始 commit）
```

### 1.3 "最终回复"抓取策略（designer-b 的洞察）

不同 CLI 输出差异大，分三层处理：

1. **优先**：agent 在最后输出 `===FINAL_ANSWER===\n<text>\n===END===`，提取这段。
2. **兜底**：没有标记 → 取 stdout 最后 4KB 作为最终回复。
3. **adapter 清洗层**：接入方可写 10 行脚本去 ANSI / 去工具调用日志，只保留人话。

### 1.4 Adapter 规范：YAML 声明式（designer-a 的 YAML + designer-b 的 `underlying_model` 字段）

每个被测 agent 一个 adapter YAML：

```yaml
# test/benchmark/adapters/claude-code.yaml
name: claude-code
version: 1.2.0
underlying_model: claude-sonnet-4-6    # 关键：驱动裁判自动切换
command: claude
args:
  - "-p"
  - "${PROMPT}"
  - "--permission-mode=acceptEdits"
env:
  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
workdir: ${WORKSPACE}
timeout_sec: 900
events:
  stdout_format: stream-json              # 可选，用于采集事件统计
  final_answer_marker: "===FINAL_ANSWER==="
termination:
  normal_exit_codes: [0]
```

```yaml
# test/benchmark/adapters/ma-agent.yaml
name: ma-agent
version: 0.3.1
underlying_model: qwen3-30b
command: node
args: ["dist/cli.js", "run", "--prompt", "${PROMPT}"]
workdir: ${WORKSPACE}
timeout_sec: 900
events:
  stdout_format: jsonl
```

```yaml
# test/benchmark/adapters/aider.yaml
name: aider
version: 0.85
underlying_model: gpt-4
command: aider
args: ["--message", "${PROMPT}", "--yes", "--no-check-update"]
workdir: ${WORKSPACE}
timeout_sec: 900
events:
  stdout_format: text
```

### 1.5 执行流程（designer-a 的 runner 流程）

```
1. workspace = copy(fixture) 到 /tmp/bench-<runid>/<taskid>/
2. cd workspace && git init && git add -A && git commit -m init
3. 渲染 prompt（从 task YAML 的 prompt.file，支持 ${fixture_path} 占位）
4. spawn adapter.command(args, env, cwd=workspace)
   ├── 管道 stdout/stderr 到 runs/<runid>/<agent>/<taskid>.*.log
   ├── 计时 start_ts → end_ts
   ├── 解析事件（stream-json/jsonl）计数 tool_calls / turns / tokens
5. wait(timeout_sec)：超时 SIGTERM+5s → SIGKILL，标 timed_out=true
6. 收集 artifact:
   ├── workspace_diff = git diff HEAD
   ├── final_answer = 抓 ===FINAL_ANSWER=== 或取尾 4KB
   ├── runtime = { duration_sec, tool_calls, turns, exit_code, tokens, timed_out }
7. 跑 post_check（见 §2.5），记录 exit_code
8. 打包 submission 交给 judge（见 §3）
```

### 1.6 超时与结束信号

| 场景 | 检测 | 处理 |
|---|---|---|
| 正常退出 | exit_code != 124 且非超时 | 走评分 |
| 超时 | 到 timeout_sec 仍在跑 | SIGTERM + 5s → SIGKILL，标 timed_out=true，Efficiency=0，其他维度按当时状态评 |
| Crash | 退出码非 0 非 124 | 裁判看 stderr 决定是"agent 崩了"还是"任务本就报错" |
| 卡死 | stdout/stderr 90s 无新输出 | 同超时处理 |
| 超时后重试 | 首次超时 | 重试 1 次；第 2 次仍超时 → run invalid，**不计分、不扣钱** |

### 1.7 兼容性陷阱（designer-a）

| 陷阱 | 触发 agent | 缓解 |
|---|---|---|
| 交互式 TUI 不读 stdin | Aider、Goose | adapter 必须用 `--yes / --no-input / --headless` |
| 要写 $HOME 配置 | Codex、Claude Code | 注入一次性 `HOME=$WORKSPACE/.home` 隔离 |
| 连网慢 / rate-limit | 云端 agent | 失败重试 1 次；连续 2 次 timeout → run invalid |
| 不支持指定 workdir | Aider 老版本 | 用 `cd workspace && <cmd>` 包裹 |
| 权限询问卡死 | Claude Code 默认 | adapter 必须写 `--permission-mode=acceptEdits` 或等价 flag |

### 1.8 完成信号的权威源

**不信任 agent 自报**。完成信号只有两个来源：
1. adapter 进程正常退出（表示"agent 自认为跑完"）
2. **post_check 命令退出码**（客观）

最终计分以 workspace diff + post_check 为准。agent 说 "done" 但 diff 为空 → 当作未完成。

---

## 2. 任务设计

### 2.1 L3 及格线操作定义

> 把 fixture 给一个**合格初级工程师**（能看懂代码、会用 git），他在 15 分钟内、不问问题、不查外部文档能完成。

任务特征：
- **目的明确但路径开放**：给症状或需求，不给文件和行号
- **规模小**：改动 < 50 行，涉及 1-3 个文件
- **有客观正确性信号**：`npm test` / `pytest` 通过，或有可执行的 expected behavior
- **不需要外部文档**：项目自足，不涉及第三方库冷门 API

### 2.2 L2 vs L3 vs L4 边界（designer-b 的三层表 + designer-a 的硬断言说明）

| Level | 典型任务 | 核心能力 | 评判 |
|---|---|---|---|
| L2（M1 已完成） | "把 README 版本改成 2.0.0" | 单文件、明确路径、2-3 轮 | 硬断言 file_content |
| **L3（本文档）** | "修复 parseConfig 对空串的崩溃" | 跨 2-3 文件、读懂代码、跑测试 | 客观 post_check + 6 维裁判 |
| L4（留给 M3） | "给 CLI 加 --verbose flag" | 自主规划、跨文件重构、改测试 | 裁判主导 |

### 2.3 题量：20 道

- Phase 2 先落 5 道跑通管线
- Phase 3 扩到 20 道，每类 3-4 题
- 20 道 × 3-run × 15min = 每 agent ~15 小时，多 agent 并发可控

### 2.4 题型分布（两人协商后）

| 类别 | 题数 | 示例 |
|---|---|---|
| bug-fix with tests | 5 | 带 failing test 的 node 项目，agent 需找 bug 并修，让 `npm test` 过 |
| bug-fix no tests | 3 | 重放 README 命令复现错，agent 定位并修 |
| **add small feature** | **4** | 给已有函数加参数、加字段、加端点（含 designer-b 的 L3-001） |
| refactor | 3 | 3 个 callback 改 async/await（designer-b 的 L3-003 god class） |
| docs / config | 2 | 迁 CommonJS→ESM；写 ARCHITECTURE.md（designer-b 的 L3-004） |
| diagnose | 3 | 从 logs/ 定位 500（designer-b 的 L3-005） |

**首批 5 道样题**：沿用 designer-b 的 L3-001 到 L3-005（YAML 可直接用），见附录 D。

### 2.5 Fixture 规范

```
test/benchmark/tasks/L3/L3-001-parseconfig-empty/
  task.yaml                 # 任务元数据
  fixture/                  # agent 看到的初始代码
    package.json
    src/parseConfig.js
    test/parseConfig.test.js
    README.md
  reference/                # 裁判看（agent 不能看）
    solution.patch          # 一种人类实现
    rubric.md               # 要求点 / 加分项 / 禁区
    post_check.sh           # 客观验证脚本
  prompts/
    user.md                 # agent 收到的任务描述
```

**Fixture 约束**：
- < 200 文件，< 1MB 依赖清单
- **锁死依赖版本**：package-lock.json / yarn.lock 必 commit，离线缓存 `node_modules-<hash>`
- **freshness guard**：不用 SWE-bench / HumanEval 原题（防训练污染），自造 + 从 2026 年后真实 commit 反演

### 2.6 post_check 退出码与 correctness cap

| exit | 含义 | correctness cap |
|---|---|---|
| 0 | 全部通过 | 无 cap |
| 1 | 功能对，但测试/文档缺 | ≤ 0.5 |
| 2 | 功能错（测试挂） | ≤ 0.3 |
| ≥ 3 | 脚本自己崩了 | **先查兜底**（见下方） |

**exit ≥ 3 的兜底**（designer-b 补）：
1. 检查 `node_modules/` 是否被 agent 改动（被改 → 是 agent 的锅）
2. 检查 `package.json` / `package-lock.json` / `yarn.lock` 是否被改（被改 → 是 agent 的锅）
3. 任一命中 → correctness = 0，继续其他维度评分
4. 都没命中 → run invalid（脚本/环境问题，整题重跑）

### 2.7 Task YAML 格式

```yaml
# test/benchmark/tasks/L3/L3-001/task.yaml
id: L3-001
title: 修复 parseConfig 对空字符串的崩溃
level: L3
category: bugfix-with-tests
weight: 1.0

fixture:
  dir: ./fixture
  setup:
    - npm install --no-audit --no-fund --prefer-offline

prompt:
  file: ./prompts/user.md

reference:
  solution_patch: ./reference/solution.patch
  rubric: ./reference/rubric.md
  human_time_min: 10
  expected_tool_calls: 8
  expected_files_changed: [src/parseConfig.js, test/parseConfig.test.js]

# 客观检查：必须原子化 + 必须显式 weight_into
objective_checks:
  - id: existing_tests_pass
    cmd: "npm test -- --testPathPattern='test/existing'"
    expected_exit: 0
    weight_into: NoRegression
  - id: new_tests_pass
    cmd: "npm test -- --testPathPattern='test/parseConfig'"
    expected_exit: 0
    weight_into: Correctness
  - id: typecheck
    cmd: "npx tsc --noEmit"
    expected_exit: 0
    weight_into: Correctness
  - id: linter
    cmd: "npx eslint src/"
    expected_exit: 0
    weight_into: CodeQuality

post_check:
  cmd: bash ./reference/post_check.sh
  timeout_sec: 120
  # exit→correctness cap: 0=no_cap, 1=≤0.5, 2=≤0.3, ≥3=查兜底

judge:
  dimensions:
    TaskCompletion: 0.25
    Correctness: 0.20
    Completeness: 0.15
    CodeQuality: 0.10
    Efficiency: 0.10
    NoRegression: 0.20
  rubric_file: ./reference/rubric.md
  # Communication 默认关闭，文档/诊断类题目 override 开启

runtime:
  timeout_sec: 900
  runs: 3                       # 3-run median
  layer: subprocess-cli
```

### 2.8 YAML schema 强校验（designer-a 补）

loader 在加载时强校验：
- `objective_checks[].weight_into` 必填，否则 schema error
- 一条 check 只能映射到一个维度（禁止一对多，防偷懒）
- `judge.dimensions` 权重总和必须在 [0.99, 1.01] 容差内

---

## 3. 裁判系统

### 3.1 定位与五条红线

裁判只做**开放性评分**，不做 pass/fail 判定。pass/fail 由 post_check cap + 维度门槛联合决定。

| # | 红线 | 来源 |
|---|---|---|
| J1 | 被测与裁判不同源：被测 underlying_model 以 `claude-` 开头 → 裁判自动切 GPT-4o | b |
| J2 | 裁判不看 agent 名字和版本（去 agent 化提交包），防自我偏好 | b |
| J3 | 裁判 3 次 median + 第 3 次用反向 prompt cross-validation | a + b |
| J4 | 参考解仅作"一种合格解"，不是 diff 比对标准；rubric 为准 | a |
| J5 | post_check 失败 → correctness 有 cap，裁判不能推翻 | a |

### 3.2 裁判模型选择

| 场景 | 主裁判 | 备选 |
|---|---|---|
| 被测 underlying_model 不是 Claude 系 | **Claude Sonnet 4.6** | GPT-4o |
| 被测是 Claude 系（如 MAClaude、Claude Code） | **GPT-4o** | Gemini 1.5 Pro（v2） |

**为什么 GPT-4o 而非 GPT-4-Turbo**：128K 上下文够装 diff+fixture+rubric；价格比 Turbo 低约 50%；MT-Bench 验证评分尺度与 Claude 接近。

### 3.3 裁判输入（submission 包）

```json
{
  "task": {
    "id": "L3-001",
    "prompt": "<原始用户 prompt>",
    "fixture_relevant_files": [...],
    "rubric_points": ["要求 1", "要求 2", ...],
    "no_modify_files": ["tests/existing/*"]
  },
  "reference": {
    "solution_patch": "<参考解 diff>",
    "human_time_min": 10,
    "expected_tool_calls": 8
  },
  "submission": {
    "workspace_diff": "<agent git diff>",
    "final_answer": "<抓取的最终回复>",
    "runtime": {
      "duration_sec": 340, "tool_calls": 12, "turns": 7,
      "exit_code": 0, "timed_out": false, "tokens": 15000
    },
    "objective_checks": [
      {"id": "existing_tests_pass", "exit": 0, "weight_into": "NoRegression"},
      {"id": "new_tests_pass", "exit": 0, "weight_into": "Correctness"},
      ...
    ],
    "post_check": {"exit": 0, "tail": "..."},
    "stdout_tail": "<前 500 行 + 后 200 行>",
    "stderr_tail": "<后 200 行>"
  }
}
```

**裁判不看**：agent 名字、版本、underlying_model、其他 agent 分数、历史数据。

**fixture 摘要策略**：若 fixture > 20 文件，runner 预算 "relevant files"（基于 solution.patch 涉及文件 + 直接依赖），只给裁判这部分。

### 3.4 6 维评分（+ 可选第 7 维 Communication）

**核心 6 维，权重总和 1.00**：

| # | 维度 | 权重 | 0 分 | 1 分 | 客观/LLM |
|---|---|---|---|---|---|
| 1 | **TaskCompletion** | 0.25 | 没做 / 做错方向 | rubric 要求点 N/N 全覆盖 | 混合（数数+判断） |
| 2 | **Correctness** | 0.20 | post_check 挂 / 主要路径错 | 已完成部分测试过+类型过+无幻觉 | 客观（post_check cap） |
| 3 | **Completeness** | 0.15 | 只改主代码，无测试/无文档 | 代码+测试+必要文档都到位 | LLM + 客观（测试文件数） |
| 4 | **CodeQuality** | 0.10 | hack / 与项目风格严重偏离 | 无缝融入既有风格、无 smell | LLM |
| 5 | **Efficiency** | 0.10 | > 3× reference / 超时 | ≤ reference | 客观（duration/tool_calls/tokens） |
| 6 | **NoRegression** | 0.20 | 既有测试挂 / 碰了 no_modify 文件 | 既有测试全过、未碰禁区 | 客观 |

**TaskCompletion vs Correctness 明确切法**（两人反复打磨的结论）：

- **TaskCompletion = 需求覆盖"宽度"**：rubric_points 里 N 个要求点，完成 M 个 → 分数 = M/N
- **Correctness = 已完成部分"深度"**：对那 M 个点，代码是否真的正确（post_check + 类型检查 + 幻觉检查）

例子：
- 加 3 档 align 参数，只实现 1 档全对 → `TaskCompletion=0.33, Correctness=1.0`
- 加 3 档全做了但 right 档 off-by-one → `TaskCompletion=1.0, Correctness=0.67`

**Correctness 内部 2 个 sub-score**（报告里展开）：
```
Correctness = (feature_completeness + code_correctness) / 2
  feature_completeness = rubric 中"做了的部分"的对错率
  code_correctness = post_check 结果 × 幻觉扣分 × 类型检查
```

**Pass 门槛**：
```
pass = (total_score ≥ 0.65)
     ∧ (TaskCompletion ≥ 0.5)
     ∧ (Correctness ≥ 0.5)
     ∧ (NoRegression = 1)     ← 硬等于 1，不是 ≥ 0.8
```

### 3.5 可选第 7 维 Communication（task-level override）

```yaml
judge:
  dimensions:
    TaskCompletion: 0.225   # 原 0.25 × 0.9
    Correctness: 0.18
    Completeness: 0.135
    CodeQuality: 0.09
    Efficiency: 0.09
    NoRegression: 0.18
    Communication: 0.10     # 新增
```

启用时其他 6 维**等比例乘 0.9** 保持总和 1.00。仅在文档/诊断类题目开启（如 L3-004 写 ARCHITECTURE.md，L3-005 说清根因）。

### 3.6 3-run + 反向 prompt Cross-Validation

- **Run 1**：正向打分（标准 prompt）
- **Run 2**：正向打分（相同 prompt，不同 random seed / timestamp nonce）
- **Run 3**：**反向 prompt**（"找出所有问题和不足"，输出 severity ∈ [0,1]）

最终分数：
```
final_score = median(run1_score, run2_score, 1 - run3_severity)
```

**为什么不每 run 都反向**：成本 ×2。第 3 run 单次做校准足够；AlpacaEval 2.0 实证有效。

### 3.7 裁判 Prompt 模板（正向）

```markdown
你是资深 code reviewer，审查一份 agent 提交。按 6 维各打 0/0.5/1，并给一句理由。

## 任务
{{task.prompt}}

## 评分 rubric（核心要求/加分项/禁区）
{{rubric_md}}

## 初始代码关键文件
{{fixture_relevant_files}}

## 参考解法之一（仅供对比，不是唯一正解）
```diff
{{reference.solution_patch}}
```

## 被测提交

### 改动（git diff）
```diff
{{submission.workspace_diff}}
```

### Agent 最终回复
```
{{submission.final_answer}}
```

### 客观检查结果（已按 weight_into 分类）
{{objective_checks_grouped_by_dimension}}

### 运行统计
- 耗时 {{duration_sec}}s（参考 {{human_time_min}} 分钟 × 60）
- 工具调用 {{tool_calls}}（参考 {{expected_tool_calls}}）
- 超时 {{timed_out}} / post_check exit {{post_check_exit}}

## 评分规则
- **TaskCompletion**：数 rubric_points 里做到了几条（M/N）
- **Correctness**：已做部分是否真对。post_check exit=1→最多 0.5，exit=2→最多 0.3
- **Completeness**：测试 + 文档 + 边界是否齐
- **CodeQuality**：是否融入项目风格、无 hack
- **Efficiency**：duration/tool_calls vs reference。≤参考=1，1.5-3×=0.5，>3×=0，超时=0
- **NoRegression**：既有测试全过 + 未碰 no_modify 文件 → 1；否则 0

## 反幻觉检查（强制）
final_answer 提到的每个文件路径/函数名/命令，必须在 workspace_diff 或 fixture 里能找到证据。找不到 → 标幻觉，每个幻觉在 Correctness 扣 0.1（最低 0）。

## 输出严格 JSON（不要 markdown 包裹）
{
  "dimensions": {
    "TaskCompletion": {"score": 0|0.5|1, "reason": "一句话"},
    "Correctness": {"score": 0|0.5|1, "reason": "一句话",
                    "sub_scores": {"feature_completeness": 0-1, "code_correctness": 0-1}},
    "Completeness": {...}, "CodeQuality": {...}, "Efficiency": {...}, "NoRegression": {...}
  },
  "hallucinations": ["<描述>", ...],
  "overall_note": "两句话综合评价"
}
```

### 3.8 裁判 Prompt 模板（反向 Run 3）

```markdown
你是严苛的 code reviewer，任务是**找出这份提交的所有问题、漏洞、不足**。

{{task + rubric + reference + submission 同正向}}

## 你的任务
列出所有问题（代码错误、规范偏差、漏测试、幻觉、效率问题、破坏性改动），按严重度 high/mid/low 标注。

## 输出 JSON
{
  "issues": [
    {"severity": "high|mid|low", "dimension": "<6 维之一>", "description": "..."}
  ],
  "overall_severity": 0-1    // 综合严重度：0=完美，1=完全废品
}
```

第 3 run 的 `1 - overall_severity` 作为"反向分数"喂给 median。

### 3.9 跨模型校准（designer-a 的分位对齐方案）

当裁判切 GPT-4o 时，原始分数尺度和 Sonnet 不同。**跨模型分位对齐（quantile mapping）**：

```
1. 校准集 = 黄金集 20 道（人类已标定分数，复用）
2. 对每个 judge 模型各跑一遍黄金集（3-run median）
3. 求 P10 / P25 / P50 / P75 / P90 五分位点
4. 把 GPT-4o 的分数映射到 Sonnet 的同分位（线性插值填中间）
5. 报告里**双线展示**：
   agent        judge   raw    calibrated
   MA@Qwen30B   Sonnet  0.61   0.61 (baseline)
   MAClaude     GPT-4o  0.78   0.75 (mapped)
```

**为什么不是简单线性 a×x+b**：GPT-4o 在 0.7-0.9 区间可能特别宽，线性拉不平。分位对齐保持分布形状。

### 3.10 裁判调用约束

| 约束 | 说明 |
|---|---|
| **一次调用一题** | 不批量喂多题，防止 LLM 做比较偏差 |
| **并发隔离** | 不同题的 judge 调用可并发，但同题 3 run 串行（防 rate-limit 冲突） |
| **温度** | temperature = 0.0 + prompt 中 nonce（random seed + timestamp）避免 cache 污染 |
| **失败重试** | API rate-limit/网络失败 → 指数退避重试最多 2 次。第 3 次仍失败 → 若已有 2 个 run 成功，用它们 median 兜底；否则整题 invalid |
| **Prompt 版本化** | 每次 prompt 改版记 hash，`judge_prompt_version` 写入报告，历史可追溯 |

### 3.11 防作弊与防偏见

| 风险 | 防御 |
|---|---|
| 裁判偏向 Claude 生态 | J1 异源红线 + J2 去 agent 化 + 3-run median + 10% 人类抽检 |
| agent 写漂亮 README 骗裁判 | Correctness 锚 post_check；README 进 Completeness 不进 Correctness |
| agent 改测试让它过 | `no_modify_files` 白名单 + NoRegression=1 硬门槛 |
| agent 调外部服务作弊 | runner 限制网络（fixture 禁用非 `npm install` 外的请求） |
| 长 prompt 刷长度 | Efficiency 计 token，长度无奖励 |
| 裁判幻觉 | 3-run + prompt 强制引用 diff 行号作理由 |
| LLM 夸夸其谈 | Run 3 反向 Cross-Validation 取 min |
| 裁判位置偏好（横比场景） | 多 agent 横比时，裁判看单份提交，不做 A/B 对比 |

### 3.12 黄金集 + 人类对齐

- **黄金集 20 道**：人类标注"标准分数"（每题 3-5 份人类参考答案 + 打分）
- **Pearson ≥ 0.85** 门槛：每次升级裁判 prompt 或换裁判模型，必须在黄金集上与人类分数达此阈值才上线
- **10% 人类抽检**：每次完整跑分随机抽 10%（约 2 道 × 每 agent）人工复查。连续 2 次发现 > 20% 判错 → prompt 进入修复期
- **judge_ci**：报告中显示每题 3-run 的 MAD（median absolute deviation），宽 CI 建议人工 review

---

## 4. Runner 架构（统一 + adapter 层抽象）

### 4.1 复用 M1 框架

**不做两套 runner**。M1 的 task-loader / scorer / reporter / YAML schema 全部复用，仅在 **adapter 层**做抽象：

```
test/benchmark/
  tasks/
    L0/ L1/ L2/                       # M1 硬断言题（保留）
    L3/<id>/                          # 新增：每题一目录（fixture+reference+prompts+task.yaml）
  adapters/                           # 新增
    _schema.ts                        # AdapterSpec schema
    ma-agent.yaml
    claude-code.yaml
    codex.yaml
    aider.yaml
  runner/
    index.ts                          # 保留，分支新增
    task-loader.ts                    # 保留，YAML schema 扩展（objective_checks / judge 块）
    adapter/                          # 新增
      base.ts                         # AdapterInterface
      builtin-ma.ts                   # L0-L2 用，调 bootstrap
      subprocess-cli.ts               # L3+ 用，spawn CLI
    workspace.ts                      # 新增：fixture copy + git init + diff
    events.ts                         # 新增：stream-json/jsonl/text 事件解析
    post-check.ts                     # 新增
    assertions/                       # M1 保留，不动
      hard.ts
      soft.ts
    scorer.ts                         # 扩展：score_hard + score_judge 双分支
    reporter.ts                       # 扩展：per-dim 展开 + sub-score 展示
  judge/
    base.ts                           # JudgeProvider 接口
    claude-judge.ts                   # Sonnet 4.6
    openai-judge.ts                   # GPT-4o（新增）
    dimension-prompts.ts              # 新增：6 维 prompt 模板 + 反向 prompt
    submission-packager.ts            # 新增：拼 judge 上下文
    calibration.ts                    # 新增：分位对齐
  baselines/
    history.jsonl
    golden-set/                       # 新增：黄金集 20 道 + 人类分数
  reports/
    <run-id>/...
```

### 4.2 统一评分公式

```
# M1 (L0-L2) 保留：硬断言主导
score_hard(T) = hard_pass × (0.6 + 0.4 × soft_score)

# L3+ 新增：6 维加权
score_judge(T) = Σ(dim_weight × dim_median_over_3_runs)
  where correctness capped by post_check:
    exit=0 → no cap
    exit=1 → correctness ≤ 0.5
    exit=2 → correctness ≤ 0.3
    exit≥3 → 先查 node_modules/lockfile 兜底

# 统一输出
score(T) = {
  L0-L2: score_hard(T)
  L3-L5: score_judge(T)
}

# Level 聚合（不变）
score(L) = Σ(w_T × score(T)) / Σ(w_T)
pass(L3) = score(L3) ≥ 0.55 ∧ task_pass_rate(L3) ≥ 0.70

# AUS 公式（不变，M1 决策）
AUS = (MA30B - Raw30B) / (MAClaude - Raw30B) × 100%
```

### 4.3 Adapter 接口

```ts
interface AdapterSpec {
  name: string;
  version: string;
  underlying_model: string;           // 必填，驱动 judge 自动切换
  command: string;
  args: string[];                     // 支持 ${PROMPT} ${WORKSPACE} 占位
  env?: Record<string, string>;
  workdir?: string;
  timeout_sec: number;
  events: {
    stdout_format: 'none' | 'stream-json' | 'jsonl' | 'text';
    final_answer_marker?: string;
    tool_call_pattern?: string;
    turn_pattern?: string;
  };
  termination?: {
    normal_exit_codes?: number[];
  };
}
```

### 4.4 Rubric 分治：主 repo + 私有 holdout repo

- **主 repo** (`test/benchmark/tasks/L3/`)：公开题库 + rubric 全公开
- **私有 holdout repo** (`benchmark-holdout`，独立 git，权限收紧)：20% 题目 + rubric 完全私有
- runner 扫描**两个目录**的 tasks
- **每季度公开题库轮换 5 道**（新题入公开，旧题入历史存档），防 goodhart

避免 rubric 误 commit 到公开 repo：主 repo 加 pre-commit hook 禁止 `rubric_secret: true` 字段。

---

## 5. 首批 5 道样题（Phase 2）

直接采用 designer-b 原方案的 5 道，微调：对齐新的 6 维权重、原子化 objective_checks、补 underlying_model。

| ID | 标题 | 类别 | 核心考点 |
|---|---|---|---|
| L3-001 | 给 Express API 加 /health 端点 | add-feature | 跨文件新增 + 测试 + 项目约定 |
| L3-002 | 跨文件修复 TypeScript 类型错误 | bug-fix | 不能用 `any` / `@ts-ignore` 糊弄 |
| L3-003 | 拆分 600 行 god class | refactor | 重构后测试仍全过 |
| L3-004 | 调研 + 写 ARCHITECTURE.md | docs | 无幻觉 + 简洁（启用 Communication 维度） |
| L3-005 | 从日志定位并修 500 bug | diagnose | 根因说清 + 新增测试（启用 Communication） |

样题完整 YAML 见 designer-b 原文档 §5（复用不再重写）。

---

## 6. 多 agent 对比报告（合并 a + b 样例）

```
═══════════════════════════════════════════════════════════════════
  L3 Universal Benchmark — 2026-05-15
  Tasks: 20   Runs/task: 3 (median + reverse CV)
  Judges: Sonnet 4.6 / GPT-4o (calibrated via quantile mapping)
  Prompt version: v1.2
═══════════════════════════════════════════════════════════════════

  Agent (underlying)          Judge     Raw    Calib  Pass   Cost   Median
  claude-code (claude-sonnet) GPT-4o    0.85   0.83    ✓    $2.40    4min
  ma-agent (qwen3-30b)        Sonnet    0.63   0.63    ✗    $0       8min
  codex (gpt-4)               Sonnet    0.70   0.70    ✓    $1.80    5min
  aider (gpt-4)               Sonnet    0.55   0.55    ✗    $2.00    7min

  ─────── 6 Dimensions (calibrated) ───────
                    TaskComp  Corr   Compl  Qual   Eff    Regr
  claude-code       0.90      0.85   0.80   0.85   0.80   1.00
  ma-agent          0.72      0.65   0.55   0.60   0.52   0.95  ← Regr < 1 导致 fail
  codex             0.75      0.72   0.70   0.75   0.68   1.00
  aider             0.60      0.55   0.55   0.60   0.50   0.85

  ─────── Correctness sub-scores (ma-agent) ───────
  feature_completeness: 0.70 (做到了 14/20 个 rubric_points)
  code_correctness:     0.60 (post_check 中 5 题 exit=1 cap 到 0.5)

  ─────── vs Claude Code ───────
  Gap:   -0.20 (calibrated)
  AUS:    57% (MA lifts 30B to 57% of Claude level)
  Cost:   $0 (local)   vs   $2.40/run
```

---

## 7. 预算与里程碑

### 7.1 成本

| 项 | 数量 | 小计 |
|---|---|---|
| MA 本地执行 | 20×3×8min | $0 |
| Claude Code | 20×3×4min | $28.80 |
| Codex | 20×3×5min | $24.00 |
| Judge（Sonnet 80% + GPT-4o 20%） | 20×3×3×4 agent | ~$50 |
| Post-check / fixture setup | 忽略 | $0 |
| **缓冲（超时重试、校准）** | | $15 |
| **合计** | | **~$120/次** |

- 周度跑一次，月成本 < $500
- 超时只重试 1 次、第 2 次 invalid，硬止损

### 7.2 里程碑

**M2-a (2 周)**：adapter + workspace + 单维 judge
- adapter YAML schema + subprocess-cli 实现（MA + Claude Code 两家）
- workspace.ts：fixture copy + git init + diff
- post-check.ts + exit≥3 兜底
- judge 只打 correctness 一维跑通
- **交付**：5 道 L3 样题跑通 MA + Claude Code，出单维分数

**M2-b (2 周)**：6 维 judge + 跨模型校准 + 完整题库
- 6 维 prompt + 反向 CV + 3-run median
- 分位对齐校准
- 黄金集 20 道 + Pearson ≥ 0.85 门槛
- 10% 人类抽检管线
- L3 题库扩到 20 道
- **交付**：完整 L3 跑分报告，MA vs Claude Code 差距诊断

**M2-c (1 周)**：扩 agent + 稳定性 + M1 回归
- adapter 扩 Codex + Aider
- 裁判 prompt 按人类抽检结果调优
- M1 (L0-L2) 回归测试，确认统一 runner 未破坏
- holdout repo 初始化 + pre-commit hook
- **交付**：L0-L3 全体系稳定，月度跑分基线

**M3 (之后)**：L4/L5 + AUS 趋势 + CI 集成

### 7.3 CI 策略

- **PR 门禁**：仅跑 L0-L2（M1，~30min），不碰 L3
- **Release 门禁**：L3 (MA vs Claude Code)，~4h
- **周度全量**：所有 agent × L0-L3 + holdout，手动或定时
- **L4/L5**：M3 再加

---

## 8. 不可妥协红线汇总

1. **R1 只看外部可观察物** — fs diff / stdout / exit / post_check，不碰 agent 内部事件流
2. **R2 被测≠裁判同源** — Claude 系被测 → GPT-4o 裁判；非 Claude 系 → Sonnet 裁判
3. **R3 post_check cap correctness** — 客观锚不可被 LLM 叙述推翻
4. **R4 NoRegression = 1 硬门槛** — 既有测试一个都不能挂
5. **R5 objective_checks 原子化 + 显式 weight_into** — 一条 check 证一件事，禁止一对多
6. **J3 裁判 3-run median + Run 3 反向 CV** — 防宽松偏见
7. **跨模型裁判必须分位对齐** — 不同模型尺度差异透明披露（raw + calibrated 双线）
8. **黄金集 Pearson ≥ 0.85** — 任何 prompt 或模型升级必须过阈值
9. **Fixture 版本锁死** — package-lock.json / yarn.lock 必 commit，离线缓存
10. **Rubric 半公开** — 公开题库全透明，20% holdout 题 + rubric 全私有，每季度轮换 5 道
11. **L3 gate on L2** — L2 未过 L3 锁定
12. **超时只重试 1 次** — 第 2 次超时 run invalid，止损

---

## 9. 留给 team-lead 的决策点

| # | 问题 | 我们的推荐 |
|---|---|---|
| 1 | 黄金集 20 道由谁标注？ | designer-a/b 各写 10 道人类参考解 + 打分，交叉审核 |
| 2 | holdout repo 放哪？ | 同组织下的私有 repo `my-agent-bench-holdout`，权限限核心维护者 |
| 3 | 跨模型校准首次跑什么时候？ | M2-b 开始时，跑完黄金集立即生成 quantile map |
| 4 | MAClaude 配置的 underlying_model 怎么声明？| adapter YAML 里手动写 `underlying_model: claude-sonnet-4-6`，依赖接入方诚实 |
| 5 | L3 gate cutoff (0.55 / 70%) 要不要调？ | 沿用 M1 方案 A 不动，跑完 M2-b 再看实际分布调整 |

---

## 10. 两人分歧收敛记录（附：审阅透明）

共识过程：designer-a 出初稿 → designer-b 独立出 b 稿 → team-lead 安排交叉审阅 → 两人 2 轮 battle → 本文档。

| 分歧点 | a 原立场 | b 原立场 | 最终共识 | 谁让步 |
|---|---|---|---|---|
| 维度数 | 5 维 | 7 维 | **6 维**（+TaskCompletion, -Communication 默认关闭, -Robustness 并入 Completeness） | 两人互让 |
| 接入协议 | YAML adapter + bash 脚本侵入 | UAI + FINAL_ANSWER 标记 + bash adapter | YAML adapter + FINAL_ANSWER 标记（两者合并） | 两人合并 |
| 最终回复抓取 | 未设计 | FINAL_ANSWER 标记 + 4KB 兜底 | 采 b | a |
| 被测 vs 裁判同源 | v2 再做 | v1 强制切 GPT-4 | v1 切 **GPT-4o** | a |
| Cross-Validation 反向 prompt | 未设计 | 每 run 正反双 prompt | **只 Run 3 反向**，成本折半 | 两人优化 |
| NoRegression 门槛 | 连续分 ≥0.5 | 三档 ≥0.8（有逻辑问题） | **硬 = 1** | b |
| 两套 runner vs 统一 | 统一 | 两套 | **统一 runner**，adapter 层抽象 | b |
| Rubric 保密 | 全公开 | 保密防作弊 | **公开 + 20% holdout 私有 + 季度轮换** | 两人合并 |
| objective_checks 绑定 | 裁判自行归属 | 显式 weight_into | **显式 + 原子化 + 一对一强校验** | a |
| 题量 | 20 | 5 | **Phase2=5 / Phase3=20** 分阶段 | 两人合并 |
| 5-run vs 3-run median | 3-run | 5-run → 3-run | **3-run**（L3 昂贵） | b |
| 跨模型裁判校准 | 未设计 | 10 样本线性映射 | **20 样本 + 分位对齐 + 透明双线** | b 接受 a 的微调 |
| 样题分布 | 类别未具体 | 5 道样题 YAML 化 | 采 b 的 5 道做 Phase2 起点，Phase3 扩到 20 | a |
| Judge 调用隔离 | 未写 | 未写 | **一次调用一题 + 并发隔离 + 指数退避重试 2 次** | 两人补充 |

---

## 11. 一句话收尾

M1 的 L0-L2 回答"MA 自己稳不稳"。**L3+ 回答"任何 CLI agent 能不能给人干活，距离 Claude Code 多远"**。核心转变 = 从读内部事件到只看外部物证 + 从硬断言到多维裁判 + 从绑 MA 到 universal adapter。共识基于 M1 投入不浪费（统一 runner）、两人互相说服（6 维、分位对齐、异源裁判等）、用户诉求为准（通用性、及格线、三方裁判）。

**交付待办**：
- [ ] team-lead 审阅本文档
- [ ] 确定 5 个决策点（§9）
- [ ] 分配 M2-a 实施人选（adapter + workspace + 单维 judge）

designer-a + designer-b · 2026-04-29

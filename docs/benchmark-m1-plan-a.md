# Benchmark Milestone 1 — 实现方案 A（planner-a）

> 目标：把 `docs/benchmark-design-final.md` 的 M1 范围（L0+L1+L2，共 70 道 YAML 任务，5 跑中位数 + 硬断言 + 简单软断言，输出分数报告）变成可执行的模块拆分与接口契约。
>
> 核心原则：**最大化复用 `test/e2e/helpers/`，benchmark 只负责调度 + 评分 + 报告**。
>
> **用户根本诉求回扣**：跑一遍出一个分数 + 诊断卡（哪一级卡住、哪道题扣分、下次比较涨没涨）。一切模块设计都服从这个目标。

---

## 0. M1 范围锁定

照搬设计文档 §10，只做这些：

| 项 | 是 | 否 |
|----|----|----|
| 题库 | L0×10 + L1×30 + L2×30 = **70** | L3/L4/L5 (41 道) |
| 配置 | **MA30B 一个** | Raw30B、MAClaude、AUS |
| 断言 | 硬断言全类型、软断言中"长度/计数/时长"三类 | LLM judge、6 维诊断、reference_match_ratio |
| 评分 | 任务分 + 级别分 + 总分 + 双门 gate + 5 跑中位数 + stability | AUS、LocalEdge、vs last run 差分 |
| 输出 | JSON + Markdown + ASCII dashboard | HTML 图表、趋势图、history.jsonl 追加 |
| CLI | `--all / --level / --task / --runs` | `--config raw|claude / --aus / --compare` |

> 说明：LLM judge、AUS、趋势图这些按设计文档都在 M2/M3。M1 产出是"能跑出一个分数能看是不是过 L2 gate"的 MVP，够用户做一次 agent 改动前后对照。

---

## 1. 目录结构（精确到文件）

```
test/benchmark/
  tasks/
    L0/L0-001-hello.yaml ...            # 10 files
    L1/L1-001-read-package.yaml ...     # 30 files
    L2/L2-001-change-readme-version.yaml ...  # 30 files

  runner/
    types.ts                 # §4 全部 interface
    task-loader.ts           # 扫 tasks/**/*.yaml + zod-ish 校验 → TaskDef[]
    task-runner.ts           # 单任务执行：setup fixture → runAgent → teardown → RawTaskOutcome
    assertions/
      hard.ts                # HardAssertion dispatcher + 所有 12 种类型实现
      soft.ts                # SoftAssertion dispatcher + 3 种类型（length / count / duration）
    scorer.ts                # score(T) score(L) totalScore 双门 gate final_level
    median.ts                # 5 跑中位数 + stability 计算
    reporter.ts              # JSON / Markdown / ASCII dashboard
    index.ts                 # Benchmark 入口：loadTasks → 按 level 调 task-runner → scorer → reporter

  cli/
    bench.ts                 # `npx tsx test/benchmark/cli/bench.ts --all` 入口，解析 flags 调 runner/index.ts

  fixtures/
    simple-node-project/     # 直接 symlink 到 test/e2e/fixtures/simple-node-project
    # 其他 fixture 按需新增（设计文档 §10.1 允许复用）

  reports/                   # gitignore，运行产物
    <run-id>/
      summary.json
      summary.md
      dashboard.txt
      per-task/<task-id>.json

  README.md                  # 使用文档：如何加题、如何跑、如何读报告
```

### 1.1 新增依赖

`package.json` 的 `devDependencies` 加：

- `yaml`（`eemeli/yaml`，MIT，零依赖）→ YAML 解析
- `zod`（MIT）→ schema 校验（可选；不引就手写 validator，推荐引，能省一大块样板）

M1 暂不引 `@anthropic-ai/sdk`（那是 M2 judge 用），保持依赖最小。

### 1.2 package.json scripts

```json
"benchmark": "tsx test/benchmark/cli/bench.ts",
"benchmark:smoke": "tsx test/benchmark/cli/bench.ts --level L0 --runs 1"
```

---

## 2. 模块拆分（最小独立单元）

每个模块独立成文件、独立可单测、入参出参都是纯数据结构（无副作用的模块禁止访问全局）。

### 2.1 模块清单与职责

| # | 模块 | 职责 | 输入 | 输出 | 副作用 |
|---|------|------|------|------|--------|
| M1 | `runner/types.ts` | 所有类型定义（interface、enum、type alias） | — | TS 类型 | 无 |
| M2 | `runner/task-loader.ts` | 读 `tasks/**/*.yaml`，YAML → `TaskDef`，带 schema 校验 | `tasksDir: string` | `TaskDef[]` + 错误列表 | 读磁盘 |
| M3 | `runner/assertions/hard.ts` | 12 种硬断言实现 + 分发器 | `HardAssertion[]`, `RunArtifact` | `HardAssertionResult[]` | 读磁盘（`file_content`/`exit_code` 需要） |
| M4 | `runner/assertions/soft.ts` | 3 种软断言实现 + 分发器 | `SoftAssertion[]`, `RunArtifact` | `SoftAssertionResult[]` | 无 |
| M5 | `runner/median.ts` | 5 跑结果 → 中位数 + stability | `TaskRunResult[]` (n=5) | `{ median, stability, runs }` | 无 |
| M6 | `runner/scorer.ts` | 任务分/级别分/总分 + 双门 gate + final_level | `TaskScore[]` + levelConfig | `LevelScore[]` + `BenchmarkScore` | 无 |
| M7 | `runner/task-runner.ts` | 单任务单次执行（setup→runAgent→assert→teardown） | `TaskDef`, `runNo: number` | `TaskRunResult` | 改 cwd、建临时目录、跑 agent |
| M8 | `runner/index.ts` | Benchmark 总调度：loadTasks → 按 level 串行 → 5 跑 → scorer → reporter | `RunOptions` | `BenchmarkReport` | 调 M2~M7 |
| M9 | `runner/reporter.ts` | BenchmarkReport → JSON + Markdown + ASCII dashboard | `BenchmarkReport`, `outDir` | 三个文件路径 | 写磁盘 |
| M10 | `cli/bench.ts` | 解析 argv → RunOptions → 调 M8 → exit code | `process.argv` | stdout + 文件 | 进程退出码 |

### 2.2 Wave 1 / Wave 2 切分（并行开发）

**Wave 1（可并行，纯函数或纯 IO 单点）**：M1, M2, M3, M4, M5, M6, M9。
- 全部不依赖 agent runtime，只靠 `RunArtifact` / `TaskDef` / `TaskRunResult` 类型契约
- 每个模块都能单独写 node:test 单测，不需要真实模型

**Wave 2（依赖 Wave 1，需要 agent）**：M7, M8, M10。
- M7 依赖 M3/M4（装配断言），需要真实 agent — 必须先等 M1~M4 定稿
- M8 依赖 M2/M5/M6/M7
- M10 依赖 M8

**依赖图**：

```
M1(types) ←── 所有其他模块都依赖
                                     ┌── M7 ──┐
M2(loader) ──────────────────────────┤        ├── M8 ── M10
M3(hard) ──┐                         │        │
M4(soft) ──┤                         │        │
           ├── (拼成 RunArtifact 消费) ┘        │
M5(median)─┤                                   │
M6(scorer)─┘                                   │
M9(reporter) ──────────────────────────────────┘
```

### 2.3 开发安排

- Wave 1：5 人并行领取 M2/M3/M4/M5/M6/M9（M1 由 team-lead 或 Wave 1 起手阶段先固化，其他人基于 M1 干活）
- Wave 2：M7 由测试熟悉 agent-runner 的人接（~1 人），M8+M10 一人接，题库 70 道由 1~2 人写 YAML（和 Wave 2 并行）

---

## 3. 复用映射（最重要的一节）

### 3.1 直接复用（0 改动）

| 现有文件 | 复用点 | 用途 |
|----------|--------|------|
| `test/e2e/helpers/agent-runner.ts`（`runAgent`） | 跑一次 agent 收集 events/finalText/toolCalls/elapsed | **M7 task-runner 的核心**，一行 `await runAgent(input, {cwd, timeout, configPath})` 拿到所有数据 |
| `test/e2e/helpers/assertions.ts`（`hasLlmError`, `assertChineseMin`, `assertNoHtmlLeak`） | 成品断言函数 | M3 hard assertion 里 `no_error_5xx`、`no_html_leak`（横切）直接 import 调 |
| `test/e2e/fixtures/simple-node-project/` | 现成 fixture（package.json `name=test-project`、`react 19`、`src/index.js` 含 `useState`） | 70 道题里大部分 L0/L1 直接用这个 fixture，symlink 过去 |
| `src/index.ts`（`bootstrap`, `shutdown`） | 通过 `runAgent` 间接用 | 不直接 import |
| `src/agent/events.ts`（`AgentEvent`） | 类型复用 | M1 types.ts 的 `RunArtifact` 直接引用这里的 `AgentEvent` |

### 3.2 改造后复用

| 现有文件 | 现状 | 改造点 |
|----------|------|--------|
| `test/e2e/helpers/agent-runner.ts` | `RunResult` 已返回 events/finalText/toolCalls/apiCalls/elapsed | **不改代码**，但 M1 的 `RunArtifact` 直接沿用 `RunResult` 字段，再加 2 个 benchmark 专属字段（`stdoutTail?: string`, `runNo: number`），在 M7 里包一层 adapter |
| `test/e2e/fixtures/simple-node-project/` | 只有 `package.json + README.md + src/{index,utils}.js` | 某些 L2 任务需要修改版（比如 README 含 `VERSION: 1.0.0`）—— 不直接改 fixture，改用**按任务 setup 命令初始化临时 cwd**（YAML 里 `fixture.setup` 字段，见 §5） |

### 3.3 全新写（M1 新增代码）

- `runner/` 目录全部 10 个文件
- 70 道 YAML 任务（§6）
- `cli/bench.ts`
- `README.md`

### 3.4 禁止复用的

- `test/e2e/helpers/fetch-llm.ts` — 这是 L1 裸 HTTP，benchmark 走 agent 全流程，不碰裸 HTTP。
- `test/e2e/helpers/pty.ts` — L5 才可能要 PTY，M1 不涉及。
- `test/cases/README.md` 里的 20 条 case — 参考用，不直接用；Case 1~3/5/6/7/8/11/12 作为 L2 多轮任务的**素材来源**，见 §6.3。

---

## 4. 接口契约（TypeScript interface）

> 放在 `test/benchmark/runner/types.ts`。所有模块间通信只通过这里的类型。

### 4.1 任务定义（TaskDef）— YAML 的 TS 投射

```ts
import type { AgentEvent } from '../../../src/agent/events.js';

export type Level = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export interface TaskDef {
  id: string;                        // e.g. "L2-003"
  title: string;
  level: Level;
  category: string;                  // 统计用，例 "file-edit" / "read-file"
  weight: number;                    // 默认 1.0
  fixture: FixtureSpec;
  userInput: string;                 // 单轮任务用
  rounds?: RoundSpec[];              // 多轮任务（L2+）
  hardAssertions: HardAssertion[];
  softAssertions: SoftAssertion[];
  runtime: RuntimeSpec;
  reference?: ReferenceSpec;         // M1 用于算 soft，但不算 baseline
  sourcePath: string;                // 绝对路径，供报错
}

export interface FixtureSpec {
  project: string;                   // fixture 名，对应 test/benchmark/fixtures/<name>
  setup?: string[];                  // shell 命令，在 tmp cwd 里执行初始化
}

export interface RoundSpec {
  user: string;
  expect?: {
    tool_calls_include?: string[];   // 该轮至少调一次这些工具
  };
}

export interface RuntimeSpec {
  timeoutSec: number;                // 单次跑上限，默认 180
  runs: number;                      // 5-run median，默认 5，L0 可降到 1
  maxRounds: number | null;          // null 表示不设额外上限
  layer: 'L1' | 'L2';                // M1 只支持 L1/L2
}

export interface ReferenceSpec {
  referenceRounds?: number;
  humanTimeSec?: number;
  claudeCodeScore?: number;          // M1 仅记录，不参与计算
}
```

### 4.2 硬断言（HardAssertion）

```ts
export type HardAssertion =
  | { type: 'tool_called';        tool?: string; toolMatches?: string; argsContains?: Record<string, unknown>; argsMatches?: Record<string, string>; }
  | { type: 'tool_not_called';    tool?: string; toolMatches?: string; }
  | { type: 'tool_retry_max';     maxSameError: number; }
  | { type: 'file_content';       path: string; contains?: string; notContains?: string; regex?: string; exact?: string; }
  | { type: 'file_exists';        path: string; }
  | { type: 'not_file_modified';  path: string; }
  | { type: 'no_error_5xx' }
  | { type: 'final_text_contains'; contains?: string; regex?: string; minChineseChars?: number; }
  | { type: 'final_text_min_chars'; chars: number; chinese?: boolean; }
  | { type: 'event_sequence';     sequence: string[]; }     // e.g. ["tool:call","tool:result","task:done"]
  | { type: 'messages_count_max'; max: number; }
  | { type: 'exit_code';          cmd: string; code: number; };

export interface HardAssertionResult {
  assertion: HardAssertion;
  passed: boolean;
  reason?: string;                   // 失败原因，通过时留空
}
```

**实现备注**：
- `tool_called.toolMatches` 支持 regex 如 `"fs(-edit)?__(write|edit)_file"`，对应设计文档 §3.1 示例
- `exit_code` 在 task teardown 后在 cwd 里跑命令（例如 `npm test`），此条 M1 可选实现
- `no_error_5xx` 复用 `test/e2e/helpers/assertions.ts::hasLlmError` 的正则

### 4.3 软断言（SoftAssertion）

M1 只实现这 3 种（设计文档 §3.2 的子集，不做 `llm_judge` 和 `reference_match_ratio`）：

```ts
export type SoftAssertion =
  | { type: 'final_text_min_len';  chars: number;    weight: number; }
  | { type: 'tool_call_count_max'; max: number;      weight: number; }
  | { type: 'duration_max';        maxMs: number;    weight: number; };

export interface SoftAssertionResult {
  assertion: SoftAssertion;
  score: number;                     // [0,1]
  weight: number;
}
```

### 4.4 运行产物（RunArtifact）

`agent-runner.ts::RunResult` 的超集 —— M7 里把 `runAgent` 的返回塞进来再包一层。

```ts
export interface RunArtifact {
  // 来自 runAgent
  events: AgentEvent[];
  finalText: string;
  toolCalls: Array<{ name: string; args: unknown; ok: boolean }>;
  apiCalls: number;
  elapsed: number;                   // ms

  // benchmark 专属
  runNo: number;                     // 1..N
  cwdSnapshot: string;               // 跑完后的临时 cwd 绝对路径（给 file_content 断言用）
  crashed: boolean;                  // timeout / exception → true
  crashReason?: string;
}
```

### 4.5 分数层

```ts
export interface TaskRunResult {
  taskId: string;
  runNo: number;
  artifact: RunArtifact;
  hardResults: HardAssertionResult[];
  softResults: SoftAssertionResult[];
  hardPass: boolean;                 // ∀ hardResults.passed
  softScore: number;                 // Σ(result.score × weight) / Σ(weight)
  taskScore: number;                 // hardPass × (0.6 + 0.4 × softScore)
}

export interface TaskScore {
  taskId: string;
  level: Level;
  weight: number;
  median: number;                    // 5 跑中位数
  stability: number;                 // 1 - std
  runs: TaskRunResult[];
  hardPassRate: number;              // 5 跑中 hardPass=true 的比例
}

export interface LevelScore {
  level: Level;
  score: number;                     // Σ(w × median) / Σw
  hardPassRate: number;              // 级别内 hardPass 的题数 / 总题数（取每题的 median 跑那次的 hardPass）
  gateOk: boolean;                   // (score ≥ cutoff) ∧ (hardPassRate ≥ rate)
  cutoff: number;
  rateGate: number;
  weight: number;                    // α, e.g. L1=15 L2=20
  taskCount: number;
}

export interface BenchmarkScore {
  total: number;                     // Σ(α × levelScore)，只算 gateOk 级别
  level: number;                     // final_level + 0.xx (decimal progress)
  byLevel: Record<Level, LevelScore>;
  invalid: boolean;                  // L0 任何一题不 pass → true
  invalidReason?: string;
}
```

### 4.6 最终报告（BenchmarkReport）

```ts
export interface BenchmarkReport {
  runId: string;                     // ISO + short hash
  timestamp: number;
  config: {
    agentVersion: string;            // 读 package.json
    modelBaseURL: string;            // 读 ~/.my-agent/config.json
    modelName: string;
    cwd: string;
    selectedLevel?: Level;           // --level 时填
    selectedTask?: string;
  };
  score: BenchmarkScore;
  tasks: TaskScore[];
  weakest: Array<{ taskId: string; median: number; reasons: string[] }>;  // median < 0.5 的前 N 条
  durationMs: number;
}
```

### 4.7 运行入口（RunOptions）

```ts
export interface RunOptions {
  level?: Level;                     // --level L2
  taskId?: string;                   // --task L2-003
  runs?: number;                     // override 所有任务的 runs
  tasksDir?: string;                 // 默认 test/benchmark/tasks
  reportsDir?: string;               // 默认 test/benchmark/reports
  failFast?: boolean;                // L0 失败立即停
}
```

---

## 5. YAML schema（基于设计文档 §3，收窄到 M1 能解析的）

```yaml
# 必填
id: L2-003                           # 正则 ^L[0-5]-\d{3}$
title: Change README version number
level: L2                            # L0|L1|L2|L3|L4|L5
category: file-edit
weight: 1.0                          # 默认 1.0
user_input: |
  Change the version in README to 2.0.0

# 环境
fixture:
  project: simple-node-project       # 对应 test/benchmark/fixtures/<name>
  setup:                             # 可选，shell 命令列表，在 copy 出的 tmp cwd 里跑
    - echo "VERSION: 1.0.0" > README.md

# 多轮（L2+ 可选）
rounds:
  - user: "Change the version in README to 2.0.0"
    expect:
      tool_calls_include: ["fs__read_file"]

# 硬断言
hard_assertions:
  - type: tool_called
    tool: fs__read_file
    args_contains:
      path: README.md
  - type: tool_called
    tool_matches: "fs(-edit)?__(write|edit)_file"
  - type: file_content
    path: README.md
    contains: "VERSION: 2.0.0"
    not_contains: "VERSION: 1.0.0"
  - type: no_error_5xx
  - type: tool_retry_max
    max_same_error: 2

# 软断言
soft_assertions:
  - type: final_text_min_len
    chars: 20
    weight: 0.3
  - type: tool_call_count_max
    max: 3
    weight: 0.3
  - type: duration_max
    max_ms: 60000
    weight: 0.4

# 运行时
runtime:
  timeout_sec: 120
  runs: 5                            # L0 可改 1，L2 用 5
  max_rounds: null
  layer: L2                          # L0/L1 可用 L1（仅裸 API，无 agent loop）

# 参考（M1 仅记录）
reference:
  claude_code_score: 0.95
  reference_rounds: 3
```

**M1 相比设计文档 §3 的差异**：
- 砍掉 `dim_weights`（6 维打分是 M2 特性）
- 软断言从 6 种 → 3 种（砍掉 `token_usage_max`、`llm_judge`、`reference_match_ratio`）

**解析规则**：
- camelCase / snake_case 都接受（`max_same_error` 与 `maxSameError` 等价）—— `task-loader.ts` 里做 key 规整
- 硬断言 `no_error_5xx` 之类无参数类型可简写为 `- type: no_error_5xx`
- 如果 YAML 缺失必填字段，`task-loader.ts` 不抛异常，而是累计到错误列表由 M8 在 run 开始前一起打出（避免跑完 1 小时才报一个 YAML 错）

---

## 6. 70 道题库来源映射

### 6.1 L0 Connectivity（10 道）

全部按**设计文档 §4.2 表格一一对应**新写 YAML。fixture 清一色用 `simple-node-project`。

| ID | user_input | 核心硬断言 | 来源 |
|----|-----------|-----------|------|
| L0-001 | "Hello" | `final_text_min_chars` chars=1 | 新 |
| L0-002 | "1+1=" | `final_text_contains` contains="2" | 新 |
| L0-003 | "列出当前目录" | `tool_called` fs__list_directory | 借鉴 `e2e/agent/project-analysis.test.ts::S1.1` |
| L0-004 | "读 package.json" | `tool_called` fs__read_file | `test/cases/README.md` Case 3 |
| L0-005 | "跑 `echo hello`" | `tool_called` exec__execute_command | Case 5 的极简版 |
| L0-006 | "在 src/ 里搜 'useState'" | `tool_called` grep__* | `e2e-test-plan.md` S4.1 |
| L0-007 | "在 /tmp/ 新建 test.txt 内容 'test'" | `tool_called` fs(-edit)?__write_file + `file_content` | Case 9 |
| L0-008 | "改 config.json: port 改 8080" | `tool_called` fs-edit__* + `file_content` | 新（setup 写入初始 config.json） |
| L0-009 | "加个 todo: review PR" | `tool_called` todo_write | 新（需确认内置是否有 todo MCP，若无则删掉 L0-009 或换成另一 fs 任务） |
| L0-010 | `"A".repeat(10000)` | `final_text_min_chars` chars=1 + `messages_count_max` max=20 | 压测型新写 |

> **待确认**：todo_write 工具是否内置。快速查 `src/init.ts` 或 `config.json.dist`，若不在默认 5 个 MCP（exec/fs/fs-edit/grep/web）里，L0-009 改成"运行 `node -v`"。

### 6.2 L1 Stable Tool Calls（30 道）

按设计文档 §4.3 分布：

| 类别 | 数 | ID 范围 | 主要来源 |
|------|----|---------|----------|
| Read file | 6 | L1-001 ~ L1-006 | Case 3/7 + `e2e/api/tool-use.test.ts` S1.1 |
| Write file | 4 | L1-007 ~ L1-010 | Case 9/13 |
| List directory | 4 | L1-011 ~ L1-014 | Case 1/3 |
| Execute command | 6 | L1-015 ~ L1-020 | Case 5/6/15 |
| Search | 4 | L1-021 ~ L1-024 | S4.1 + Case 8 |
| Should NOT call tool | 4 | L1-025 ~ L1-028 | Case 12 |
| Tool name tolerance | 2 | L1-029 ~ L1-030 | 新写（引号/相对路径变体） |

每题都是**单轮、单工具、硬断言至少 3 条**（tool_called + final_text_min_chars + no_error_5xx），fixture 一律用 `simple-node-project`。

### 6.3 L2 Multi-turn Work（30 道）

按设计文档 §4.4 分布：

| 类别 | 数 | ID 范围 | 主要来源 |
|------|----|---------|----------|
| Read-modify-write | 6 | L2-001 ~ L2-006 | Case 4 + e2e-test-plan S2.3 |
| Multi-turn follow-up | 6 | L2-007 ~ L2-012 | Case 1/2/3 + `e2e/agent/project-analysis.test.ts::S1.2` |
| Error recovery | 4 | L2-013 ~ L2-016 | Case 11 + `e2e/agent/error-recovery.test.ts::S5.1/S5.5` |
| Command failure | 3 | L2-017 ~ L2-019 | e2e-test-plan S3.2 |
| Multi-step task | 5 | L2-020 ~ L2-024 | Case 5/10/14 + e2e-test-plan S1.3 |
| Context persistence | 4 | L2-025 ~ L2-028 | `e2e/agent/context.test.ts::S6.1/S6.2` |
| Empty answer self-rescue | 2 | L2-029 ~ L2-030 | `e2e/agent/error-recovery.test.ts::S5.3` |

**关键复用**：
- `e2e/agent/context.test.ts::S6.2` 是一个 3 轮对话+引用 round1 事实的现成断言，L2-027 直接把 user/轮次/断言抄进 YAML
- `e2e/agent/error-recovery.test.ts::S5.1` 的 `toolCalls 按 args key 去重 ≤ 3 次` → 映射为硬断言 `tool_retry_max maxSameError=2`
- `e2e/agent/error-recovery.test.ts::S5.3` 的 nudge 日志检测 → M1 暂不做（需要 MA_DEBUG 日志解析），改为软断言 `final_text_min_len`，M2 再升级

### 6.4 fixture 策略

- **默认 fixture**：所有 70 道题的 fixture.project 默认 `simple-node-project` — 在 M7 task-runner 里把原始 fixture copy 到 `os.tmpdir()/benchmark-<runId>-<taskId>-<runNo>/` 再跑，保证跑完可 rm、5 跑之间互不污染
- **setup 命令**：对需要额外预置状态的任务（如 L2-001 需要 README 里有 `VERSION: 1.0.0`），在 YAML 里写 `fixture.setup: ["echo 'VERSION: 1.0.0' > README.md"]`，task-runner copy 完 fixture 再在 tmp cwd 跑 setup
- **不新增 fixture 项目**：M1 全部用 `simple-node-project`。M2 再引入 `empty-project` / `big-project` 等（对应 `e2e-test-plan.md` §3 的规划）

---

## 7. 关键算法（M5/M6 细节）

### 7.1 5 跑中位数（M5）

```ts
export function medianScore(runs: TaskRunResult[]): number {
  const scores = runs.map(r => r.taskScore).sort((a, b) => a - b);
  const n = scores.length;
  return n % 2 === 1 ? scores[(n - 1) / 2] : (scores[n / 2 - 1] + scores[n / 2]) / 2;
}

export function stability(runs: TaskRunResult[]): number {
  const scores = runs.map(r => r.taskScore);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length;
  return Math.max(0, 1 - Math.sqrt(variance));
}
```

### 7.2 任务分（M6）

```ts
// 单跑
taskScore = (hardPass ? 1 : 0) * (0.6 + 0.4 * softScore)

// softScore = Σ(result.score × weight) / Σweight，无软断言则 0
// 无硬断言则 hardPass = true
```

### 7.3 级别分 + 双门 gate（M6）

```ts
// 级别内
score(L) = Σ(w_T × median(T)) / Σ(w_T)
hardPassRate(L) = |{T : median_run_of_T.hardPass}| / |L|

// gate
pass(L) = (score(L) ≥ cutoff_L) ∧ (hardPassRate(L) ≥ rateGate_L)

// 常量表（对应设计文档 §1）
const LEVEL_CONFIG = {
  L0: { cutoff: 1.0,  rateGate: 1.0,  weight: 0  },
  L1: { cutoff: 0.75, rateGate: 0.90, weight: 15 },
  L2: { cutoff: 0.65, rateGate: 0.80, weight: 20 },
  L3: { cutoff: 0.55, rateGate: 0.70, weight: 25 },
  L4: { cutoff: 0.45, rateGate: 0.60, weight: 25 },
  L5: { cutoff: 0.40, rateGate: 0.50, weight: 15 },
};
```

**M1 简化**：L3/L4/L5 不出现（70 题不覆盖），`LEVEL_CONFIG` 里 L3+ 的条目保留但 `byLevel[L3..L5]` 在报告里标为 `locked`，不参与总分。

### 7.4 总分

```ts
total = Σ(L.weight × score(L)) for L where allPreviousGatesOk(L)
// 如果 L1 gate 不过，L2 分不计入；全部过则 total = 15×L1 + 20×L2 = 35 (满分)
// L0 gateOk=false → invalid=true, total=null
```

### 7.5 final_level

```ts
let level = 0;
for (const L of ['L0','L1','L2']) {
  if (byLevel[L].gateOk) level = parseInt(L.slice(1));
  else break;
}
const nextL = `L${level + 1}` as Level;
const decimal = byLevel[nextL]?.hardPassRate ?? 0;
final_level = level + decimal;
```

### 7.6 L0 invalid

设计文档 §11.7 红线：L0 任何一题不 pass → `invalid: true`，整个报告打 `invalid_run` 标记，但**继续完成评分**（便于诊断哪道 L0 挂了），只是总分和 level 不展示。

---

## 8. 硬断言分发器（M3 细节）

`assertions/hard.ts` 伪代码：

```ts
export function evaluateHard(
  assertions: HardAssertion[],
  artifact: RunArtifact,
  cwd: string
): HardAssertionResult[] {
  return assertions.map(a => {
    try {
      switch (a.type) {
        case 'tool_called':        return checkToolCalled(a, artifact);
        case 'tool_not_called':    return checkToolNotCalled(a, artifact);
        case 'tool_retry_max':     return checkRetryMax(a, artifact);
        case 'file_content':       return checkFileContent(a, cwd);
        case 'file_exists':        return checkFileExists(a, cwd);
        case 'not_file_modified':  return checkFileUnmodified(a, cwd);
        case 'no_error_5xx':       return checkNoError5xx(artifact);
        case 'final_text_contains':return checkFinalTextContains(a, artifact);
        case 'final_text_min_chars':return checkFinalTextMinChars(a, artifact);
        case 'event_sequence':     return checkEventSequence(a, artifact);
        case 'messages_count_max': return checkMessagesCountMax(a, artifact);
        case 'exit_code':          return checkExitCode(a, cwd);
      }
    } catch (e) {
      return { assertion: a, passed: false, reason: `exception: ${(e as Error).message}` };
    }
  });
}
```

关键几条的实现提示：

- `checkToolCalled`：遍历 `artifact.toolCalls`，匹配 `tool` 严格相等或 `toolMatches` regex，再看 `argsContains` 是否子集、`argsMatches` 是否每个值都 regex match；命中任一次即 pass
- `checkRetryMax`：`Map<string, number>`，key = `${name}:${JSON.stringify(args)}`，计数同一 key 出现次数，任何 key 超过 `maxSameError + 1` → fail（设计文档 §3.1 的语义）
- `checkFileContent`：在 cwd 下读文件，先 `contains`（若有）再 `notContains`（若有）再 `regex`（若有）再 `exact`（若有）
- `checkNoError5xx`：扫 `events.filter(e => e.type === 'tool:result' && !e.ok)` 的 content 看是否含 5xx / `[error]` / `Internal Server Error`（直接用 `test/e2e/helpers/assertions.ts::hasLlmError`）
- `checkEventSequence`：对 `artifact.events.map(e => e.type)` 做子序列匹配（按顺序出现即可，中间允许插其他事件）
- `checkExitCode`：M1 如果时间紧可 stub 成永远 pass + warn，M2 补；建议先实现，几行 `execSync` 的事

---

## 9. 软断言分发器（M4 细节）

```ts
export function evaluateSoft(
  assertions: SoftAssertion[],
  artifact: RunArtifact
): SoftAssertionResult[] {
  return assertions.map(a => {
    switch (a.type) {
      case 'final_text_min_len': {
        const chars = a.chars;
        const actual = artifact.finalText.length;
        return { assertion: a, weight: a.weight, score: Math.min(1, actual / chars) };
      }
      case 'tool_call_count_max': {
        const actual = artifact.toolCalls.length;
        return { assertion: a, weight: a.weight, score: actual === 0 ? 0 : Math.min(1, a.max / actual) };
      }
      case 'duration_max': {
        return { assertion: a, weight: a.weight, score: Math.min(1, a.maxMs / artifact.elapsed) };
      }
    }
  });
}

export function softScoreOf(results: SoftAssertionResult[]): number {
  if (results.length === 0) return 0;
  const totW = results.reduce((s, r) => s + r.weight, 0);
  if (totW === 0) return 0;
  return results.reduce((s, r) => s + r.score * r.weight, 0) / totW;
}
```

---

## 10. 任务执行器（M7 细节）

```ts
export async function runTaskOnce(
  task: TaskDef,
  runNo: number,
  ctx: { tasksDir: string; reportsDir: string }
): Promise<TaskRunResult> {
  // 1. 准备 tmp cwd（copy fixture）
  const tmp = await prepareTmpCwd(task.fixture.project, task.id, runNo);

  // 2. 跑 setup 命令
  for (const cmd of task.fixture.setup ?? []) {
    execSync(cmd, { cwd: tmp, stdio: 'pipe' });
  }

  // 3. 跑 agent（复用 runAgent）
  let artifact: RunArtifact;
  try {
    const r = await runAgent(task.userInput, {
      cwd: tmp,
      timeout: task.runtime.timeoutSec * 1000,
    });
    artifact = { ...r, runNo, cwdSnapshot: tmp, crashed: false };
  } catch (e) {
    artifact = {
      events: [], finalText: '', toolCalls: [], apiCalls: 0, elapsed: 0,
      runNo, cwdSnapshot: tmp, crashed: true,
      crashReason: (e as Error).message,
    };
  }

  // 4. 多轮（rounds）处理：M1 暂时串行重复调用 agent.chat
  //    注意 runAgent 会 bootstrap/shutdown 每次，需要改成外层 bootstrap + 内层多轮
  //    → M1 把多轮版拆成 runAgentMultiRound() 放进 task-runner.ts（或 helpers 扩一个函数）

  // 5. 断言
  const hardResults = evaluateHard(task.hardAssertions, artifact, tmp);
  const softResults = evaluateSoft(task.softAssertions, artifact);
  const hardPass = hardResults.every(r => r.passed);
  const softScore = softScoreOf(softResults);
  const taskScore = (hardPass ? 1 : 0) * (0.6 + 0.4 * softScore);

  // 6. teardown（删 tmp cwd；保留 artifact 给 reporter）
  //    每道 per-task 目录里仅存 events 切片（压缩）避免磁盘膨胀

  return { taskId: task.id, runNo, artifact, hardResults, softResults, hardPass, softScore, taskScore };
}
```

**多轮任务的处理**：`runAgent` 现在的实现是一次 bootstrap + 一次 chat + shutdown，不能直接处理 `rounds: [...]`。两条路：

1. **推荐（M1 做）**：在 `test/e2e/helpers/agent-runner.ts` 新增 `runAgentMultiRound(rounds, opts): Promise<RunArtifact>`，复用 `bootstrap`/`shutdown` 流程，循环调 `agent.chat`，把所有轮的 events 合并。现有 `agent-runner.ts` 不动，新增不 breaking。
2. **如果不想动 helpers**：把 M1 的多轮能力内联在 `task-runner.ts` 里（直接 import `bootstrap` / `shutdown` / `agent.chat`），接口照抄 `runAgent`。

选方案 1，保留 helpers 的扩展性。改动到 helpers 的 diff 是纯新增，不影响现有 L2 e2e 测试。

---

## 11. 报告器（M9 细节）

### 11.1 summary.json

直接把 `BenchmarkReport` `JSON.stringify(…, null, 2)` 落盘。

### 11.2 summary.md

```markdown
# MA Benchmark Report — <runId>

| | |
|---|---|
| Agent | MA v2.0.0 |
| Model | qwen/qwen3.6-35b-a3b @ http://192.168.21.5:1234 |
| Total | **35.2 / 35** (L1+L2 满分) |
| Level | L2.0 / 5.0 |
| Duration | 42m 11s |

## Levels

| L | Score | HardPass% | Gate | α |
|---|-------|-----------|------|---|
| L0 | 1.00 | 100% | ✓ | 0 |
| L1 | 0.88 | 93% | ✓ | 15 |
| L2 | 0.72 | 80% | ✓ | 20 |

## Weakest Tasks

| ID | Median | Reasons |
|----|--------|---------|
| L2-017 | 0.12 | command_failure 无限 retry |
| L2-029 | 0.30 | final_text 空 |

## Per-task (preview — full JSON in summary.json)
...
```

### 11.3 dashboard.txt

ASCII dashboard 格式照搬设计文档 §8.1（砍掉 M1 不支持的行：AUS/LocalEdge/vs Last Run/Dimensions 留作 TODO 注释）。

---

## 12. CLI 入口（M10）

```bash
tsx test/benchmark/cli/bench.ts --all            # 跑全部 L0+L1+L2
tsx test/benchmark/cli/bench.ts --level L2       # 只跑 L2
tsx test/benchmark/cli/bench.ts --task L2-003    # 只跑单题
tsx test/benchmark/cli/bench.ts --all --runs 1   # 每题只跑 1 次（快速 smoke）
```

`bench.ts` 用 `commander`（现成依赖）解析 flags，调 `runBenchmark(opts: RunOptions)`。
退出码：
- `0`：所有选中级别 `gateOk=true`
- `1`：有级别 gate fail 但未 invalid
- `2`：invalid_run（L0 挂）
- `99`：runtime exception

---

## 13. 执行顺序（Wave 细化）

### Wave 1（并行，~1-2 天）

| 人员 | 模块 | 产出 |
|------|------|------|
| A | M1 types.ts（先交付，1h） + M2 task-loader.ts + 3 个 loader 单测 | 类型就绪、能 parse 70 个 YAML（此时 YAML 可由 leader 或另一人写 mock 版） |
| B | M3 hard.ts（12 种断言） + 单测（每种 ≥ 1 条） | 跑一个人造 RunArtifact 能输出 HardAssertionResult[] |
| C | M4 soft.ts（3 种） + 单测 | 同上，output SoftAssertionResult[] |
| D | M5 median.ts + M6 scorer.ts + 单测 | 输入人造 TaskRunResult → 输出 BenchmarkScore |
| E | M9 reporter.ts + 单测 | 输入人造 BenchmarkReport → 输出 3 个文件 |

### Wave 2（串行 + 并行，~2-3 天）

| 人员 | 模块 |
|------|------|
| F | 在 `helpers/agent-runner.ts` 加 `runAgentMultiRound` + 单测（用 simple-node-project） |
| F | M7 task-runner.ts（依赖 F 的 runAgentMultiRound + M3 + M4） |
| F | M8 index.ts |
| F | M10 cli/bench.ts |
| G（并行） | 写 70 道 YAML（Wave 1 结束后即可开始） |

### 里程碑验收

1. **Wave 1 完工**：所有 M1~M6、M9 单测绿；不依赖真实模型即可跑完
2. **Wave 2 完工**：`npx tsx test/benchmark/cli/bench.ts --level L0 --runs 1` 能输出 summary.md
3. **M1 交付**：`--all` 跑完输出完整报告，并且 70 道题里至少 L0 全过、L1/L2 有分数（分数不要求满分，要求能量化当前 agent 水平）

---

## 14. 风险清单

| 风险 | 影响 | 缓解 |
|------|------|------|
| runAgent 每次 bootstrap/shutdown 耗时 12s+，70 题 × 5 跑 = 350 次 = ~70 min overhead | M1 一次 run 太慢 | `runAgentMultiRound` 把多轮合并；单轮任务接受这开销，反正 L0 只跑 1 次 |
| YAML 70 道靠人写，容易出字段错 | CI 红 | task-loader 强校验；先写 5 道跑通再批量生 |
| `execSync` 跑 setup 命令可能阻塞或破坏宿主 | 安全 | fixture.setup 明确注明"仅限当前 tmp cwd 内命令"；在 review 阶段 check YAML |
| `tool_retry_max` 的语义在不同 MCP 下不一致（args 精确匹配 vs 模糊） | 假阳/阴 | 先按"args JSON 严格相等"实现，不 match 的算不同 call；与 `e2e/agent/error-recovery.test.ts::S5.1` 的口径对齐 |
| 5 跑中位数对本地 Qwen3 可能不够（某些题 5 跑 bimodal） | 稳定性低 | stability 输出 per-task，M2 加大 runs 或引 quorum（设计文档 §6.2 已注明） |
| L0-009 todo_write 不在默认 MCP | 题目跑不了 | 在 YAML 评审时统一检查；不在就换题 |

---

## 15. 非目标（明确砍掉的）

- **AUS / Raw30B / MAClaude 三配置**：M3 做
- **LLM-as-judge**：M2 做
- **6 维打分（ToolAcc/TaskDone/...）**：M2 做（M1 的 hard/soft 二元制足够给出一个分数）
- **趋势图 / history.jsonl / PR 评论机器人**：M3 做
- **L3/L4/L5 题**：M2/M3 做
- **fault-injection MCP 和 500 proxy**：不在 M1 范围，L2 错误恢复用"读不存在文件"这种天然失败即可
- **多模型并行对比**：M3+ 做

---

## 16. 交付清单（M1 end-state）

1. `test/benchmark/` 目录齐全：runner（10 文件）+ cli（1 文件）+ tasks（70 YAML）+ fixtures（symlink）
2. `package.json` scripts: `benchmark`, `benchmark:smoke`
3. 所有 Wave 1 模块带 node:test 单测
4. Wave 2 集成测试：`benchmark --level L0 --runs 1` 跑绿
5. README.md：说明如何加题、如何解读报告
6. 一次 end-to-end 真实跑（MA v2.0 + 本地 Qwen3）产出 `reports/<runId>/summary.md`，附在 PR 里
7. L2 gate 是否通过：以实际跑出的数据为准，不提前承诺分数

---

**北极星回扣**：M1 end-state 用户跑一行 `npm run benchmark` ，~40 min 后得到一个 `summary.md`，看得到"我们当前在 L2.x 级别，卡在哪几道"，为后续 agent 优化提供基线数据。这就是 M1 的全部目标，其他都是噪音。

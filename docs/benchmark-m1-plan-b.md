# Benchmark Milestone 1 实现方案（Plan B）

> 基于 `benchmark-design-final.md` 批准设计，对照现有代码事实产出的可执行实现方案。
>
> **M1 范围**：L0 (10) + L1 (30) + L2 (30) = **70 道 YAML 任务** + Runner + 硬/软断言 + 5-run 中位数 + ASCII/JSON 报告。
> **M1 不包含**：LLM-as-judge、Raw30B/MAClaude 配置、AUS、趋势跟踪、L3–L5（留给 M2/M3）。
>
> 最终目标一句话：`npm run benchmark` 跑一遍，得到 `Score + Level + 诊断卡`，告诉用户 MA agent 在本地 30B 模型上到底卡在哪里。

---

## 1. 模块拆分（Wave 切分）

所有模块按"可独立单测 → 业务组装 → 入口"三层切，严格遵循 Wave 1 纯函数先行。

### Wave 1（5 个原子模块，互相无依赖，可 5 人并行开发）

| # | 模块 | 文件 | 职责 | 输入 | 输出 |
|---|------|------|------|------|------|
| W1-1 | **task-loader** | `test/benchmark/runner/task-loader.ts` | 读 YAML → 校验 schema → 返回 `TaskDef[]` | 任务目录路径 | `TaskDef[]`（见 §4） |
| W1-2 | **fixture-manager** | `test/benchmark/runner/fixture-manager.ts` | 拷贝 fixture 到临时目录 + 执行 `setup` 脚本 + 返回 cwd + 清理 | `{ project, setup[] }` | `{ cwd, cleanup() }` |
| W1-3 | **event-collector** | `test/benchmark/runner/event-collector.ts` | 订阅 `AsyncGenerator<AgentEvent>` → 归集到 `RunTrace`（含 toolCalls / finalText / thinking 区间 / timings） | `AsyncGenerator<AgentEvent>` | `RunTrace`（见 §4） |
| W1-4 | **hard-assertions** | `test/benchmark/runner/assertions/hard.ts` | 实现 §3.1 所有硬断言类型，输入 `RunTrace + cwd`，输出 `AssertionResult[]` | `TaskDef.hard_assertions`, `RunTrace`, `cwd` | `AssertionResult[]`（pass/fail + 原因） |
| W1-5 | **soft-assertions** | `test/benchmark/runner/assertions/soft.ts` | 实现 §3.2 **M1 仅需 3 种非 LLM 类型**（`final_text_min_len` / `tool_call_count_max` / `duration_max`），其它类型 M2 再加 | `TaskDef.soft_assertions`, `RunTrace` | `SoftScore[]` (0–1) |

### Wave 2（3 个业务模块，依赖 Wave 1）

| # | 模块 | 文件 | 职责 | 依赖 |
|---|------|------|------|------|
| W2-1 | **scorer** | `test/benchmark/runner/scorer.ts` | 把 `AssertionResult[]` + `SoftScore[]` → `TaskScore`；多 run 取中位数 + 稳定性；Level 聚合；dual gate | hard/soft |
| W2-2 | **task-runner** | `test/benchmark/runner/task-runner.ts` | 单任务入口：setup → 启动 agent → 采集 trace → 断言 → 评分 → cleanup | fixture-manager / event-collector / hard / soft / scorer / **`bootstrap` from `src/index.ts`** |
| W2-3 | **reporter** | `test/benchmark/runner/reporter.ts` | 生成 ASCII dashboard + JSON summary + per-task JSON | scorer |

### Wave 3（1 个入口，依赖 Wave 2 全部）

| # | 模块 | 文件 | 职责 |
|---|------|------|------|
| W3-1 | **index (entry)** | `test/benchmark/runner/index.ts` | CLI 参数解析 + 编排 `--level/--task/--dry-run` + 写入报告目录 |

### Wave 4（内容，和开发并行）

| # | 产物 | 路径 | 数量 | 来源 |
|---|------|------|------|------|
| W4-1 | L0 YAML | `test/benchmark/tasks/L0/*.yaml` | 10 | 设计文档 §4.2 表格 1:1 翻译 |
| W4-2 | L1 YAML | `test/benchmark/tasks/L1/*.yaml` | 30 | 设计文档 §4.3 七大类别 + `test/cases/README.md` case 1/4/5/6/8/9/12/15 改编 |
| W4-3 | L2 YAML | `test/benchmark/tasks/L2/*.yaml` | 30 | 设计文档 §4.4 七大类别 + `test/cases/README.md` case 1/2/3/4/5/7/8/10/11/20 改编 |
| W4-4 | 新 fixture | `test/benchmark/fixtures/` | 按需 | 复用 `test/e2e/fixtures/simple-node-project/`；需 `multi-file-project`、`with-tests-project` 两个补充 fixture |

### 依赖关系图

```
          Wave 1 并行开发（5 人）
 ┌──────────┬──────────┬──────────┬──────────┬──────────┐
task-loader fixture-mgr  event-coll  hard-asrt  soft-asrt
 └──────────┴─────┬────┴─────┬────┴─────┬────┴─────┬────┘
                  │          │          │          │
                  └──────────┴────┬─────┴──────────┘
                                  │
           Wave 2 业务组装（3 人串行）
                   ┌──────────────┴──────────────┐
                scorer                       task-runner
                   │                              │
                   └──────────────┬───────────────┘
                                  │
                              reporter
                                  │
                         Wave 3 入口（1 人）
                                  │
                              index.ts
                                  │
         Wave 4 内容（全流程并行，最后联调）
        70 YAML tasks + fixtures
```

---

## 2. 复用映射（现有代码 → benchmark）

基于已读事实，**严禁手搓**：

| 现有文件 | 复用方式 | 改造点 |
|----------|----------|--------|
| `src/index.ts` `bootstrap(configPath?)` | **直接调用** 创建 agent 实例 | 不改 |
| `src/agent.ts` `createAgent` | **通过 bootstrap 间接使用**，不直接 import | 不改 |
| `src/config.ts` `loadConfigDetailed` | 仅用于 benchmark 自己的配置覆盖层 | 不改 |
| `src/mcp/types.ts` (AgentEvent/AgentConfig/ChatContent) | **直接 import 类型** | 不改 |
| `src/agent/events.ts` `AgentEvent` | **直接 import**，event-collector 按 15 种事件类型分支 | 不改 |
| `test/e2e/helpers/agent-runner.ts` | **参考而不复用** — 它的 `finalText` 从 `text` 事件拼，但实际流式输出是 `token` 事件（见 `project-analysis.test.ts` 的 `collectText`），有 bug。event-collector 必须同时归集 `token`+`text` 两种 | 借鉴 `bootstrap + chat + AbortController + shutdown` 的生命周期，其它重写 |
| `test/e2e/helpers/assertions.ts` | **部分复用**：`assertChineseMin` / `assertNoHtmlLeak` 用作 hard assertion `final_text_min_chars` 和 anti-gaming 的 `<think>` 泄漏检测的实现 | 封装为 pure function，不抛 assert，返回 `{ ok, reason }` |
| `test/e2e/helpers/fetch-llm.ts` | **M1 不复用**（那是 Raw30B 用的，留给 M3 AUS） | - |
| `test/e2e/api/tool-use.test.ts` | **仅作为 L0 参考**，不直接复用代码 | - |
| `test/e2e/fixtures/simple-node-project/` | **直接复用** 作为 L1/L2 大部分任务的 fixture | 不改 |
| `test/cases/README.md` | **题库种子源**：20 个对话 case 里约 12 个可翻译成 L1/L2 YAML | 翻译成 YAML，不复用代码 |

**手搓的部分（不可避免）**：
- YAML 解析器：用 `js-yaml`（需新增 devDependency），或改 JSON 避免依赖（评估后选 YAML，因为设计文档明确要 YAML 且更可读）
- Schema 校验：手写轻量 validator（全部必填字段 + 类型检查），**不**引入 zod/ajv 之类重依赖

---

## 3. 目录结构（精确到文件）

```
test/benchmark/
├── tasks/
│   ├── L0/
│   │   ├── L0-001-hello.yaml
│   │   ├── L0-002-arithmetic.yaml
│   │   ├── L0-003-list-dir.yaml
│   │   ├── L0-004-read-package.yaml
│   │   ├── L0-005-exec-echo.yaml
│   │   ├── L0-006-grep-todo.yaml
│   │   ├── L0-007-write-file.yaml
│   │   ├── L0-008-edit-config.yaml
│   │   ├── L0-009-todo-write.yaml
│   │   └── L0-010-long-input.yaml
│   ├── L1/   (30 files, L1-001..L1-030)
│   └── L2/   (30 files, L2-001..L2-030)
│
├── fixtures/
│   ├── simple-node-project/      # 符号链接或直接复制 test/e2e/fixtures/simple-node-project
│   ├── multi-file-project/       # 新建：3-5 个 src 文件 + tests/ 目录，供 L2 多文件任务
│   └── with-tests-project/       # 新建：带 npm test 脚本的项目，供 L2 命令执行+回报
│
├── runner/
│   ├── index.ts                  # 入口
│   ├── task-loader.ts            # W1-1
│   ├── fixture-manager.ts        # W1-2
│   ├── event-collector.ts        # W1-3
│   ├── task-runner.ts            # W2-2
│   ├── scorer.ts                 # W2-1
│   ├── reporter.ts               # W2-3
│   ├── types.ts                  # 共享 interface（§4 全部 type）
│   └── assertions/
│       ├── hard.ts               # W1-4
│       └── soft.ts               # W1-5
│
├── reports/                      # 运行产物（gitignore）
│   └── <runId>/
│       ├── summary.json
│       ├── summary.md            # ASCII dashboard 的 md 版本
│       └── per-task/
│           └── <taskId>.json
│
└── README.md                     # 面向用户：如何跑、如何加题
```

**package.json 新增**：
```json
"scripts": {
  "benchmark": "tsx test/benchmark/runner/index.ts",
  "benchmark:L0": "tsx test/benchmark/runner/index.ts --level L0",
  "benchmark:task": "tsx test/benchmark/runner/index.ts --task"
},
"devDependencies": {
  "js-yaml": "^4.1.0",
  "@types/js-yaml": "^4.0.9"
}
```

---

## 4. 接口契约（TypeScript interface）

所有 interface 集中在 `test/benchmark/runner/types.ts`，任何模块跨文件通信必须走这些类型。

```ts
// ───────── TaskDef（YAML 解析后的形状） ─────────
export type Level = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export interface TaskDef {
  id: string;                          // e.g. "L2-003"
  title: string;
  level: Level;
  category: string;                    // e.g. "file-edit", "multi-turn"
  weight: number;                      // default 1.0

  fixture?: {
    project: string;                   // fixture 子目录名
    setup?: string[];                  // bash 命令数组，在 fixture 根执行
  };

  user_input?: string;                 // 单轮任务用
  rounds?: RoundDef[];                 // 多轮任务用（二选一，不能共存）

  hard_assertions: HardAssertion[];
  soft_assertions?: SoftAssertion[];

  // M1 不使用 dim_weights / reference / LLM judge，保留字段但 runner 忽略
  dim_weights?: Partial<Record<Dimension, number>>;
  reference?: {
    claude_code_score?: number;
    reference_rounds?: number;
    human_time_sec?: number;
  };

  runtime?: {
    timeout_sec?: number;              // default 120
    runs?: number;                     // default 5
    max_rounds?: number | null;        // null = 不限（依赖 agent 默认 maxLoops=20）
    layer?: 'L1' | 'L2' | 'L3';        // M1 仅用 L2 (Agent) 层
  };
}

export interface RoundDef {
  user: string;
  expect?: {
    tool_calls_include?: string[];     // e.g. ["fs__read_file"]
  };
}

// ───────── Hard Assertions（M1 实现这些） ─────────
export type HardAssertion =
  | { type: 'tool_called'; tool?: string; tool_matches?: string; args_contains?: Record<string, any>; args_matches?: Record<string, string> }
  | { type: 'tool_not_called'; tool: string }
  | { type: 'tool_retry_max'; max_same_error: number }
  | { type: 'file_content'; path: string; contains?: string; not_contains?: string; regex?: string; exact?: string }
  | { type: 'file_exists'; path: string }
  | { type: 'no_error_5xx' }
  | { type: 'final_text_contains'; pattern: string; regex?: boolean }
  | { type: 'final_text_min_chars'; min: number; lang?: 'any' | 'chinese' }
  | { type: 'event_sequence'; sequence: string[] }
  | { type: 'messages_count_max'; max: number }
  | { type: 'not_file_modified'; path: string }
  | { type: 'exit_code'; command: string; expected: number };

export interface AssertionResult {
  assertion: HardAssertion;
  ok: boolean;
  reason: string;                      // 失败时的人类可读说明
}

// ───────── Soft Assertions（M1 仅实现前 3 种） ─────────
export type SoftAssertion =
  | { type: 'final_text_min_len'; chars: number; weight: number }
  | { type: 'tool_call_count_max'; max: number; weight: number }
  | { type: 'duration_max'; ms: number; weight: number }
  // M2 新增（M1 跳过并打 warning）：
  | { type: 'llm_judge'; rubric: string; weight: number }
  | { type: 'reference_match_ratio'; ref: string; weight: number }
  | { type: 'token_usage_max'; max: number; weight: number };

export interface SoftScore {
  assertion: SoftAssertion;
  score: number;                       // 0–1
  weight: number;
}

// ───────── Dimensions（M1 只打分 ToolAcc + TaskDone + Eff 三项；其他 M2 补） ─────────
export type Dimension = 'ToolAcc' | 'TaskDone' | 'AnsQual' | 'CtxKeep' | 'ErrRec' | 'Eff';

// ───────── RunTrace（event-collector 的输出） ─────────
export interface RunTrace {
  taskId: string;
  runIndex: number;                    // 0..4 (5-run 中的第几次)
  events: import('../../../src/agent/events.js').AgentEvent[];
  toolCalls: ToolCallRecord[];
  finalText: string;                   // token + text 事件合并
  messagesCount: number;               // task:start..task:done 间的事件数
  thinkingMs: number;                  // 所有 thinking:start..thinking:end 区间累计
  apiCalls: number;                    // tool:call 次数
  startedAt: number;
  elapsedMs: number;
  hitMaxLoops: boolean;                // 最后一个 task:failed 是否因 max loops
  aborted: boolean;
  error?: string;                      // 整体异常
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, any>;
  ok: boolean;
  resultPreview: string;               // 前 400 字（与 agent 内部 short 相同）
}

// ───────── Scoring（scorer 的输出） ─────────
export interface TaskScore {
  taskId: string;
  hardPass: boolean;                   // 所有 hard_assertions 全过
  softScore: number;                   // weighted avg of soft, 0–1
  rawScore: number;                    // hardPass × (0.6 + 0.4 × softScore)
  hardResults: AssertionResult[];
  softResults: SoftScore[];
  trace: RunTrace;
}

export interface TaskResult {
  taskId: string;
  runs: TaskScore[];                   // 5 runs
  median: number;                      // 官方分（5 run 中位）
  stability: number;                   // 1 - std(5 scores)
  passRate: number;                    // hardPass 次数 / 5
}

export interface LevelScore {
  level: Level;
  score: number;                       // Σ(w × median) / Σw
  passRate: number;                    // hardPass 比例（加权）
  gateOk: boolean;                     // dual gate（score ≥ cutoff AND passRate ≥ rate）
  tasks: TaskResult[];
}

export interface BenchmarkReport {
  runId: string;                       // ISO + random
  config: { agent: string; model: string };
  totalScore: number;                  // M1 仅计 L1 + L2（L0 是门禁）
  level: number;                       // 带小数
  byLevel: Record<Level, LevelScore>;
  weakest: Array<{ taskId: string; median: number }>;
  startedAt: string;
  elapsedMs: number;
  // M1 不出 byDim / AUS / LocalEdge / regressions
}
```

---

## 5. YAML Schema（精确格式定义）

```yaml
# ───── 必填字段 ─────
id: "L2-003"                           # 必填，格式 L{level}-{3位数字}
title: "Change README version"         # 必填
level: "L2"                            # 必填，L0|L1|L2|L3|L4|L5
category: "file-edit"                  # 必填
weight: 1.0                            # 必填，number

# ───── fixture（L0 可省略，L1+ 建议有） ─────
fixture:
  project: "simple-node-project"       # 必须存在于 test/benchmark/fixtures/ 或 test/e2e/fixtures/
  setup:                               # 可选，bash 单行命令数组
    - 'echo "VERSION: 1.0.0" > README.md'

# ───── 输入二选一 ─────
user_input: "Change version to 2.0.0"  # 单轮
# 或：
rounds:                                # 多轮
  - user: "What's this project?"
    expect:
      tool_calls_include: ["fs__list_directory"]
  - user: "Tell me more"

# ───── 硬断言（至少 1 条） ─────
hard_assertions:
  - type: tool_called
    tool: "fs__read_file"              # 或 tool_matches（正则）二选一
    args_contains:                     # 可选，args 子集匹配
      path: "README.md"
  - type: file_content
    path: "README.md"                  # 相对 fixture cwd
    contains: "VERSION: 2.0.0"
    not_contains: "VERSION: 1.0.0"
  - type: no_error_5xx
  - type: tool_retry_max
    max_same_error: 2

# ───── 软断言（可选；M1 仅识别 3 种） ─────
soft_assertions:
  - type: final_text_min_len
    chars: 20
    weight: 0.3
  - type: tool_call_count_max
    max: 3
    weight: 0.4
  - type: duration_max
    ms: 60000
    weight: 0.3

# ───── 运行时（可选，有默认值） ─────
runtime:
  timeout_sec: 120                     # 默认 120
  runs: 5                              # 默认 5
  max_rounds: null                     # null = 用 agent 默认 maxLoops(=20)
  layer: "L2"                          # M1 固定 L2
```

**Schema 校验规则**（task-loader 必须执行）：
1. `id` 格式 `^L[0-5]-\d{3}$`
2. `level` ∈ enum
3. `user_input` / `rounds` 必二选一
4. `hard_assertions.length ≥ 1`
5. `fixture.project` 对应目录存在
6. 所有 `weight` > 0
7. 每条断言 `type` 必须在允许枚举内（未知类型 → 加载失败，不静默忽略）

---

## 6. 题库来源映射（70 题）

### L0 (10 题) — 设计文档 §4.2 表格 1:1 翻译

| YAML ID | 设计文档 ID | Fixture | 核心硬断言 |
|---------|-------------|---------|------------|
| L0-001 | L0-001 "Hello" | 无 | `final_text_min_chars(1)` |
| L0-002 | L0-002 "1+1=" | 无 | `final_text_contains("2")` |
| L0-003 | L0-003 列目录 | simple-node-project | `tool_called: fs__list_directory, ok=true` |
| L0-004 | L0-004 读 package.json | simple-node-project | `tool_called: fs__read_file, args.path=~package.json` |
| L0-005 | L0-005 exec echo | simple-node-project | `tool_called: exec__execute_command` |
| L0-006 | L0-006 grep TODO | simple-node-project | `tool_called: grep__grep` |
| L0-007 | L0-007 write file | tmp 目录 | `tool_called: fs__write_file 或 fs-edit__*` + `file_content` |
| L0-008 | L0-008 edit config | simple-node-project (setup 写 config.json) | `tool_called: fs-edit__*` + `file_content` |
| L0-009 | L0-009 todo | 无 | `tool_called: todo_write` |
| L0-010 | L0-010 长输入 | 无 | `no_error_5xx` + `final_text_min_chars(1)` |

### L1 (30 题) — 设计文档 §4.3 七大类别

| 类别 | 数量 | 映射来源 |
|------|------|----------|
| 读文件 | 6 | `test/cases/README.md` Case 1/7 改编 + 自编 4 道 |
| 写文件 | 4 | Case 9 + 自编 3 道 |
| 列目录 | 4 | Case 3/15 + 自编 2 道 |
| 执行命令 | 6 | Case 5/6/15 + 自编 3 道 |
| 搜索 | 4 | Case 8 + 自编 3 道 |
| 不应调工具 | 4 | Case 12/13 + 自编 2 道 |
| 工具名容错 | 2 | 自编（设计文档 §4.3 明确示例） |

### L2 (30 题) — 设计文档 §4.4 七大类别

| 类别 | 数量 | 映射来源 |
|------|------|----------|
| 读-改-写 | 6 | Case 4 + 自编 5 道 |
| 多轮追问 | 6 | Case 1/2/3/8/14 + 自编 1 道 |
| 错误恢复 | 4 | Case 11 + 自编 3 道 |
| 命令失败 | 3 | 自编（不应幻觉输出） |
| 多步任务 | 5 | Case 5/10/20 + 自编 2 道 |
| 上下文保持 | 4 | Case 1/2/3 追问场景 + 自编 1 道 |
| 空答自救 | 2 | 自编（触发 empty-content 分支） |

**题库开发分工**：2 人并行写 YAML，1 人当天把新增 fixture 目录建完（`multi-file-project` / `with-tests-project`）。

---

## 7. Agent 初始化流程（基于实际代码）

`task-runner.ts` 中每跑一个 task 的 **一个 run** 都重开 agent（避免跨任务状态污染）：

```ts
import { bootstrap, shutdown } from '../../../src/index.js';

async function runSingleTask(task: TaskDef, runIndex: number): Promise<TaskScore> {
  // 1. 准备 fixture（fixture-manager）
  const { cwd, cleanup } = await prepareFixture(task.fixture);
  const originalCwd = process.cwd();
  process.chdir(cwd);                        // bootstrap 内部会读 cwd，必须先切

  try {
    // 2. bootstrap 启动 agent（与 agent-runner.ts 一致）
    //    - 自动加载 ~/.my-agent/config.json + 项目 config.json
    //    - 自动连 MCP servers (exec/fs/fs-edit/grep/web)
    //    - 自动从 /v1/models 选模型
    //    - 自动创建 session
    const boot = await bootstrap(/* configPath */ undefined);
    const { agent, connections } = boot;

    // 3. 建 AbortController + timeout
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), (task.runtime?.timeout_sec ?? 120) * 1000);

    // 4. 采集 trace
    const collector = createEventCollector(task.id, runIndex);
    try {
      if (task.rounds) {
        // 多轮：每轮调一次 agent.chat，共享同一个 agent 实例（复用上下文）
        for (const round of task.rounds) {
          for await (const ev of agent.chat(round.user, ac.signal)) {
            collector.push(ev);
          }
        }
      } else {
        // 单轮
        for await (const ev of agent.chat(task.user_input!, ac.signal)) {
          collector.push(ev);
        }
      }
    } finally {
      clearTimeout(timer);
      await shutdown(connections);           // 必须关 MCP，否则子进程泄漏
    }

    const trace = collector.finalize();

    // 5. 断言 + 评分
    const hardResults = runHardAssertions(task.hard_assertions, trace, cwd);
    const softResults = runSoftAssertions(task.soft_assertions ?? [], trace);
    const hardPass = hardResults.every(r => r.ok);
    const softScore = weightedAverage(softResults);
    const rawScore = hardPass ? (0.6 + 0.4 * softScore) : 0;

    return { taskId: task.id, hardPass, softScore, rawScore, hardResults, softResults, trace };
  } finally {
    process.chdir(originalCwd);
    await cleanup();
  }
}
```

**关键事实约束**：
1. `bootstrap()` 在 `src/index.ts:22`，签名 `(configPath?, opts?) => Promise<BootstrapResult>`。
2. `agent.chat(userMessage, signal?)` 返回 `AsyncGenerator<AgentEvent, void, unknown>`（`src/mcp/types.ts:74`）。
3. `shutdown(connections)` 在 `src/index.ts:115`，必须调，否则 MCP 子进程泄漏。
4. agent 自带 `maxLoops` (默认 20)、自带 compact、自带 task stack —— benchmark **不干预**，只观察。
5. 多轮任务：同 agent 实例反复 `chat()`，内部 messages 累积（这是 agent 本身的上下文保持能力，正是我们要测的）。
6. **禁止 mock**：遵循设计文档 §11 红线 1，benchmark 跑真实 LLM + 真实 MCP。

---

## 8. 事件采集方案（event-collector 详细设计）

基于 `AgentEvent` 15 种类型（`src/agent/events.ts`）和 `agent.ts` 的实际发射逻辑：

### 8.1 事件流真实形态（从 agent.ts 读出的事实）

| 事件 | 发射时机 | 关键字段 |
|------|---------|---------|
| `task:start` | 新任务出栈执行 | `taskId, prompt` |
| `task:done` / `task:failed` / `task:aborted` | 任务结束 | `taskId, error?, next?` |
| `token` | **流式 content 分片**（主要文本来源） | `text` |
| `text` | max loops 时的停止消息（仅此一处） | `content` |
| `tool:call` | 工具开始调用 | `name, args` |
| `tool:result` | 工具返回（成功/失败） | `ok, content`（前 400 字 preview） |
| `tool:confirm` | 危险命令等确认 | `requestId, cmd, reason` |
| `thinking:start/end` | reasoning_content / `<think>` 段 | `durationMs` |
| `compact:done` | 自动压缩发生 | `freed` |
| `ask_user` / `plan` | 内置工具触发 | - |
| `aborted` | 整体中止 | - |

### 8.2 Collector 归集规则

```ts
class EventCollector {
  private events: AgentEvent[] = [];
  private toolCalls: ToolCallRecord[] = [];
  private pendingTools: Array<{name: string; args: any}> = [];  // FIFO 队列
  private tokenBuf = '';       // 从 token 事件拼
  private textBuf = '';        // 从 text 事件拼（极少）
  private thinkingMs = 0;
  private startedAt = Date.now();
  private hitMaxLoops = false;
  private aborted = false;

  push(ev: AgentEvent): void {
    this.events.push(ev);
    switch (ev.type) {
      case 'token': this.tokenBuf += ev.text; break;
      case 'text':  this.textBuf += ev.content; break;
      case 'tool:call':
        this.pendingTools.push({ name: ev.name, args: ev.args });
        break;
      case 'tool:result': {
        const p = this.pendingTools.shift();
        this.toolCalls.push({
          name: p?.name ?? '<unknown>',
          args: p?.args ?? {},
          ok: ev.ok,
          resultPreview: ev.content,
        });
        break;
      }
      case 'thinking:end': this.thinkingMs += ev.durationMs; break;
      case 'task:failed':
        if (ev.error === 'max loops') this.hitMaxLoops = true;
        break;
      case 'aborted':
      case 'task:aborted':
        this.aborted = true;
        break;
    }
  }

  finalize(): RunTrace {
    return {
      taskId: this.taskId,
      runIndex: this.runIndex,
      events: this.events,
      toolCalls: this.toolCalls,
      finalText: this.tokenBuf + this.textBuf,   // token 是主要来源
      messagesCount: this.events.length,
      thinkingMs: this.thinkingMs,
      apiCalls: this.toolCalls.length,
      startedAt: this.startedAt,
      elapsedMs: Date.now() - this.startedAt,
      hitMaxLoops: this.hitMaxLoops,
      aborted: this.aborted,
    };
  }
}
```

### 8.3 与现有 `agent-runner.ts` 的差异

| 点 | 现有 helper | benchmark collector |
|----|-------------|---------------------|
| finalText 来源 | 仅 `text` 事件（bug：流式输出拿不到） | `token + text` 双来源 |
| tool 配对 | FIFO（可能错配并行调用） | 保留 FIFO（agent 串行发射，无风险） |
| thinking 累计 | 不采集 | 采集（用于 `final_text_contains <think>` 泄漏检测） |
| hitMaxLoops | 不采集 | 采集（软评分 Eff 维度需要） |
| aborted | 不采集 | 采集（标记 invalid run） |

### 8.4 断言如何消费 trace

- `tool_called`：扫描 `trace.toolCalls`，`name` 精确匹配或正则匹配 + `args_contains` 子集匹配。
- `file_content`：无需 trace，直接 `fs.readFileSync(path.join(cwd, assertion.path))` 对比。
- `no_error_5xx`：扫描 `trace.events` 中 `tool:result.ok=false && content.includes('500'|'502'|'503'|'504')`；或 `trace.error` 有 HTTP 5xx。
- `tool_retry_max`：按 `name+JSON.stringify(args)` 分组计数，同组 ok=false 次数 > max 即失败。
- `final_text_min_chars`：`trace.finalText` 长度（中文用 `assertions.ts` 的 `assertChineseMin` 封装版）。
- `final_text_contains`：`trace.finalText.includes(pattern)` 或 `new RegExp(pattern).test(trace.finalText)`。
- `event_sequence`：`trace.events.map(e=>e.type).join(',').includes(seq.join(','))` 的子串查找。
- `messages_count_max`：`trace.events.length ≤ max`。
- `exit_code`：任务后 `execSync(command, {cwd})` 捕获 `status`。

---

## 9. 评分算法（scorer 细节）

### 9.1 单 run 分数
```
rawScore(run) = hardPass ? (0.6 + 0.4 × softScore) : 0
```

### 9.2 5-run 聚合
```ts
runs = runs.sort((a,b) => a.rawScore - b.rawScore);
median = runs[2].rawScore;               // 第 3 个（0-indexed=2）
mean = avg(runs.map(r=>r.rawScore));
std = stddev(runs.map(r=>r.rawScore));
stability = Math.max(0, 1 - std);
passRate = runs.filter(r=>r.hardPass).length / 5;
```

### 9.3 Level 聚合（双门禁）
```ts
levelScore = Σ(task.weight × task.median) / Σ(task.weight);
levelPassRate = Σ(task.weight × task.passRate) / Σ(task.weight);

// 门禁（设计文档 §1 表）
const GATES = {
  L0: { cutoff: 1.00, rate: 1.00 },    // 100% 全过
  L1: { cutoff: 0.75, rate: 0.90 },
  L2: { cutoff: 0.65, rate: 0.80 },
  L3: { cutoff: 0.55, rate: 0.70 },
  L4: { cutoff: 0.45, rate: 0.60 },
  L5: { cutoff: 0.40, rate: 0.50 },
};
gateOk = levelScore >= GATES[L].cutoff && levelPassRate >= GATES[L].rate;
```

### 9.4 总分（M1 仅 L1 + L2）
```
const WEIGHTS = { L1: 15, L2: 20 };    // 设计文档 §1 α 列
totalScore = (L1.gateOk ? WEIGHTS.L1 × L1.score : 0) +
             (L2.gateOk ? WEIGHTS.L2 × L2.score : 0);
```
M1 最大总分 = 15 + 20 = **35 分**（M2/M3 加上 L3/L4/L5 才能到 100）。

### 9.5 Level（带小数）
```
final_level = max{L : L0.gateOk ∧ L1.gateOk ∧ ... ∧ L.gateOk}
decimal = final_level + next_level.passRate   // 进入下一级的比例
```

### 9.6 L0 失败红线
L0.gateOk === false → 整个 report 标记 `invalidRun: true`，不输出 L1/L2 分数（设计文档 §11 红线 7）。

---

## 10. Reporter 输出

### 10.1 ASCII Dashboard（`reports/<runId>/summary.md`）
对照设计文档 §8.1，**M1 简化版**（无 AUS / 无 vs 上次 / 无维度雷达）：

```
═══════════════════════════════════════════════════════════
  MA Agent Benchmark — 2026-04-29 14:32 CST (M1)
═══════════════════════════════════════════════════════════

  Config:        MA v2.0.0 + qwen3-30b-a3b
  Total (M1):    18.4 / 35
  Level:         L1.8 / 5.0
  Elapsed:       42m 13s

  ─── Levels ───
  L0 Connectivity   ██████████ 100% ✓ (gate 100%)
  L1 Stable Tools   █████████░  92% ✓ (gate 90%)
  L2 Multi-turn     ██████░░░░  78% × (score 0.72 OK, passRate 78% < 80%)

  ─── Top 5 Loss Points ───
  1. L2-015 search follow-up → repeat tool call (median 0.20)
  2. L2-011 read nonexistent → retry >3× (median 0.30)
  ...

  ─── Flaky Tasks (stability < 0.7) ───
  - L2-003 runs: [1.0, 0.6, 1.0, 0.3, 1.0] (std 0.30)

═══════════════════════════════════════════════════════════
```

### 10.2 JSON Summary（`reports/<runId>/summary.json`）
见 §4 `BenchmarkReport` interface，字段 1:1 输出。

### 10.3 Per-Task JSON（`reports/<runId>/per-task/L2-003.json`）
包含 5 runs 全部 trace + 断言详情，供人工审查。

---

## 11. 任务拆分与人员分配（6 天内跑通 L0+L1 Demo，10 天交付 M1）

| Day | Phase | 任务 | 人员 |
|-----|-------|------|------|
| D1 | 启动 | 仓库骨架 + `types.ts` + package.json 加 `js-yaml` + 建目录 | 1 人（lead） |
| D2-D3 | Wave 1 并行 | task-loader / fixture-manager / event-collector / hard / soft 五模块 + 单测 | **5 人并行** |
| D2-D4 | Wave 4 内容 | L0 10 题 + L1 30 题 YAML（可先写完交测试验证） | 2 人并行 |
| D3-D4 | Wave 2 串行 | scorer → task-runner → reporter + 联调 | 2 人串行 |
| D4 | Demo checkpoint | `npm run benchmark:L0` 跑通 L0 10 题，验证管道端到端 | 全员 |
| D5-D6 | Wave 4 续 | L2 30 题 YAML + 新 fixture（multi-file / with-tests） | 2 人并行 |
| D5 | Wave 3 | `runner/index.ts` CLI 入口 + `--level / --task / --dry-run` | 1 人 |
| D6-D7 | 真机联调 | 全量 70 题跑一次，收集 flaky 列表，修 YAML 阈值 | 2 人 |
| D8 | Phase 6 QA | 新人（不参与开发）带着目标文档审查 + 跑通 + 挑刺 | 2 人 |
| D9 | 修正 | 根据 QA 反馈修 | 原开发团队 |
| D10 | 交付 | 最终报告 + mnemo 存经验 + 通知用户 | lead |

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| YAML 解析器引入 `js-yaml` 依赖 | 新 devDep | 可接受；不在 prod 运行时 |
| bootstrap 每次重连 MCP（~3-5s） × 70 题 × 5 run = 约 17 分钟启动开销 | 总运行时间 +30% | M1 接受；M2 再考虑 agent 池化 |
| `process.chdir` 在并行跑时互相污染 | 结果错乱 | **M1 必须串行跑任务**，禁止并行 task（并行 run 也不行，因为 chdir 是进程级） |
| 本地 30B 模型 5xx 偶发 | flaky | `tool_retry_max` 断言天然覆盖；5-run median 吸收偶发 |
| 断言错杀（模型换了参数名但功能对） | false negative | `tool_matches` 支持正则，`args_contains` 子集匹配，不做 exact equal |
| 长任务超时 kill 后 MCP 子进程泄漏 | 资源泄漏 | `task-runner.ts` 的 `finally` 必调 `shutdown(connections)` |
| L0 题里让 LLM "Hello" 回复可能是空 | flaky | `final_text_min_chars: 1, lang: any`，不限中文 |

---

## 13. 交付清单（M1 完成定义）

- [ ] `test/benchmark/` 目录结构齐全（§3）
- [ ] `types.ts` 所有 interface 定义完备（§4）
- [ ] Wave 1 五模块各有单测（≥ 80% 覆盖）
- [ ] 70 题 YAML 全部通过 schema 校验
- [ ] `npm run benchmark -- --level L0` 本机跑通，L0 10 题全过（passRate=1.0）
- [ ] `npm run benchmark -- --task L1-001` 单题跑通
- [ ] `npm run benchmark` 跑完 70 题 × 5 run，产出 `reports/<runId>/summary.md` + `summary.json`
- [ ] Summary 能人眼读懂哪几题挂了、哪几题 flaky
- [ ] README.md 写明"如何加新题"（面向后续 M2/M3 扩展）
- [ ] 新人（不参与开发）按 README 能独立跑一遍并看懂报告

---

## 14. 红线（从设计文档 §11 继承）

1. **No mock** — 真实 LLM + 真实 MCP + 真实 fs 断言。
2. **YAML 单一真相** — 题目不能硬编码在 TS 里。
3. **Hard = 机械** — M1 所有硬断言必须可程序化判定，不能调 LLM。
4. **L0 全过才算有效** — 失败则整份报告 invalid。
5. **任务级串行** — chdir 是进程级状态，任务必须串行跑（run 内部可考虑多进程，M2 再说）。
6. **每 run 重开 agent** — 不跨任务复用 agent 实例，避免 messages 污染评分。
7. **shutdown 必调** — MCP 子进程必须回收。

---

## 15. 对 M2/M3 的接口预留

虽然 M1 不做，但接口要留好，避免 M2/M3 重构：

- `TaskDef.dim_weights` / `TaskDef.reference` 字段在 YAML 中允许存在，M1 runner 忽略但不报错。
- `SoftAssertion.llm_judge` / `reference_match_ratio` / `token_usage_max` 在 schema 中允许，M1 soft.ts 遇到时打 warning 并给分 0.5（中性），不 crash。
- `BenchmarkReport.byDim` 字段保留为可选，M1 不填。
- `baselines/` 目录预留但 M1 不写入，M3 再启用。
- Reporter 预留 `--compare <baseline.json>` 参数开关（M1 返回 "not implemented"）。

---

**基于 Plan B 的核心判断**：M1 的最小可行产品就是 **"一份自动化评分 + 诊断卡"**，所有复杂度（LLM judge / AUS / 趋势）都推到 M2/M3。70 题 YAML + 纯机械断言 + 5-run 中位数 = 已经能回答 "MA agent 在 30B 上到底行不行" 这个核心问题。

# Benchmark L1/L2 失败根因调查

- 调查时间：2026-04-29
- 最新 run：`test/benchmark/reports/2026-04-29T10-30-38-222Z-alb1/`（L2 pass rate 75.3%，未过 80% gate）
- 本地模型：`qwen/qwen3.6-35b-a3b`（`~/.my-agent/config.json`）

## 结论总览

三类根因，按严重度排序：

| # | 根因 | 影响面 | 改 agent 核心？ |
|---|------|--------|------------------|
| A | `grep-mcp` 不默认递归，对目录传 `path` 必报错 | L1-021、L1-024 多 run 失败 | 否，只改 `servers/grep-mcp.ts` |
| B | 本地小模型偶发吐 `arguments={}`（工具调用 schema 退化） | L2-001/003/004/005/006/020/021 若干 run 失败 | 可选小改 agent，也可改 MCP 更严格 |
| C | `fs-mcp.read_file` 对 `args={}` 默认读 `./package.json`，掩盖 B 的错误 | L2-006/021 等，放大 B 的影响 | 否，只改 `servers/fs-mcp.ts` |
| D | 断言 `normalizePath` 不处理绝对路径，模型传绝对路径被判不相等 | L2-021 部分 run 误判 | 否，只改 `test/benchmark/runner/assertions/hard.ts` |

**是否需要改 agent 核心（`src/agent.ts`）？** —— 不需要。`src/agent/normalize.ts:27-32` 已经能 parse JSON 字符串 arguments 并 fallback 为 `{}`，属正确行为。空 args 来自模型输出，不是 agent bug。修复应集中在 MCP 服务端兜底 + 断言容忍性。

---

## 问题 1：`grep-mcp` 不递归目录

### 现象

`L1-021`（"在 src 目录下搜索 useState"）、`L1-024`（"搜一下 src 目录下哪些地方定义了 helper"）。
典型 fail trace（`reports/2026-04-29T09-49-58-774Z-8lnv/per-task/L1-021.json` run 1）：

```
tool:call  grep__grep  args={"pattern":"useState","path":"src"}
tool:result ok=false   "grep failed: Command failed: grep -n -E -- useState src\ngrep: src: Is a directory\n"
```

L1-024 中 5 次 run，只有 run 2（`recursive: true`）和 run 3（`recursive: true`）通过。

### 根因

`servers/grep-mcp.ts:16` inputSchema：

```ts
recursive: { type: 'boolean', description: '是否递归搜索子目录', default: false },
```

`servers/grep-mcp.ts:29,32`：

```ts
const recursive = args.recursive === true;
const flags = recursive ? ['-rn', '-E', '--'] : ['-n', '-E', '--'];
```

模型看到 `recursive` 是可选 + default false + 用户说"在 src 目录下"，大概率只传 `pattern` + `path: "src"`。系统 `grep -n -E -- useState src` 在 macOS 下直接报 `Is a directory`，tool 返回 error。

**`-r` 副作用评估**：
- `grep -rn` 对文件路径也能正常工作（和 `-n` 单文件输出一致）。
- 不会跨文件系统边界、不会跟符号链接出目录（macOS BSD grep 默认行为，与 GNU 略异但安全）。
- 限行数 `MAX_LINES=100` 已有上限保护，不会爆结果。
- 结论：**默认开 `-rn` 无副作用**。

### 建议修法

**方案 A（推荐，最简单最鲁棒）**：`servers/grep-mcp.ts` 默认总是递归，去掉 `recursive` 参数。

```ts
// servers/grep-mcp.ts:32（修改前）
const flags = recursive ? ['-rn', '-E', '--'] : ['-n', '-E', '--'];
// 修改后
const flags = ['-rn', '-E', '--'];
```

并从 inputSchema 删掉 `recursive` 字段，或标为 deprecated。

**方案 B（保守）**：让服务端在发现 `path` 是目录时自动退回 `-r`，在结果里提示："检测到目录路径，已自动切换递归模式"。保留用户能显式关闭递归的入口。

**预期效果**：L1-021、L1-024 全部 5 run hardPass，L1 分数 +2 task。

---

## 问题 2：本地模型偶发吐空 arguments

### 现象

最新 run L2 per-task 空 args 统计：

| 任务 | 总 tool call | 空 args |
|-----|------------|---------|
| L2-001 | 14 | 5 |
| L2-003 | 10 | 3 |
| L2-004 | 10 | 4 |
| L2-005 | 27 | 4 |
| L2-006 | 11 | 4 |

典型 trace（L2-001 run 2）：

```
fs__list_directory args={"path":"."} ok=true
grep__grep         args={}           ok=false  "grep: \"pattern\" must be a non-empty string"
fs__read_file      args={"path":"README.md"}
fs-edit__file_edit args={}           ok=false  "file_edit: \"path\" must be a non-empty string"
```

### 根因

不是 agent bug。`src/agent.ts:674-701` 正确累积流式 `tool_calls[].function.arguments` 片段；`src/agent/normalize.ts:20-33` 正确处理 null/string/object 并 fallback 成 `{}`。

真实原因：**本地 LM Studio 模型 `qwen/qwen3.6-35b-a3b`（30B 小参数）tool calling 能力不稳**，在多工具、多轮对话 / 中文描述下时不时不生成 JSON 参数体，只产出空 arguments。同样的任务换强模型（Claude/GPT）不会发生。

**证据**：L2-001 同一 task 里，相同 prompt 和相同 system，run 0 生成 `args={"path":"./README.md"}` 成功，run 2 又生成 `args={}` 失败。一致性取决于采样运气，与代码无关。

### 建议修法

三个方向，可组合。

**A. agent 核心层兜底（小改 `src/agent.ts`）**：

在 `args = normalizeArguments(...)` 后，若 `args === {}` 且工具 `inputSchema.required` 非空，直接跳过执行并在 `tool` 消息里返回人类可读的错误提示 + 工具 schema，强制模型重生成。这比走到 MCP 再被拒更省 round。

**但不是必需**：当前走 MCP 被拒、messages 里有 `tool_call_id` + 错误文本，下一轮模型已经能看到错误并自我纠正（L2-005 run 3/4 就是这种自愈成功 case）。

**B. 换掉本地模型（根本方案）**：
- 升级到 qwen-2.5-72b 或 qwen-3-32b 等原生 tool calling 强的模型；
- 或 benchmark config 直接对接 Anthropic/OpenAI endpoint 做对比基准。

**C. MCP 服务端强化（防御性）**：见问题 3。

**预期效果**：B 能把 L2 pass rate 拉到 ≥90%；仅做 A 只能少 1~2 个 round，pass rate 提升有限（模型第二次还是可能空）。

---

## 问题 3：`fs__read_file` 对空 args 返回 `./package.json`（放大问题 2）

### 现象

L2-006 run 0：

```
exec__execute_command args={"command":"find . -name \"data.json\"..."} ok=true
fs__read_file         args={}                                          ok=true   preview="[file] package.json..."
```

模型拿到 "伪成功" 结果，完全不知道自己传错了，也就不会重试。最终 hardAssertion `tool_called fs__read_file path=data.json` fail。

### 根因

`servers/fs-mcp.ts:70`：

```ts
const path = (typeof args.path === 'string' && args.path.trim()) ? args.path.trim() : './package.json';
```

这是个"贴心"默认，但**对 LLM 有毒**：它把模型的错误 (`args={}`) 变成没有错误反馈的副作用。

### 建议修法

删除默认值，让它和 `file_edit` 一样显式报错：

```ts
// servers/fs-mcp.ts:69-70（修改前）
function handleReadFile(args: Record<string, unknown>) {
  const path = (typeof args.path === 'string' && args.path.trim()) ? args.path.trim() : './package.json';
// 修改后
function handleReadFile(args: Record<string, unknown>) {
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  if (!path) return ok('read_file: "path" must be a non-empty string', true);
```

**预期效果**：问题 2 发生时，模型立刻看到错误并有机会重生成；L2-006、L2-021 等任务 pass rate 会明显改善。应该同步检查 `fs-mcp` 其它工具有没有类似默认值。

---

## 问题 4（次要）：断言不处理绝对路径

### 现象

`L2-021` run 3 trace：

```
fs__list_directory args={"path":"."}                                             ok=true
fs__read_file      args={"path":"/private/var/folders/.../ma-bench-fixture-jNrTS8/README.md"} ok=true
```

模型行为完全合理（读了正确的 README），但 hard assertion `args_contains path: "README.md"` 不通过，reason：`no tool call matched tool="fs__read_file" argsContains={"path":"README.md"}`。

### 根因

`test/benchmark/runner/assertions/hard.ts:63-66`：

```ts
function normalizePath(p: unknown): string {
  if (typeof p !== 'string') return String(p);
  return p.replace(/^\.\//, '').replace(/\/+$/, '');
}
```

只去前导 `./` 和尾部 `/`，把 `/private/.../README.md` 和 `README.md` 判为不等。

但 fixture 实际路径就是 `/private/var/folders/.../ma-bench-fixture-*/README.md`，模型在 exec 输出里看到绝对路径后直接用它是合理的。

### 建议修法

改 `matchArgsContains` 的 path 分支为 basename/endsWith 匹配：

```ts
// hard.ts:73-74 修改前
if (key === 'path' || key === 'file' || key === 'directory') {
  if (normalizePath(actual) !== normalizePath(expected)) return false;
}
// 修改后
if (key === 'path' || key === 'file' || key === 'directory') {
  const a = normalizePath(actual);
  const e = normalizePath(expected);
  // 支持 expected 为相对路径时用 endsWith 匹配
  if (a !== e && !a.endsWith('/' + e) && a !== e) return false;
}
```

或者更简单：只比较 basename。需要写单测保证不把 `foo/README.md` 和 `bar/README.md` 判等（basename 都是 README.md，可能误匹配）—— 所以用 `endsWith('/' + e) || a === e` 更稳。

**预期效果**：L2-021 run 3 能通过，pass rate +1 个 run。

---

## L2-020 说明

L2-020 的 5 个 run 里，3 个 hardPass 失败，原因都是 `final_text_contains`：

```
hard: ('final_text_contains', False, 'finalText missing test-project')
hard: ('final_text_contains', False, 'finalText missing v')
```

模型明明正确读了 package.json 和跑了 `node -v`，但最终回复的文本太短 / 格式不对，没把 `"test-project"`（package.json 里的 name 字段）和 `"v"`（node 版本号里的 v）塞进去。典型本地小模型多轮任务"接不住"问题。

**建议**：此类问题纯属模型能力，不建议为迁就模型改断言。标记为"本地模型限制"即可。换强模型自然解决。

---

## 修复优先级建议

按修复 ROI 排序：

1. **改 `servers/grep-mcp.ts` 默认 `-rn`**（5 分钟，修复 L1-021/L1-024，无副作用）
2. **改 `servers/fs-mcp.ts` read_file 去默认值**（5 分钟，修复 L2-006 且让问题 2 能被模型自愈）
3. **改 `test/benchmark/runner/assertions/hard.ts` path endsWith 匹配**（10 分钟，修复 L2-021 部分 run）
4. **（可选）换更强本地模型 或 接 Claude API**：根本解决问题 2 导致的所有 L2 flaky

**全部 1~3 修完**：预期 L1 恢复全绿、L2 pass rate 从 75% 升到 ~85%（超过 80% gate）。
**加上 4**：L2 可达 ≥95%。

## 是否需要改 `src/agent.ts`？

**否**。agent.ts 的流式 tool_call 累积（L674-701）、normalize（L702 + `src/agent/normalize.ts`）、错误历史（L729-739）都是正确实现。模型吐空 args 属输入噪声，不是 agent bug。修复集中在 MCP 服务端和断言即可。

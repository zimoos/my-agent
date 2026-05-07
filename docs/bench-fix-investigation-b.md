# Bench 修复调查报告 B — 模型行为侧

**investigator-b / 2026-04-29**

范围：从 agent 侧（tool schema、模型调用参数、fallback 机制）分析 benchmark L2-001 / L1-021 为代表的 fs-edit / grep 失败根因。

## 0. TL;DR（先看结论）

本地模型 `qwen/qwen3.6-35b-a3b` 在 MA-30B 配置下跑 L2 read-modify-write 题目时，**有很高的概率对 fs-edit__file_edit 和 fs__read_file 发送空 arguments**（`""` 空字符串），后台 MCP 报参数缺失错误后又触发下一轮 500 Error（LM Studio 侧内部错误）把整条 task 炸掉。

**根因是三层叠加，三层都得修**：

| 层 | 现象 | 修复方向 |
|---|---|---|
| 模型 | fs-edit 多参数场景下 arguments 持续为 `""` | schema 描述加强 + 系统提示加 few-shot（短期）；长期换更强模型 |
| MCP | fs-mcp `read_file` 当 path 缺失时**静默默认 `./package.json`** | 去掉默认值，让调用方暴露错误 |
| agent | 无 write_file fallback、无 grep recursive fallback、tool_calls args 为 `""` 时未补救 | 增加 schema validation + arguments-empty 重提示 + 指定工具失败 fallback |

---

## 1. 真实 trace（模型到底传了什么）

### 1.1 L2-001 「把 README 里的版本号从 1.0.0 改成 2.0.0」

单 run trace（`~/.my-agent/sessions/s_1777459028413_ssm2.jsonl`）：

```json
user: "把 README 里的版本号从 1.0.0 改成 2.0.0"
assistant.tool_calls[0]: fs__list_directory {"path":"."}
tool → "[file] README.md\n[file] package.json\n[dir] src/"
assistant.tool_calls[1]: fs__read_file arguments="" ← 空字符串
tool → "1│{\n2│  \"name\": \"test-project\", ... }"   ← fs-mcp 静默默认到 package.json
(下一轮请求返回 500 Error Internal Server Error → task:failed)
```

关键观察：
1. **模型发送 `arguments: ""` 空串**（不是 `{}`，而是完全空字符串）。`normalizeArguments` 把它归一化成 `{}`。
2. **fs-mcp:70 `handleReadFile` 在 path 为空时静默默认到 `./package.json`**（`const path = ... ? args.path.trim() : './package.json'`）—— 这是一个**非常严重的 MCP bug**：模型忘填 path 不报错反而返回了 package.json 内容，让模型以为自己读到了 README，后面直接进入 "500 Error"。
3. L2-001 因为 hard.tool_called(fs__read_file, path=README.md) 挂了，因为 argsContains 要求 args.path 含 "README.md"，但实际 args 是空 `{}`。

连续两次 L2-001 跑出同样结果（`s_1777458998410_k8ee.jsonl` 也是 fs__read_file arguments=""）。**模型层面对 fs__read_file 空参是高复现**。

### 1.2 L2-005 「把 src/utils.js 里的变量 foo 全部改名为 bar」

最干净的 case（user_input 里已经明确了文件路径），2/2 runs 同样失败：

```json
user: "把 src/utils.js 里的变量 foo 全部改名为 bar"
assistant.tool_calls[0]: fs__read_file {"path":"src/utils.js"}  ← 这次 path 对了
tool → "1│export const helper = () => {\n2│  const foo = 1;\n3│  return foo;\n4│};\n"
assistant(content="文件中有两处 foo：声明和返回。将它们全部替换为 bar。"):
  .tool_calls[1]: fs-edit__file_edit arguments=""   ← 空串！
tool → 'file_edit: "path" must be a non-empty string'
(下一轮 500 Error Internal Server Error → task:failed)
```

**模型能在 assistant.content 里正确推理"替换 foo → bar"，但 tool_calls[].function.arguments 仍然是空串**。这不是理解问题，是 function-call 序列化层的模型行为 bug。2/2 次完全复现 → 基本是 deterministic 的模型 behavior，不是偶发。

### 1.3 L2-003 「把 config.json 里 port 从 3000 改成 8080」（对照组，成功）

```json
assistant.tool_calls[0]: fs__read_file {"path":"./config.json"}
tool → '1│{"port": 3000, "host": "localhost"}\n'
assistant.tool_calls[1]: fs-edit__file_edit {"path":"./config.json","old_string":"3000","new_string":"8080"}
tool → "已编辑 ./config.json：替换 1 处，大小变化 0 bytes"
→ hardPass: true
```

**相同的模型、相同的 schema、相同的 fs-edit 工具**，L2-003 能正确填参。差异点：
- L2-003 old_string/new_string 是**数字字面量** `"3000"→"8080"`，模型很容易写
- L2-005 old_string/new_string 是**标识符** `"foo"→"bar"`，且有两处出现（需要 replace_all=true）
- 推测：模型面对"需要 old_string 唯一 / 或设 replace_all"的约束时，tool-call 序列化更容易崩

### 1.4 L1-021 「在 src 目录下搜索 useState」（hardPass: true，但过程有坑）

```json
CALL: grep__grep {"pattern":"useState","path":"src"}
RESULT: ERR grep failed: ... grep: src: Is a directory
CALL: grep__grep {"pattern":"useState","path":"src","recursive":true}
RESULT: OK src/index.js:1:import { useState } ... (正确输出)
TASK:DONE → hardPass: true
```

这题**最终通过**，但：
1. 第一次调用 `recursive=false` 对目录跑 grep 必然失败（grep 的行为就是这样）
2. 模型看到 "Is a directory" 后自己学会了加 `recursive: true` 重试
3. 这是靠模型**从错误提示文本里学**。对更弱的模型/更复杂的题这路径不稳。

---

## 2. Tool Schema 分析（模型看到的 parameters 清不清晰）

### 2.1 fs-edit__file_edit（servers/fs-edit-mcp.ts:11-17）

```ts
{ name: 'file_edit',
  description: '对已存在文件做精确字符串替换。必须先用 read_file 读过目标文件。old_string 必须在文件中唯一（除非 replace_all=true）。不做 CRLF 归一化、不做模糊匹配、二进制文件拒绝、上限 512KB。',
  inputSchema: { type: 'object', required: ['path', 'old_string', 'new_string'], properties: {
    path: { type: 'string', description: '目标文件路径' },
    old_string: { type: 'string', description: '要被替换的原始文本（必须完整、包含足够上下文以保证唯一）' },
    new_string: { type: 'string', description: '替换为的新文本（可为空串，表示删除）' },
    replace_all: { type: 'boolean', description: '替换所有出现，默认 false', default: false } } } }
```

schema 本身是**规范的**：required 三字段齐全、描述语义明确。**但有改进空间**：

| 问题 | 修复建议 |
|---|---|
| description 把所有约束塞一起（read_file 前置 + 唯一性 + CRLF + 二进制 + 上限）容易让模型扫过关键要求 | 在 description 开头加一段典型示例 JSON：`示例: {"path":"src/x.ts","old_string":"foo","new_string":"bar"}`，few-shot 式降低模型填空压力 |
| 没告诉模型"如果 old_string 可能出现多次，记得加 replace_all:true" 的示例，只靠错误自纠正 | description 加一句"多处出现请同时传 replace_all:true" |
| `new_string` 描述里的"可为空串，表示删除"可能被弱模型误解为"path 也可以空" | 删掉这个括号备注，放到 description 主体 |

### 2.2 grep__grep（servers/grep-mcp.ts:11-17）

```ts
{ name: 'grep',
  description: '在文件中搜索文本模式，返回匹配行和行号。调用系统 grep，截断前 100 行。',
  inputSchema: { type: 'object', required: ['pattern', 'path'], properties: {
    pattern: { type: 'string', description: '搜索模式（正则或纯文本）' },
    path: { type: 'string', description: '文件或目录路径' },
    recursive: { type: 'boolean', description: '是否递归搜索子目录', default: false },
  } } }
```

**有明显歧义**：
- `path` 描述说"文件或目录路径"，但 `recursive` 默认 false，对目录 grep 会直接报 `"Is a directory"`
- 模型看到"路径可以是目录"容易第一次不加 recursive → 失败 → 再加 recursive 重试
- 实测 L1-021 就是这个路径，浪费一轮 LLM 调用（成本 + 延迟 + 累积错误上下文的风险）

**修复**（择一）：
1. **schema 侧**：description 里写清楚"**对目录搜索必须同时传 recursive: true**，否则 grep 会报错"
2. **实现侧**（更优）：在 `handleGrep` 里 `statSync(path).isDirectory()` 自动加 `-r` flag，schema 依旧保留 recursive 给模型显式表达意图（backward-compat）

### 2.3 fs__read_file（servers/fs-mcp.ts:17-20）

```ts
{ name: 'read_file', ...,
  inputSchema: { type: 'object', required: ['path'], properties: {
    path: { type: 'string', description: '文件路径（必填）。例如: ./package.json' },
    offset: { ... }, limit: { ... } } } }
```

schema 本身没问题，required: ['path']。**但实现有 BUG**（见下一节 §3）。

---

## 3. MCP 实现 bug：fs-mcp `read_file` 静默默认到 `./package.json`

**servers/fs-mcp.ts:70**：

```ts
const path = (typeof args.path === 'string' && args.path.trim()) ? args.path.trim() : './package.json';
```

这个默认值直接**毁掉了整个错误反馈链路**：

1. 模型发 `arguments: ""`（本来应该报错）
2. MCP 默默读了 package.json 给回来
3. 模型以为自己读到了 README.md，基于错误内容继续做决策
4. 最终 hard.tool_called(path=README.md) 断言挂

**这个默认值应该立即删掉**。改成：

```ts
const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : null;
if (!path) return ok('read_file: "path" must be a non-empty string', true);
```

跟 fs-edit / write_file 行为一致（fs-edit:54 `if (typeof path !== 'string' || !path) return ok('file_edit: "path" must be a non-empty string', true)`）。

---

## 4. agent fallback 机制审计

通读 `src/agent.ts` + `src/agent/normalize.ts`：

### 4.1 已有的 retry/fallback

| 机制 | 位置 | 作用 |
|---|---|---|
| 500/502/503 重试 | agent.ts:75-93 `withRetry` | 仅 HTTP 5xx，重试 2 次，每次间隔递增；**本次场景就是 500 × 3 全挂** |
| 500 超限后截断历史重试 | agent.ts:570-610 | 收到 500 后截断上下文只留首条 user + 尾部，再试一次 |
| 同参数连续失败阻断 | agent.ts:724-740 | `MAX_SAME_ERROR = 2`，同 `${tool}:${JSON.stringify(args)}` 连错 2 次后返回"已尝试 N 次均失败"文本给模型，诱导换路径 |
| 空 tool_calls + 空 content 兜底 | agent.ts:704-716 | assistant 返回空 tool_calls 且 content 为空时推一条 "Please provide your answer" 再跑一轮 |

### 4.2 缺失的 fallback（本次失败场景都没被覆盖）

1. **没有 "tool_calls[].arguments 为空串 / 必需字段缺失" 的前置检查**
   - `normalizeArguments("")` → `{}`，agent 不知情就把 `{}` 发给 MCP → MCP 报错 → 错误消息回模型
   - 直接后果：本可以在 agent 层拦一下的问题被打成了 tool call 失败 → 模型再答 → 触发 500
   - 修复：在 `normalizeArguments` 后检查 `tools.find(t=>t.name===fullName).function.parameters.required` 是否都有；缺字段直接**不发 MCP、直接 push 一条结构化错误消息**回模型（"Missing required arguments: [path, old_string]. Please retry with all required fields."），避免无用 MCP roundtrip

2. **没有 "file_edit 失败 → 尝试 write_file" 的 fallback**
   - benchmark L2-001 的 hard_assertions 本身写的是 `tool_matches: "^fs(-edit)?__(file_edit|write_file)$"`，允许二选一
   - 目前 agent 不做 fallback，全靠模型自己知道要换
   - 修复（可选）：在 `same-args block` 那里加一个 hint："file_edit 已失败 N 次，考虑改用 fs__write_file 写完整新内容"

3. **没有 "grep on directory → auto -r" 的 fallback**
   - 这个更适合在 MCP 实现里做（见 §2.2），而不是 agent 层

4. **system prompt 没有 tool-call 示例**（agent.ts:345-380）
   - 现在只是英文说"Prefer dedicated tools over execute_command: read_file for reading..."
   - 对弱模型最管用的是**放一两个 JSON 格式示例**，比如 `"Example: call fs__read_file with {\"path\":\"./README.md\"}"`

---

## 5. 500 Error 怎么来的（间接根因）

从 debug log 看，每次 L2 失败的模式都是：
1. 先有一次 MCP 报错（"path must be non-empty" 或 "Is a directory"）
2. 紧接着的下一轮 `client.chat.completions.create` 返回 500

猜测 LM Studio 对某些消息序列敏感，可能是：
- **历史里有 `"tool" role content 是错误字符串 + 上一条 assistant 的 tool_calls.arguments 是空串 `""`** 的组合，导致 Qwen chat template 渲染出无效 prompt
- 或者 tool_call_id 串长度 + 错误消息长度导致某个缓冲区 overflow（LM Studio 是黑盒）

**验证办法**（不是本次交付，留给下一个人）：
- 用 `fs.writeFileSync` 把完整的 request body 存下来，手动 POST 给 LM Studio 看 500 具体哪条消息触发
- 把 agent.ts:556-560 的 dbg 扩展成记录完整 tool_calls 和 arguments，而不是只记 `tool_calls?.length`

退一万步：不管 500 根因是啥，**如果我们先把空 arguments 的问题堵住，下一轮请求的消息序列就是正常的，500 大概率也会消失**。

---

## 6. 具体修法建议（按优先级 + 改动量排序）

### P0 — 必须改（直接改好就能过一批 L2）

**6.1 删掉 fs-mcp read_file 的 path 默认值**

```diff
// servers/fs-mcp.ts:70
- const path = (typeof args.path === 'string' && args.path.trim()) ? args.path.trim() : './package.json';
+ const path = (typeof args.path === 'string' && args.path.trim()) ? args.path.trim() : '';
+ if (!path) return ok('read_file: "path" must be a non-empty string', true);
```

预期：L2-001 里模型拿到真实错误后会重试 → 填对 path → 通过。

**6.2 agent 侧增加 tool_call arguments 前置校验**

在 `agent.ts:726` 之后、发 MCP 之前：

```ts
const requiredMissing = checkRequiredArgs(fullName, args, tools);
if (requiredMissing.length > 0) {
  const msg = `Error: missing required arguments [${requiredMissing.join(', ')}] for tool ${fullName}. Retry with all required fields.`;
  yield { type: 'tool:result', ok: false, content: msg };
  messages.push({ role: 'tool', tool_call_id: tc.id, content: msg });
  errorHistory.set(callKey, prevErrors + 1);
  continue;
}
```

`checkRequiredArgs` 从 `tools` 拿 `parameters.required`，逐字段看 args 里是否存在且非空串。

预期：L2-005 里模型发 `{}` 给 fs-edit 会立刻拿到结构化错误，下一轮回填正确 args。**同时避免再次 MCP roundtrip 触发 500**。

### P1 — 建议改（提升 robustness）

**6.3 grep-mcp 对目录自动加 -r**

```diff
// servers/grep-mcp.ts:29
- const recursive = args.recursive === true;
+ let recursive = args.recursive === true;
+ try { if (statSync(path).isDirectory()) recursive = true; } catch { /* 交给下面报错 */ }
```

预期：L1-021 省一轮调用，弱模型也能过。

**6.4 强化 fs-edit / fs__read_file 的 description**

给 description 开头加示例 JSON，例：

```ts
// fs-edit-mcp.ts:12
description: '对已存在文件做精确字符串替换。示例: {"path":"src/x.ts","old_string":"foo","new_string":"bar","replace_all":true}。必须先用 read_file 读过目标文件。多处出现请同时传 replace_all:true。...'
```

### P2 — 可选（锦上添花）

**6.5 system prompt 增加 tool-call few-shot**

agent.ts:345 `baseSystemPrompt` 里加一段：

```
# Tool call examples
- Read a file: {"name":"fs__read_file","arguments":{"path":"./README.md"}}
- Edit a file: {"name":"fs-edit__file_edit","arguments":{"path":"src/a.ts","old_string":"x","new_string":"y"}}
- Search in a directory: {"name":"grep__grep","arguments":{"pattern":"foo","path":"src","recursive":true}}
```

对弱模型提升 tool-call JSON 合规率最直接。

**6.6 agent 发现 file_edit 反复失败 → 提示改用 write_file**

在 `same-args block` 的 `blockedResult` 里针对 file_edit 特化：

```ts
const blockedResult = fullName.endsWith('file_edit')
  ? `已尝试 ${prevErrors} 次均失败，请改用 fs__write_file 直接覆盖完整内容。`
  : `已尝试 ${prevErrors} 次均失败，请换个路径或方式。`;
```

---

## 7. 核对清单（给下一个接手的人）

- [ ] 先改 P0 两项（改动 < 30 行）后跑一次 `npm run benchmark -- --level L2`，看通过率
- [ ] 如果 L2-005（rename foo→bar）还挂，把 agent.ts:556 的 debug 扩展成 dump 完整 tool_calls 原文，查 qwen3.6-35b 的 chat template 问题
- [ ] L1-021 即便现在通过，也建议改 P1 §6.3 省一轮
- [ ] 500 Error 只要 P0+6.2 改完大概率会自动消失；如果仍出现，才需要按 §5 做 LM Studio 侧调查

---

## 附：本次调查实证文件

- `~/.my-agent/sessions/s_1777458998410_k8ee.jsonl` — L2-001 第一次 run（fs__read_file arguments=""）
- `~/.my-agent/sessions/s_1777459028413_ssm2.jsonl` — L2-001 第二次 run（同样空 arguments）
- `~/.my-agent/sessions/s_1777459050469_q4j6.jsonl` — L1-021 成功 run（grep 目录二次重试）
- `~/.my-agent/sessions/s_1777459124606_cd77.jsonl` — L2-005 run 1（fs-edit arguments=""）
- `~/.my-agent/sessions/s_1777459207052_mt4e.jsonl` — L2-005 run 2（同上，高复现）
- `~/.my-agent/sessions/s_1777459163309_84k7.jsonl` — L2-003 成功 run（对照组）
- `~/.my-agent/api-debug.log` — 所有 API request 摘要

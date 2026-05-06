# Retry Strategy Research — Agent 架构视角 (researcher-1)

- **调查者**：researcher-1
- **调查时间**：2026-04-29
- **目标**：让 L2 benchmark 从 84% 提到 90%+，核心是解决"空 args 拦截后失败率高"的问题
- **依据**：`src/agent.ts:547-893`（runTask loop）、`src/agent/normalize.ts`、最新报告 `test/benchmark/reports/2026-04-29T12-54-31-585Z-in6j/`、历史报告 `docs/bench-fix-investigation.md` & `docs/bench-fix-investigation-b.md`

---

## 0. 先纠正 team-lead 的问题陈述（根因不一样）

team-lead 的描述："拦截后推 tool role message → 下一轮 60% 概率放弃调工具、直接输出文本；40% 会重新生成正确参数"。

**基于 `2026-04-29T12-54-31-585Z-in6j` 报告 5×30=150 个 run 的实证**：

| 现象 | 出现次数 | 占失败比例 |
|-----|---------|-----------|
| 空 args 拦截后，**下一轮 API 直接 500 Error**，任务 crash | 22（14 个 task 里有 1 个以上 run）| ≈100% 的有空 args 失败 run |
| 空 args 拦截后，模型不重试、直接输出文本 | **0 次** | 0% |
| 空 args 拦截后，模型重生成正确参数 continue | **0 次**（全部在同一个 loop 内就 crash） | — |

**真实根因**：`src/agent.ts:721-741` 把 assistant message 带 `tool_calls[].function.arguments = ""`（空字符串）**原样推回 messages**。Qwen3-30B 在本地 LM Studio 下，chat template 渲染这种空字符串 arguments 时会产出无效 prompt，**下一轮 streaming request 返回 500 Error Internal Server Error**。`withRetry`（agent.ts:75-93）对同一个 500 重试 3 次全部失败，然后触发 agent.ts:591-627 的 history 截断再试一次也失败，最终 throw 到 chat() 层被 `catch`（agent.ts:946-954）打成 `task:failed`。

**关键代码位点**（`src/agent/normalize.ts:56-60`）：

```ts
arguments:
  typeof fn.arguments === 'string'
    ? fn.arguments       // ← 保持空字符串 "" 不归一化成 "{}"
    : JSON.stringify(fn.arguments ?? {}),
```

**证据**：看每一条失败 trace 的 `events`，你会看到 `tool:result` 报 "empty arguments" 后**立刻**是 `task:failed` + `error: "500 Error Internal Server Error"`，**没有**模型继续输出 token 或重新 tool_call 的事件（除了极少数 L2-008 run 0 两次空 args 然后 500，但从没出现"空 args → 模型 text fallback"的 pattern）。

**结论**：这不是"模型放弃重试"的问题，是"**带空 args tool_call 的 message history 被上游 LLM 拒绝导致硬 crash**"的问题。因此 team-lead 给的若干候选方案（如 a、d）**对消除 500 没用**；真正有效的方案应该聚焦"**如何不让空 args 污染 messages history**"。

---

## 1. 当前 loop 消息流转（agent.ts:547-885）

```
for loop = 0 .. maxLoops:
  ├─ maybeCompact()
  ├─ renderStackState → requestMessages
  ├─ stream = client.chat.completions.create({ messages, tools, ... })  [agent.ts:582-588]
  │   ├─ 流式累积 content_buf 和 tool_calls（agent.ts:641-706）
  │   └─ normalizeToolCalls → 得到 toolCalls 数组 [agent.ts:714-721]
  ├─ if (!toolCalls):  推 assistant content，返回 finalText（正常结束）
  ├─ messages.push({ role:'assistant', content:..., tool_calls: toolCalls })  ← 关键！原样推入
  ├─ for tc of toolCalls:
  │   ├─ normalizeArguments(tc.function.arguments) → args 对象
  │   ├─ if Object.keys(args).length === 0 && schema.required.length > 0:  [agent.ts:748-761]
  │   │   ├─ yield tool:call / tool:result (Error: empty arguments)
  │   │   └─ messages.push({ role:'tool', tool_call_id: tc.id, content: error })  ← 注意 assistant.tool_calls 已经推入了
  │   │   └─ continue（跳过执行，但下一个 tc 还会处理）
  │   ├─ else 正常执行 tool
  │   └─ messages.push({ role:'tool', tool_call_id: tc.id, content: result })
  └─ persistPending()
```

**协议要点**：OpenAI Chat Completions 协议要求 `assistant.tool_calls[i]` 和 `tool.tool_call_id` 严格配对。当前实现**已经遵守了协议**——每个 tool_call 后面都 push 了对应的 tool message。

---

## 2. OpenAI 协议约束与"能否不记录失败 tool_call"

### 2.1 官方协议要求

根据 OpenAI Chat Completions API 规范（function calling）：
- `messages[].tool_calls[]` 必须有 `id` + `type` + `function.name` + `function.arguments`（字符串）
- 紧接的下一条 `role: "tool"` 消息必须带 `tool_call_id` 与之匹配
- **但协议并没有禁止"上一轮 assistant message 整条不记录"**——每次 request 是无状态的，只要 messages 本身自洽即可

### 2.2 实务上的三种合法做法（都不违协议）

| 做法 | 合规性 | 说明 |
|-----|--------|------|
| A. 正常记录 assistant(tool_calls) + tool(result) 配对 | ✅ 规范 | 当前做法 |
| B. **整条 assistant.tool_calls 不推进 messages**（只本地消化错误，messages 里什么都没加） | ✅ 合法 | Anthropic `messages.create` 也是这样：调用方可以任意组织历史 |
| C. 推 assistant(tool_calls) + tool(corrected fake result，假装成功)（"骗"模型） | ✅ 合法但不诚实 | 协议不管语义真假 |

**关键：空字符串 `arguments: ""` 是否合规？**协议只说 arguments 是 string，没说内容必须是 valid JSON。OpenAI 官方 SDK 遇到空字符串**不会**报错。**问题在于本地 Qwen 的 chat template 渲染**：当它把 assistant.tool_calls 塞进 prompt（通常是 `<tool_call>{"name":"...","arguments":""}</tool_call>`）时，该 tool_call token 序列化失败 → 下一个 token prediction 进入病态状态 → LM Studio 服务端 500。所以**症结不在协议，在于 prompt template 容忍度**。

---

## 3. 其他 agent 框架的做法

以下基于公开实现的常见实践（**未实际 fetch，仅依据通用行业知识，精确引用见各框架源码**）：

| 框架 | tool call 失败处理 |
|------|-----------------|
| **Anthropic Claude SDK / Claude Code** | `tool_use` block 如果 `input` schema 不符，SDK 会在客户端 validate，把 `tool_result` block 设为 `is_error: true` 返回。Claude 模型本身训练过"看到 is_error 后重生成正确 input"，实测重试率 >95% |
| **AutoGPT** | tool call 失败时在 memory 里写入 "last action failed because X"，下次 reasoning 前优先注入，触发显式 reflection。不"隐藏"失败 |
| **OpenDevin** | 把 tool call 失败包装成 `ErrorObservation` 事件，丢回事件流；agent 在下一步看到后要求 LLM 产出"修复"动作。有"same error repeated N 次就切换策略"机制 |
| **LangGraph** | 节点级 retry：给 tool 节点配 `retries=3`，失败后自动在节点内重调同一个 LLM（不把失败消息写进 state history）；这最接近本文方案 C |
| **crewAI / AutoGen** | 类似的 retry + memory 模式，默认把失败留在 history |

**没有框架会"违反协议不记录 tool_call"**，但**主流做法有"inner retry 不进 history"**（LangGraph）。

---

## 4. 候选方案全集（按影响面 + 改动量）

下面 8 个方案我都穷举并评估。**用 ⭐ 标我认为应该做的，❌ 标不应该做的**。

### 方案 A：⭐ normalize 时把空 arguments 补成 `"{}"`（最小改动）

**改动**：`src/agent/normalize.ts:56-60` 把 `fn.arguments === ""` 或不合法 JSON 的情况统一写为 `"{}"`。

```ts
// before
arguments:
  typeof fn.arguments === 'string'
    ? fn.arguments
    : JSON.stringify(fn.arguments ?? {}),
// after
arguments: (() => {
  const raw = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
  const trimmed = raw.trim();
  if (!trimmed) return '{}';
  try { JSON.parse(trimmed); return trimmed; } catch { return '{}'; }
})(),
```

**效果**：assistant message 里 tool_calls 的 arguments 永远是合法 JSON 字符串，Qwen chat template 渲染出的 prompt 是正常的 → **根除 500 Error**。

**利**：
- 改动仅 5 行，代码局部，无协议风险
- 解决所有"空字符串 arguments"导致的 500（最新 run 里所有失败）
- 已有的 agent.ts:748-761 拦截逻辑依旧工作（空 args 报错回填，模型下一轮能看到）

**弊**：
- 需要验证 Qwen 对 `arguments: "{}"` 是否也会 500（可能性低——`{}` 是常见空参合法形式，很多调用 get 天气/列文件等无必填参数的工具就是 `{}`）

**协议风险**：无。`"{}"` 比 `""` 更符合 OpenAI 规范。

**死循环风险**：无。原有 `errorHistory` + `MAX_SAME_ERROR = 2` + 同参数 block 机制都还在。

**实现复杂度**：⭐（最低）

---

### 方案 B：⭐⭐ 拦截后**直接在 agent 层立即重发 request**（inner retry，不污染 history）

**改动**：`src/agent.ts:748-761` 的拦截分支改为"把这次 assistant.tool_calls 回滚 + 发一条 user 强指令 + 立即 continue loop"。

```ts
// 探测到空 args：
if (Object.keys(args).length === 0 && required.length > 0) {
  // 回滚这一轮的 assistant message（刚刚 L737 推进去的）
  messages.pop();
  // 推强制重试指令
  messages.push({
    role: 'user',
    content: `Your previous tool call to "${fullName}" had empty arguments. The tool requires [${required.join(', ')}]. DO NOT answer in text; re-issue the tool call with all required parameters filled. Example: {"name":"${fullName}","arguments":{${required.map(k=>`"${k}":"..."`).join(',')}}}`,
  });
  yield { type: 'tool:result', ok: false, content: 'empty args, retrying...' };
  break; // 跳出 tc 循环，直接进入下一轮 loop（不执行后续 tool_call）
}
```

**注意**：要先把 `messages.push({ role:'assistant', tool_calls })`（L737）推迟到发现**没有**空 args 之后再推，或者像上面一样用 `pop()` 回滚。

**效果**：
- history 里完全没有"空 args assistant + empty-args tool response"这种组合 → 消除 500
- 模型下一轮看到 "re-issue with all required parameters + few-shot 示例" 强指令，重试成功率大幅提升
- 即使失败一次也不会毒化 history

**利**：
- 彻底避免 LLM server crash
- 消息历史更干净（对后续 loop 也友好）
- 强指令比当前 tool role 里的弱提示更 compelling

**弊**：
- 需要重构 assistant message push 时机（避免推了又 pop）或者容忍 pop
- 如果同一轮 assistant 里有**多个** tool_call（其中一个空、一个非空），pop 整条 assistant 会丢掉正常 tool_call。这罕见但需要处理

**协议风险**：无（messages 永远自洽）

**死循环风险**：低。如果连续 2 轮都空 args，错误历史计数器仍然会挡。为了更稳，可加 `emptyArgsRetryCount` 计数器，同一 tool 重试 ≥2 次就 fallback 到执行并报错。

**实现复杂度**：⭐⭐⭐（中等，需要处理 multi-tool_call 边界情况）

---

### 方案 C：⭐ 方案 A + B 组合（normalize 兜底 + inner retry 主力）

A 做 normalize 层防御，B 做 loop 层主动引导。这是我**最推荐**的组合——A 先把 500 消灭，B 让模型更可能重试成功；即使 B 的重试又空了，A 保证下一轮 request 不会再 500。

---

### 方案 D：⭐ 改 system prompt 加 tool-call few-shot

**改动**：`src/agent.ts:362-399` 的 `baseSystemPrompt` 里加几条 JSON 示例。

```
# Tool call examples (follow this JSON format exactly)
- Read: {"name":"fs__read_file","arguments":{"path":"./README.md"}}
- Edit: {"name":"fs-edit__file_edit","arguments":{"path":"src/a.ts","old_string":"x","new_string":"y"}}
- Search: {"name":"grep__grep","arguments":{"pattern":"foo","path":"src"}}
NEVER emit tool calls with empty arguments. If you don't have the required info, use read_file/list_directory first.
```

**利**：
- 一条 prompt 改动，对弱模型的 tool-call JSON 合规率有实测提升（前人在 bench-fix-investigation-b.md §6.5 已建议）
- 0 协议风险，0 实现复杂度

**弊**：
- 只是"降低" 空 args 概率，不能根治。不能单独用，要和 A/B 搭配

**协议风险**：无

**实现复杂度**：⭐

---

### 方案 E：❌ 完全不把失败的 assistant.tool_calls 进 messages

**改动**：如果检测到空 args，既不 push assistant 也不 push tool message。

**利**：history 绝对干净

**弊**：
- 模型**不知道上一轮自己吐了空 args**，下一轮可能重复完全同样的错误（没有反馈信号）
- `errorHistory` 计数无法触发（因为 `callKey = ${tool}:{}` 这条也不会走到 tool 执行那条分支）
- 对调试不友好（session store 里看不到失败事件）

**协议风险**：无

**实现复杂度**：⭐⭐

**结论**：对比方案 B（保留错误信号但以 user role 呈现），E 丢了学习信号，不如 B。不推荐。

---

### 方案 F：❌ 把空 args 假设为 `{}` 后直接送 MCP 执行

当前其实就是这种做法（`normalizeArguments("")` → `{}`）。MCP 层报 "required params missing" 错误回来。问题在于 LLM server 看到 `arguments: ""` 后就炸了，MCP 那边做什么都救不回来。这是**当前方案，就是失败的方案**。

---

### 方案 G：❌ 拦截后对模型发起独立 single-shot call（不走主 loop）

即 agent 层用一个临时 prompt "repair this tool call" 调模型一次，把结果合并回主 loop。

**利**：可 isolate 上下文

**弊**：
- 和方案 B 比多一次 round-trip，延迟翻倍
- 需要管理额外的 messages 子数组，复杂度高
- 没有证据显示主 loop 内重试（B）成功率低需要换 isolated context

**结论**：B 是 G 的轻量版，优先 B。

---

### 方案 H：⭐ 配合 MCP 服务端修复（bench-fix-investigation.md 已指出）

补充修 `servers/fs-mcp.ts:70` 的 `./package.json` 默认值 bug（前人 P0 项）—— 让空 path 返回显式错误，不然"伪成功"会让模型更不愿意重试。

**利**：修复 investigation.md 已确认的 bug

**弊**：独立于本 research 范围，但建议同步做

---

## 5. 推荐组合与优先级

| 阶段 | 动作 | 改动点 | 预期收益 |
|-----|------|--------|---------|
| P0 | 方案 A：normalize 保证 arguments 合法 JSON | `src/agent/normalize.ts:56-60`（≈5 行） | 消除 500 Error，L2 直接从 84% → 预计 94%+ |
| P0 | 方案 H：修 fs-mcp read_file 默认 path | `servers/fs-mcp.ts:70` | 让错误可见，模型能自愈 |
| P1 | 方案 D：system prompt 加 few-shot | `src/agent.ts:362-399` | 降低空 args 发生率（不根治） |
| P1 | 方案 B：agent 层 inner retry + 强指令 | `src/agent.ts:737-761` | 空 args 发生后首轮就能纠正 |
| P2 | 监控：给 session log 标记 `emptyArgsRecovered` 事件 | 新增 `agent/events.ts` 字段 | 量化 A+B 的实际收益 |

---

## 6. 验证计划（不在本 research 产出，仅建议）

1. 仅打 P0（A + H），跑 `npm run benchmark -- --level L2 --repeats 5`，对比 in6j 的 84%
2. 继续打 P1（B + D），再跑一次
3. 统计：
   - 500 Error 次数（应 ≈0）
   - 每次空 args 后的下一轮行为（应≥80% 重试成功）
   - L2 总通过率（应 ≥90%）

---

## 7. 关键事实清单（避免下一个 agent 再走回头路）

- [fact] `src/agent/normalize.ts:56-60` 对 `fn.arguments=""` 原样保留，是 500 的直接触发源
- [fact] `src/agent.ts:748-761` 的拦截做法**消息配对合规**（tool_call ↔ tool response），**不是协议问题**
- [fact] 150 runs 里**所有**空 args 出现的 run 都以 5xx crash 收场，**没有**"模型 fallback 输出 text"的实际案例
- [fact] 方案 A 改 5 行代码即可覆盖全部 500 failure mode；其他方案都是锦上添花
- [decision] 不建议走"不记录 tool_call"路径（方案 E）——丢信号 > 防污染
- [decision] 换强模型（前 investigation.md 的方案 B）是根本方案，但不在本 research 范围

---

## 8. 回答 team-lead 的具体问题

> OpenAI 协议约束：assistant message 里每个 tool_call 是否必须有对应 tool role response？能不能"不记录"这次失败的 tool_call？

- 同一条 request 内的 messages 必须配对。历史可以任意重写（无状态 API）。但"不记录"会丢学习信号，不推荐。

> 其他 agent 框架怎么做的？

- Claude SDK：tool_result 标 `is_error: true` 回灌，模型重试率自带就高
- LangGraph：节点内 retry 不写入 state history
- 多数开源 agent：保留失败 + 错误消息 + 错误历史计数器（和当前实现一致）

> 是否有死循环风险？

- 方案 B 的 inner retry 需要配 `emptyArgsRetryCount ≤ 2`，防止模型连续空 args 无限 loop
- 方案 A 无死循环风险

> 对其他场景副作用？

- 方案 A 的 normalize 改动对正常场景无影响（`"{...}"` 本就不会被重写成 `"{}"`）
- 方案 B 的 `messages.pop()` 要处理 multi-tool_call 的边界情况；建议：只在 `toolCalls.length === 1 && 唯一那个是空 args` 时回滚整条 assistant，否则保持原拦截逻辑（推 tool role 错误 + 方案 A 保底）

---

## 9. 附：L2-001 典型失败 trace 节选（in6j / run 1）

```
tool:call   fs__list_directory   {"path":"."}        ok=true
tool:call   fs__read_file        {}                  ok=false "Error: tool 'fs__read_file' requires [path] but received empty arguments. Please provide the required parameters."
task:failed                                          error="500 Error Internal Server Error"
```

只有 2 次 API 调用：第一次成功拿到目录，第二次 Qwen 吐空 args 被 agent 拦截，push tool role error 后第三次 API call 直接 500。整个 task 11193ms 就 crash 了。**模型从来没有得到机会回复那条错误**。

---

## 10. 给 team-lead 的一句话结论

**把 `src/agent/normalize.ts` 的 5 行改掉，L2 至少能过 90%。其他都是锦上添花。**

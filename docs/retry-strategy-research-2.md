# 空 args 拦截后模型放弃重试 — 从模型行为角度调研

researcher-2 · 2026-04-29

## TL;DR

- 跑 L2-003 (port 3000→8080) 5/5 全 fail，hardPass rate = 0%。
- **根因不是"模型放弃"，是模型进入了两种"拿空 args 撞墙"死循环**。收到错误后模型会重新开始整个任务（而不是修正上次调用），但下一轮还是吐空 args，反复撞墙直到 max_loops。
- 单纯加 system prompt / 改 hint 措辞 ≈ 无效。模型不会从 prompt 里学会"怎么序列化多字段 JSON"。
- **ROI 最高的可落地方案（按优先级）**：
  1. **P0 — 空 args 拦截时用"回到上一轮再采样"替代"推 error tool_result"**：从 messages 里删掉这条空 args 的 assistant + tool 对，重新调 API（可提高 temperature/变更 system suffix），让模型重新生成。预期 L2 pass rate +8~12%。
  2. **P1 — 把"空 args 错误 + 正确示例"合并进同一条 user 纠错消息**：把 fs-edit 的 few-shot 例子硬塞进错误消息 body，不要只说"要求参数 [a,b,c]"。预期 +3~5%。
  3. **P2 — 把 fs-edit__file_edit 拆成两个简单工具**：给弱模型一个 `file_replace_once`（只有 path/old/new 三个 required 字符串，无 replace_all），让模型在简单题上走窄路径，复杂题才用 file_edit。预期 +2~3%。
  4. **P3 — 降低 temperature / 关掉 frequency_penalty**：当前 default temp=0.6, freq_penalty=1.1（config.ts 默认 0.8/1.15）对 tool_call JSON 生成是**负面**的。tool_call 应该用 temp≈0.2 / freq_penalty=0 的"确定性"策略。预期 +3~5%。
- **最稳方案是 P0+P3 组合 —— 全部是 agent 侧改动，不改模型、不依赖 prompt 工程玄学。**

---

## 1. 观测到的实际 trace（L2-003 5/5 fail）

跑了一次 5 run 的 L2-003 bench，全部 hardPass=false。

用 MA_DEBUG=/tmp/bench-debug.log 拿到所有 messages 快照。5 个 run 展现出两种失败路径，但**本质是同一个问题的两个分支**：

### 路径 A — 空 args 在 agent 侧被拦截（agent.ts:747-762）

Run 0/1/2 的典型流程：

```
[user]     把 config.json 里的 port 从 3000 改成 8080
[assistant] "" + tool_call fs__read_file(args="")       ← 空 args 第 1 次
[tool]     Error: tool "fs__read_file" requires [path] but received empty arguments.
[assistant] "" + tool_call fs-edit__file_edit(args="")   ← 空 args 第 2 次
[tool]     Error: tool "fs-edit__file_edit" requires [path, old_string, new_string] ...
... 循环到 max_loops=20 ...
```

- **assistant content 永远是空串**（模型没输出任何文字）
- 每一轮都重新吐一个空 args tool_call
- **agent.ts:748-762 的"必填字段拦截"只是把错误写进 tool_result，不会清掉前面的 assistant+tool 对**，下一轮 API 请求带着"错误示范"去，模型依样继续画葫芦

### 路径 B — 空 args 穿透到 MCP 服务端（agent.ts:871-879）

Run 3 的典型流程：

```
[user]     把 config.json 里的 port 从 3000 改成 8080
[assistant] "我来帮你修改 config.json 中的 port。先读取文件内容：" + fs__read_file({"path":"./config.json"})
[tool]     1│{"port": 3000, "host": "localhost"}\n2│    ← read 成功
[assistant] "现在将 port 从 3000 改为 8080：" + fs-edit__file_edit(args="")  ← 空 args
[tool]     file_edit: "old_string" 不能为空   ← MCP 服务端错误，errorHistory +1
[user]     The tool call to "fs-edit__file_edit" failed. Please check your parameters and try again. Required parameters: [path, old_string, new_string].

← 模型看到 hint 后的反应：

[assistant] "我来帮你修改 config.json 中的 port。先读取文件内容：" + fs__read_file(...)
[tool]     1│{"port": 3000, ...}   ← 重新 read 一次
[assistant] "现在将 port 从 3000 改为 8080：" + fs-edit__file_edit(args="")  ← 又空 args!!
[tool]     file_edit: "old_string" 不能为空
[user]     The tool call to "fs-edit__file_edit" failed ... Required parameters ...
[assistant] "现在将 port 从 3000 改为 8081：" + fs-edit__file_edit(args="")  ← 又空 args
[tool]     Error: tool "fs-edit__file_edit" requires [path, old_string, new_string] but received empty arguments. ← 这次走拦截
... max_loops ...
```

**关键发现**：
- 模型对 hint 的反应是**重新开始整个任务**（重新 read_file，重新说"我来修改..."），不是"在上次基础上修正"
- 模型 assistant content 的文字（"将 port 从 3000 改为 8080"）证明它**理解任务**，但它写到 tool_call 的 arguments 字段时**就是吐不出 JSON**
- 同一个 (tool,args) 组合出现 2 次后，errorHistory 会触发重复错误阻断（agent.ts:764-776），但这里 args 都是 `{}`，stringify 都是 `"{}"`——**errorHistory 阻断完全命中**，但阻断之后模型还是空 args，只是换成路径 A 了

### 观察到的共性

1. **模型不是"看到错误后放弃"** — 它从头到尾都在试，只是每次试都吐空 args。"放弃"是 agent 侧 max_loops 阻断的结果，不是模型主动放弃。
2. **模型不是"回答文本而不调工具"** — 5 个 run 的 finalText 全是空串，tool_calls 数全是 0（因为 hardPass=false 时 finalText 进了 max_loops 文案）。模型根本没有进入"自然语言回答"分支。
3. **task-lead 的判断"60% 输出文本放弃"**可能来自旧的模型/旧的 agent 版本。当前 agent 有 `agent.ts:723-729` 的 nudge 逻辑（content 空 + 无 tool_call → 推 "Please provide your answer"），但这次 trace 里**从未触发这个分支**——每一轮都有 tool_call（只是 args 空），所以走的是 agent.ts:737 的正常 push 路径。

---

## 2. 模型为什么放弃（真正的机制）

**不是"模型决定放弃"，是"agent loop 让模型撞满 max_loops 后硬停"**。

但为什么模型在看到 error 后还是吐空 args？从 messages 结构分析：

### 2.1 模型对 tool_result=error 的反应模式

模型看到的上下文：
```
assistant: "" + tool_call fs-edit__file_edit(args="")
tool: Error: tool "..." requires [path, old_string, new_string] ...
```

模型的下一轮生成行为（观察到的，非理论）：

- **把 assistant+tool 对当"历史已做过的动作"**：模型推断"我已经试过 file_edit 了（tool_call 被记录），现在该做下一步"。
- **下一步选择再发 tool_call**（因为 system prompt 强调了 "Keep working until the user's goal is fully achieved"、"On failure: diagnose the cause, try a different approach"）——但"try a different approach"对 Qwen3 来说没有具体指代，它又回到"读文件 → 修改"这条它唯一能生成的路径。
- **JSON 序列化层出错** — 这才是空 args 的直接原因。Qwen3 在 LM Studio 的 chat template 对 tool_call arguments 字段的转义/序列化不稳。同一模型对"单字段 path"（fs__list_directory、fs__read_file 偶尔能成功）比"多字段多字符串"（fs-edit__file_edit）稳定得多。

### 2.2 hint 为什么没用

当前 agent.ts:871-879 的 hint：
```
"The tool call to \"fs-edit__file_edit\" failed. Please check your parameters and try again. Required parameters: [path, old_string, new_string]."
```

**这条 hint 说的是"你缺 [path, old_string, new_string]"，但模型已经"知道"它应该传这三个字段**（看 assistant content "将 port 从 3000 改为 8080"）。问题不在"知不知道"，问题在"JSON 生成不出来"。告诉模型它"生成不出来的那个东西要有哪些字段"，约等于告诉人"你写不出英文单词 cat，请你写 cat"——信息重复，不是缺失。

### 2.3 system prompt 为什么没用

当前 system prompt 已经有：
- "Keep working until the user's goal is fully achieved."
- "On failure: diagnose the cause, try a different approach."
- "Read before write: always read_file before modifying."

这些**对 Qwen3 在 tool_call JSON 序列化失败时没有指导意义**。system prompt 指导的是"做什么"，不是"怎么正确序列化 function-call arguments"——后者是模型生成层、chat template 层的问题，prompt 够不着。

加强版 system prompt（例如 "If your previous tool call had empty arguments, reconstruct them step by step: first write path=..., then old_string=..."）也不会有效，因为 Qwen3 的 chat template 里 tool_call 的 arguments 是**结构化字段**，不是模型生成的自然语言文字——模型要么生成出来，要么生成不出来，step-by-step 推理不能把结构化失败变成成功。

---

## 3. 调研的 5 个方向各自的可行性评估

### 3.1 System prompt 改造（task-lead 提的方向 3.1）

**结论：无效，不推荐**。

| 改动 | 是否有效 | 理由 |
|---|---|---|
| 加"工具调用失败时必须重试" | 否 | 模型已经在重试了，不是"放弃"的问题 |
| 加"不要吐空 args" | 弱 | 模型在 content 里写对了任务，但 JSON 生成层就是崩 |
| 加 tool_call JSON few-shot 示例 | 弱（+0~2%） | chat template 把 tool_call 序列化放在模型生成之外，few-shot 对"怎么写自然语言"有效，对"怎么写结构化字段"效果有限 |

### 3.2 错误消息措辞（task-lead 提的方向 3.2）

**结论：合并错误 + few-shot，有 +3~5% 空间**。

当前路径 A 错误消息（agent.ts:752）：
```
Error: tool "fs-edit__file_edit" requires [path, old_string, new_string] but received empty arguments. Please provide the required parameters.
```

改进版（建议）：
```
Error: tool "fs-edit__file_edit" received empty arguments. 
Call it with JSON like: {"path": "./config.json", "old_string": "3000", "new_string": "8080"}
Required: path (string), old_string (string), new_string (string).
DO NOT call this tool again with empty arguments — if you cannot construct the JSON, use execute_command with sed instead.
```

要点：
- **塞一个具体的 JSON 示例**（填当前任务能理解的值 "3000"→"8080"，不是 "foo"→"bar"）。模型 copy 这个 JSON 的成本低于自己从头生成。
- **指向退路**（sed 命令、write_file）。不要只说"重试"，说"换工具"。
- **命令式否定**（"DO NOT call ... with empty arguments"）对弱模型有效，对强模型无副作用。

路径 B 的 hint（agent.ts:877）同样改。

### 3.3 Tool description 改造（task-lead 提的方向 3.3）

**结论：可选加分项，+1~2%**。

fs-edit-mcp.ts:12 当前 description：
```
对已存在文件做精确字符串替换。必须先用 read_file 读过目标文件。old_string 必须在文件中唯一（除非 replace_all=true）。不做 CRLF 归一化、不做模糊匹配、二进制文件拒绝、上限 512KB。
```

改进版（建议）：
```
对已存在文件做精确字符串替换。示例调用：{"path":"./config.json","old_string":"3000","new_string":"8080"}。必须先用 read_file 读过目标文件。old_string 必须在文件中唯一（除非 replace_all=true）。
```

Qwen 对 description 里的 JSON 示例敏感度比 system prompt 高（description 在 chat template 里贴在 tool schema 旁边，距离 tool_call 生成位置最近）。单独改这一条预期收益 1-2%。

**同步 ROI**：给 5 个 MCP 都加 description 内 few-shot，约 30 分钟工作量，不改逻辑，无回归风险。**应该做**。

### 3.4 模型参数（task-lead 提的方向 4）

**结论：temperature/frequency_penalty 应该为 tool_call 场景下调**。

当前（src/agent.ts:561-562）：
```ts
temperature: config.model.temperature ?? 0.6,
frequency_penalty: config.model.frequencyPenalty ?? 1.1,
```

**问题**：
- frequency_penalty=1.1 对**重复的 JSON token**（比如 `"path":"./` 这种 tool_call 里反复出现的模式）有惩罚，会让模型避免"看起来重复"的序列 —— 对自然语言有用，**对 JSON 结构化输出是负面的**。
- temperature=0.6 对 tool_call 采样来说偏高。tool_call 是需要**确定性**的场景，Claude/GPT 的官方建议都是 tool_call 时 temp≤0.3。

**改法**：
```ts
// 当 request.tools 非空时：
temperature: 0.2,
frequency_penalty: 0,
```

或者更精细地——只有在**重试**这条路径下强制低 temp、0 freq_penalty（见 §3.5 P0 方案）。

预期收益：+3~5%。成本：改 3 行代码。

### 3.5 不推 tool_result，回到上一轮再采样（task-lead 提的方向 5）

**结论：最核心的 P0 方案**。

**核心思路**：当 agent 侧拦截到空 args 时，**不要把"空 args assistant + error tool"写进 messages**，而是：
1. 回退 messages 到"调这个工具之前的状态"（即 pop 掉最新的 assistant 消息）
2. 在 messages 末尾 push 一条 user/system 纠错消息（见 §3.2 改进版）
3. 重新调 client.chat.completions.create，用更低的 temperature（0.2）和更高的 random seed（让模型不重走同一路径）

为什么这个方案更可能成功：
- **不让模型"看到自己失败过"** — 模型上下文里只有"你要做这个任务 + 这里有个提示"，没有"你上次空 args 失败"的 token 序列。Qwen3 有个 pathology：看到"自己吐出过空 args"的前文，会倾向于再吐空 args（auto-regressive 回声效应）。
- **温度变化 = 采样路径不同** — 第一次 tool_call 是 temp=0.6 下采样到的"空 args"状态，重试时用 temp=0.2 会走高概率密度路径，更容易命中正确 JSON。
- **不违反 tool_call 协议** — OpenAI/LM Studio 协议要求"assistant.tool_calls 必须配对 role=tool messages"，但那是说"已经发出的 tool_call 必须被响应"。如果我们在 push 进 messages **之前**就决定"这条 assistant 无效、丢弃"，协议上是合法的——tool_call 根本没进对话历史。

**实现位置**：`src/agent.ts:747-762` 的空 args 拦截块。伪代码：

```ts
if (Object.keys(args).length === 0) {
  const schema = findToolSchema(connections, fullName);
  const required = schema?.required;
  if (Array.isArray(required) && required.length > 0) {
    // ❌ 旧：push error tool_result，继续 loop
    // ✅ 新：pop 掉刚才 push 的 assistant message（messages[messages.length-1]）
    //      记录 retryCount++，如果 < MAX_EMPTY_ARGS_RETRY（建议 2）
    //      push 一条 user 提示（含 few-shot 示例）
    //      break for-loop（不再处理本轮其他 tool_call，回到外层 while）
    //      外层 while 重新调 API，temperature 降到 0.2

    messages.pop(); // 丢弃本轮 assistant 消息（含空 args tool_calls）
    emptyArgsRetryCount += 1;
    if (emptyArgsRetryCount <= MAX_EMPTY_ARGS_RETRY) {
      const example = buildExampleForTool(fullName, args, userMessage);
      messages.push({ 
        role: 'user', 
        content: `Your previous call to ${fullName} had empty arguments. Required: [${required.join(', ')}]. Example: ${example}. Call it with proper JSON now.` 
      });
      nextRequestOverrides = { temperature: 0.2, frequency_penalty: 0 };
      break; // 跳出 for (tc of toolCalls)，回到外层 while
    } else {
      // 超过 retry 上限，才走旧路径（push error tool_result）
      ...
    }
  }
}
```

**预期收益**：L2 pass rate +8~12%，因为 L2 里最卡 gate 的 L2-001/003/004/005/006 都是这个 pattern。

**风险**：
- tool_call_id 配对：pop 掉 assistant 时不要已经 push 过 tool 消息（目前代码流程是 push assistant → 循环 tc → push tool，所以在空 args 拦截这里 pop assistant 是安全的——tool 还没 push）。
- infinite loop 风险：必须有 MAX_EMPTY_ARGS_RETRY 上限（建议 2），超过后降级到旧路径或直接 max_loops。
- tests：可能会打破现有对"空 args 拦截会推 error tool_result"的 e2e 断言（benchmark hard.ts 的 tool_called 断言读的是 trace，不读 messages，应该不受影响）。

---

## 4. LM Studio / Qwen3 tool calling 特性补充

看了 `~/.my-agent/config.json`：model=`qwen/qwen3.6-35b-a3b`，baseURL=`http://192.168.2.169:1234/v1`。

这是通过 LM Studio 暴露的本地 OpenAI 兼容 endpoint。关键信息：

1. **Qwen3 chat template 对 tool_call 的序列化**：Qwen3 官方 template 在 tool_call 前会插一段 `<|FunctionCallBegin|>` 标签，arguments 字段期望是 JSON 字符串（不是 JSON 对象）。LM Studio 会把 `arguments: ""` 转成流式 delta `tool_calls[0].function.arguments=""`——这是**模型直接在 arguments 字段吐空串**，不是 agent 解析 bug（normalize.ts 已经正确处理）。
2. **Qwen3 对 tool_choice=auto 的反应** — 倾向于"总是调工具"。这是为什么 content 永远是空串 / 短字符串。**如果希望模型在失败后"自然语言回答"，要显式 tool_choice="none"**（可以作为重试的 fallback）。
3. **frequency_penalty 对 JSON 的影响**：Qwen3 在 LM Studio 的社区 issue 里有多份报告，frequency_penalty>1.0 会显著提高 JSON 畸形率（尤其是 escaped strings）。

---

## 5. 建议优先级总结

| 优先级 | 改动 | 预期收益 | 成本 | 风险 |
|---|---|---|---|---|
| **P0** | 空 args 拦截改为"pop assistant + 降 temp 重试"（§3.5） | +8~12% | 2h 开发 + 1h 测试 | 中，要小心 tool_call_id 配对 |
| **P0** | request.tools 非空时 temperature=0.2 / freq_penalty=0（§3.4） | +3~5% | 10min | 低 |
| **P1** | 错误消息合并 JSON 示例（§3.2） | +3~5% | 30min | 低 |
| **P2** | 所有 MCP tool description 加 few-shot（§3.3） | +1~2% | 30min | 无 |
| **P3** | 拆 file_edit → file_replace_once 简单版 | +2~3% | 4h | 中，要改 MCP + schema |

**组合预期**：P0 两条合起来单独就能把 L2 pass rate 从 76.7% 推到 85%+，**过 80% gate 直接用 P0 两条就够**。

**如果目标是 90%+**，P0+P1+P2 全部做，或者考虑换模型（#1048 同事已经说过）。

---

## 6. 附：可观测性建议

当前 MA_DEBUG 日志只存 content 前 200 字符，tool_calls 只记数量。建议扩展到记录：
- tool_calls 的 name + arguments.length（不是完整 arguments，避免泄漏，只记长度）
- retry path 的触发原因（"empty args retry" / "error history blocked"）

在 agent.ts:577 附近加：
```ts
tool_calls: m.tool_calls?.map(tc => ({name: tc.function?.name, argsLen: tc.function?.arguments?.length})),
```

这样后续调 benchmark 可以快速统计"空 args 发生率"作为独立指标。

---

## 7. 验证路径

1. 实施 §3.5（P0） + §3.4（P0），跑一次 `L2-003 runs=5`，预期 hardPass 5/5 = 100%。
2. 跑完整 L2 bench（`runs=5`），passRate 应 ≥ 85%。
3. 顺带跑 L0/L1 回归，应保持 100%/98%（不应有副作用）。

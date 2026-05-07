# ma CLI OOM 排查报告 — ink UI + session 持久化方向

调查者：leak-hunter-b
场景：用户问"介绍每一条 commit 都更新了什么"，agent 连续调用 7 次 git show 工具，52 秒后 Node.js heap（4GB）爆。
Stack 关键帧：`Builtins_SetConstructor` + `Builtins_ArrayMap`。

## 结论速览（嫌疑排序）

| # | 嫌疑点 | 位置 | 严重度 | 关系 |
|---|---|---|---|---|
| 1 | `inFlightText` 字符串无限拼接 + 每 token 全量重渲染 | `store.ts:58-60`, `App.tsx:197-201` | 高 | 直接放大 `Builtins_ArrayMap`（Yoga layout map） |
| 2 | `Markdown` 组件每次 token 全量 re-lex + 递归建组件树 | `Markdown.tsx:11-20`, `markdown-lex.ts:3-5` | 高 | lexer 对每个新 tokens 数组做 `.map`；和 1 搭配指数级 |
| 3 | `messages` 数组 push 走 `[...old, new]` 全拷贝 | `store.ts:29` | 中 | 每次 tool/token 事件都拷贝；不是主因但放大 GC 压力 |
| 4 | 每次 API 调用把整组 requestMessages stringify 到 debug log + 同步写盘 | `agent.ts:580-589` | 中 | `JSON.stringify(dbg, null, 2)` 生成大字符串；tool_calls 没截 |
| 5 | MCP stdout buffer O(n²) slice | `mcp/client.ts:84-93` | 中 | 单 chunk 含多行时反复拷贝剩余 buffer |
| 6 | Session `appendFileSync` 同步 I/O + 每条消息整条 JSON.stringify | `session/store.ts:72-80` | 低 | 会卡主线程但不直接 OOM |
| 7 | `tool:result` 对 event.content 做 regex+split | `useAgent.ts:52-56` | 极低 | content 已在 `agent.ts:878-880` 截到 400 字，排除 |

Stack trace 里 `SetConstructor` 对应的最可疑位置是 React/Ink 内部 Fiber reconciliation 产生的 Set（或者 Yoga layout 内部），**不是** 我们代码里的 `new Set<Listener>()`（那个只在 store 创建时调用一次）。`ArrayMap` 对应的是 `tokens.map` / `messages.map` / Ink 对子节点数组的迭代。

---

## 1. `inFlightText` 无限拼接 + 每 token 全树重渲染（主嫌疑）

### 代码路径

`src/cli/state/store.ts:58-60`：
```ts
appendToken(text: string) {
  state = { ...state, inFlightText: state.inFlightText + text };
  notify();
}
```

`src/cli/hooks/useAgent.ts:67-71`：
```ts
case 'token':
  store.appendToken(event.text);
  break;
case 'text':
  store.appendToken(event.content);
  break;
```

`src/cli/App.tsx:53-54, 197-201`：
```ts
const state = useSyncExternalStore(store.subscribe, store.getState);
const { messages, thinking, inFlightText } = state;
...
{inFlightText ? (
  <Box marginTop={1}>
    <Markdown source={inFlightText} />
  </Box>
) : null}
```

### 放大路径（7 次 git show 场景）

1. 用户问"介绍每一条 commit"后，LLM 逐条生成文本回复。
2. 每来一个 token 字符（中文一般 1-4 字符/delta），`appendToken` 创建 **新字符串**（旧内容 + 新 token 全量复制），**新 state 对象**（浅 spread），`listeners.forEach` 通知订阅者。
3. `useSyncExternalStore` 触发 React 整棵 App 重渲染。
4. `<Markdown source={inFlightText} />` 被传入越来越大的 `source`——从 0 字符涨到几千/几万字符（假设 7 次 commit 的说明 + markdown 表格 + 代码块，不罕见到 50-100KB）。
5. `Markdown.tsx:12` `const tokens = lexMarkdown(source)` **每次 render 都从头 lex 整个 source**，`marked.lexer` 会把整份文本扫描、生成嵌套 token 树，tokens 数组里的每个元素又带 `.tokens` 子数组。
6. `Markdown.tsx:15` `tokens.map(...)` 把整棵 token 树映射为组件树，Ink/Yoga 对每个 `<Box>`/`<Text>` 做 layout。Yoga 内部使用 ArrayMap 迭代子节点——**对应 stack trace 里的 `Builtins_ArrayMap`**。
7. **关键恶化**：假设 100KB 最终文本，按 token delta 粒度 3-5 字符触发一次，约 20000-30000 次 re-render。每次 re-render 都要：
   - lex 平均 50KB（中位数）→ 累计处理 50KB × 25000 ≈ **1.25 GB 字符串**；
   - 产生大量 token 对象 → GC 来不及回收；
   - Ink 重新 diff + layout 整棵树 → 内部 Fiber/Yoga 结构堆积。

### 量化估计

- 假设 LLM 输出 50KB 文本，按 delta=3 字节拆分 → ~16000 次 `appendToken`。
- 每次 appendToken：新 `inFlightText` = 旧长度 N 的拷贝 + delta。总字符串创建量 ∑N = **N²/2 ≈ 1.25 GB**（N=50K）。
- 每次触发 render → `lexer(source)` 又是 O(N) 扫描 + 新数组。整个会话 `lexer` 处理字符 ≈ **600 MB**。
- Ink 的 Static + 动态部分都会参与 reconcile，短时间内无 GC 间隙 → V8 heap 撑满。

### 修法建议

1. **节流 token**：`appendToken` 批量，不要每个 token 都 notify。比如 setTimeout 16ms 合批，或者积累到 N 字符 / 换行时才 flush。
2. **分离流式渲染路径**：`inFlightText` 不走 `<Markdown>`，流式中只用 `<Text>` 纯文本显示，`task:done` 时才一次性用 `Markdown` 渲染到消息列表里。流式阶段 markdown 表格/代码块视觉收益有限。
3. **Markdown memo**：`const tokens = useMemo(() => lexMarkdown(source), [source])`，至少避免同一 source 反复 lex；更好的是按 source 长度阈值 bailout。
4. **appendToken 长度上限**：流式超过某阈值（比如 200KB）强制 flushInFlight 成一条 assistant 消息，然后清空 inFlightText 继续收。

---

## 2. Markdown 组件每次全量 re-lex + 无 memo

### 代码

`src/cli/utils/markdown-lex.ts:3-5`：
```ts
export function lexMarkdown(src: string): TokensList {
  return lexer(src);
}
```

`src/cli/components/Markdown.tsx:11-20`：
```ts
export function Markdown({ source }: MarkdownProps) {
  const tokens = lexMarkdown(source);   // 每次 render 都 lex
  return (
    <Box flexDirection="column">
      {tokens.map((tok, i) => (
        <BlockToken key={i} token={tok} />
      ))}
    </Box>
  );
}
```

`Markdown.tsx:52, 58, 73, 81, 83, 134` 多处 `.map` 递归渲染 inline/list/table token。

### 分析

- `marked.lexer` 不是流式的——每次把整个 source 吃进去，产生完整 AST。
- 没有任何 `useMemo`、没有 `React.memo`，父组件一 re-render，Markdown 整棵重新算。
- 表格（`t.header.map`, `t.rows.map`, 每行再 `row.map`）在 commit 对比输出里很常见，放大渲染节点数。
- Ink 底层 Yoga 对每个 flex 节点都要算 layout，大量节点 × 每次 token → **`Builtins_ArrayMap` 热点**。

### 修法建议

1. `const tokens = useMemo(() => lexMarkdown(source), [source])`。
2. `Markdown` 外层 `React.memo(Markdown, (a, b) => a.source === b.source)`——配合 token 节流后就能显著减少重建。
3. 长文本（>5KB）走"增量 lex"或降级为纯 `<Text>`。

---

## 3. messages 数组 push 走全拷贝

### 代码

`src/cli/state/store.ts:28-31`：
```ts
pushMessage(msg: Message) {
  state = { ...state, messages: [...state.messages, msg] };
  notify();
}
```

### 分析

- 每次 `tool:result` / `token stop` / `task:done` 都 push 一次，7 次 git show → 7 条 tool + 7 条 separator（不一定）+ 1 assistant + 1 user + 1 banner ≥ 17 条。
- 每次 `[...old, new]` 拷贝整个数组（引用拷贝但仍是 O(n) alloc），再配合 React 渲染 `<Static items={messages}>`。
- Ink `<Static>` 虽然只渲染新 item，但它对 items 数组仍会做 key 追踪，数组变化 → 内部 `Set` 更新。**`Builtins_SetConstructor` 命中点之一**。

### 修法建议

- 保留当前 immutability，但减少推送频率（节流 token 能把 token 事件的 notify 频率降下来，messages 不变更就好办）。
- 如果历史超长，考虑窗口化：只保留最近 N 条 + 一个"早期省略"占位，降低 Static 追踪开销。

---

## 4. Debug log：每次 API 调用整组 stringify + 同步写

### 代码

`src/agent.ts:580-589`：
```ts
try {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const logFile = process.env.MA_DEBUG || path.join(os.homedir(), '.my-agent', 'api-debug.log');
  const dbg = requestMessages.map((m: any) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content.slice(0, 200) : m.content,
    tool_calls: m.tool_calls?.length,
    tool_call_id: m.tool_call_id
  }));
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] API REQUEST messages (${requestMessages.length}):\n${JSON.stringify(dbg, null, 2)}\n\n`);
} catch { /* ignore */ }
```

### 分析

- 注释写 "Debug: dump messages before API call"，但 **没有任何开关**——每次 API 调用都执行，包括非 debug 场景。用户场景 7 次 tool 调用意味着 >7 次 API 调用。
- `m.content` 是 string 时 slice 200；但 **当 content 是数组**（多模态：图片、tool_result 的 image_url）时**不切**，整个数组进 stringify。
- 如果 tool_result 返回过 base64 图（兜底路径 `agent.ts:882-887` 会把 `data:image/...` 放进 content 数组），整张 base64 图每次 API 调用都再 stringify + appendFileSync 一次——**文件会线性增长到 GB 级别**，虽然不直接吃 heap，但 stringify 过程中的临时字符串吃 heap。
- `JSON.stringify(dbg, null, 2)` 带缩进，产生更大字符串。

### 修法建议

1. 用 `if (process.env.MA_DEBUG)` 条件包起来，默认关闭。
2. 对数组 content 也截断：`Array.isArray(m.content) ? m.content.map(p => p.type === 'image_url' ? { type: 'image_url', truncated: true } : p) : ...`
3. 改成异步 `fs.promises.appendFile`，避免 stringify 阻塞在主线程 + 占用 heap 的时间过长。

---

## 5. MCP stdout buffer O(n²) slice

### 代码

`src/mcp/client.ts:84-93`：
```ts
private onStdout(chunk: string) {
  this.buffer += chunk;
  let idx: number;
  while ((idx = this.buffer.indexOf('\n')) !== -1) {
    const line = this.buffer.slice(0, idx).trim();
    this.buffer = this.buffer.slice(idx + 1);
    if (!line) continue;
    this.handleLine(line);
  }
}
```

### 分析

- exec__execute_command 的 MCP 响应对 git show 的输出是单条 JSON-RPC 消息（跨多行文本在一个 JSON 里）——通常最终只有 1 个 `\n` 在尾部。
- 但 **exec-mcp server 的 stdout 会把大 JSON 分多个 chunk 推过来**（每 chunk ~64KB）。`this.buffer += chunk` 对 String 是新字符串创建 → **每个 chunk 都产生一份 ≈ 当前 buffer 长度的新 string**。
- 如果 git show --stat 7 条 commit 各自 ~50KB，实际单条响应 JSON 可能 55-60KB（不大）。累积 7 次不会爆，但 `buffer` 拼接产生的临时字符串和 `slice(idx+1)` 产生的尾部字符串，加上 V8 会保留大字符串的 backing store，会放大 GC 压力。
- 真正危险的是响应 **没有换行符**或者有超大 base64 图时——buffer 会一直累积直到 OOM。

### 修法建议

1. 改用 `Buffer` 数组 + join 替代 string concat：
   ```ts
   private bufferChunks: string[] = [];
   private bufferLen = 0;
   private onStdout(chunk: string) {
     this.bufferChunks.push(chunk);
     this.bufferLen += chunk.length;
     const joined = this.bufferChunks.join('');
     // ... split by \n ...
   }
   ```
2. 更好：用 `readline.createInterface({ input: proc.stdout })` 让 Node 处理分行。
3. 单条响应长度上限保护：`if (this.buffer.length > MAX_RESPONSE_SIZE) reject(...)`，防止失控。

---

## 6. Session appendFileSync — 低优先但放大主线程阻塞

### 代码

`src/session/store.ts:72-80`：
```ts
function append(sessionId: string, msg: any): void {
  const line = JSON.stringify(msg) + '\n';
  fs.appendFileSync(jsonlPath(sessionId), line, 'utf-8');
  const meta = readMeta(metaPath(sessionId));
  if (meta) {
    meta.messageCount += 1;
    writeMeta(metaPath(sessionId), meta);
  }
}
```

调用方 `src/agent.ts:420-435`：
```ts
function persistPending(): void {
  ...
  for (let i = persistedCount; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'system') continue;
    try {
      sessionStore.append(sessionId, m);
    } catch { /* ignore persist failures */ }
  }
  persistedCount = messages.length;
}
```

### 分析

- **`JSON.stringify` 整条 message**，tool message 的 content 来自 `compactToolResult`（最大 4000 字符）——单条 ≤ 4KB，不大。
- 但 **`appendFileSync` 是同步 I/O**，每条消息写 2 次文件（jsonl append + meta 覆写）+ 1 次读 meta。17 条消息 = 51 次同步文件操作 + JSON.stringify。主线程被阻塞的时间段内，V8 来不及 GC。
- 这不是内存直接泄漏，但会推高峰值 heap（stringify 过程中的临时字符串没机会回收）。

### 修法建议

1. 改成异步 `fs.promises.appendFile` + 批处理（积累 N 条或 T ms 后一起写）。
2. `meta.messageCount` 不必每次写盘，在 session 结束时统一更新，或者用单独的 `.idx` 文件做 counter。

---

## 7. `tool:result` 对 event.content 做 regex+split — 已排除

### 代码

`src/cli/hooks/useAgent.ts:51-56`：
```ts
case 'tool:result': {
  const preview = event.content
    .replace(/<[^>]*>/g, '')
    .trim()
    .split('\n')[0]
    .slice(0, 50);
  ...
}
```

### 分析

`src/agent.ts:878-880` 在 yield 前已经截断：
```ts
const short =
  toolResult.length > 400 ? toolResult.slice(0, 400) + '...' : toolResult;
yield { type: 'tool:result', ok: !isError, content: short };
```

所以 `event.content` 最大 403 字符。不是问题。

---

## Stack trace 对照

OOM trace 关键帧：

| 帧 | 对应本代码库位置 | 说明 |
|---|---|---|
| `Builtins_SetConstructor` | React/Ink 内部 Fiber reconcile（构造 `new Set` 追踪 children keys），或 Yoga 内部 | 被 #1+#2 的超高 re-render 频率放大 |
| `Builtins_ArrayMap` | `Markdown.tsx:15/52/58/73/81/83/134` 的 `.map`，`ChatHistory.tsx:13` 的 `<Static>`，Yoga 子节点迭代 | #1+#2 每次 token 触发一轮，是主热路径 |
| — | `src/cli/state/store.ts:13` `new Set<Listener>()` | **只执行一次**，不是 OOM 源 |

结论：stack trace 指向 UI 渲染路径，#1 + #2 是核心病灶。

---

## 复盘：52 秒 OOM 数学模型

假设 LLM 最终回复 80KB 文本（7 条 commit 介绍 + markdown），token delta 平均 4 字符：

- `appendToken` 调用次数 ≈ 80000/4 = **20000 次**
- `inFlightText` 累计拷贝字符 ≈ ∑(4·i) = 2·20000² = **800 MB** 字符串创建
- 每次触发 React render + Markdown lex：lex 字符累计 ≈ ∑(4·i) = **800 MB**
- Ink/Yoga 每次 reconcile 若产生 200 个 Fiber/Set 对象，20000 × 200 × ~1KB = **4 GB** Fiber 堆积（V8 young generation 压力）
- 52 秒 GC 没来得及回收旧字符串与 Fiber → heap 打满 → 崩溃

这个量级和 4GB 堆匹配，跟 stack trace 一致。

---

## 推荐修法（按优先级 + ROI）

### P0（立即修，覆盖 90% 症状）

1. **节流 `appendToken`**：`src/cli/state/store.ts:58-60` 改成合批，16ms 或 N 字符触发一次 notify。
2. **memo Markdown**：`src/cli/components/Markdown.tsx:11` 用 `useMemo` 缓存 `tokens`；外层加 `React.memo`。
3. **流式路径用纯 Text**：`src/cli/App.tsx:197-201` 的 `<Markdown source={inFlightText} />` 改成 `<Text>{inFlightText}</Text>`，等 `task:done` 才转 Markdown。

### P1（防御 + 边界）

4. **debug log 加开关**：`src/agent.ts:580-589` 包 `if (process.env.MA_DEBUG)`。
5. **inFlightText 硬上限**：超过 200KB 强制 flush 成消息 + 清空。
6. **MCP stdout 用 readline**：`src/mcp/client.ts:84-93` 改 `readline.createInterface`。

### P2（长期优化）

7. session 持久化改异步批处理。
8. messages 窗口化（>50 条时折叠）。

---

## 最小复现建议

复现命令（让测试验证 fix）：

```bash
cd /Users/zhuqingyu/project/nova-dom
# 清空 MA session
rm -rf ~/.my-agent/sessions
node --max-old-space-size=512 /Users/zhuqingyu/project/my-agent/dist/index.js
# 在交互里输入："介绍每一条 commit 都更新了什么"
```

用 512MB 上限更快触发 OOM，方便 fix 后对比。

---

## 反哺点（给下一个 agent）

- ma CLI OOM 根因：ink 流式 token + Markdown 每 token 全量 re-lex，组合放大到 GB 级。
- stack trace 里 `Builtins_SetConstructor` 看起来像自建代码，但往往指向 React/Ink 内部 Fiber children Set。
- `appendToken` 字符串拼接 + 每 notify 一次 → O(N²) 内存是经典陷阱。

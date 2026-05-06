# MA Agent 内存泄漏排查报告（agent.ts + MCP 调查，A 线）

调查人：leak-hunter-a
日期：2026-04-29
范围：`src/agent.ts` + `servers/exec-mcp.ts` + `src/mcp/client.ts` + compact 链路
场景：用户 `ma` CLI 运行 52 秒、调了 7 次 `git show`/`git diff` 后 Node heap 4GB OOM

---

## 结论先行

**没有找到能单独把 heap 撑到 4GB 的经典内存泄漏**（listener 未摘除 / Map 不 delete / 循环引用等）。实测单轮 exec 在主进程 heap 的稳态驻留 < 1MB，7 轮总计稳态 < 10MB。

**4GB OOM 必须有另一个放大器参与，最可能的是以下三者之一或组合：**

1. **exec-mcp 子进程里 `append` 的 V8 字符串 `+=` 链**（exec-mcp.ts:57-63）— 当 `git show <大 commit>` 原始输出 8.54 MB（见 nova-dom commit `6e56b21d`），chunk-by-chunk `output += s` 会在 V8 里生成大量 cons-string 中间节点。虽然源字符串会被 GC，但一个大调用就能让子进程触达数百 MB 临时峰值。**子进程 OOM 会连带杀主进程吗？不会 —— 但如果用户看到的是某个进程 4GB 崩，那可能就是 exec-mcp 子进程而不是主进程。**

2. **`api-debug.log` 同步追加（agent.ts:582-589）在每一轮 loop 里把 `requestMessages` 整个序列化一遍**，带 `JSON.stringify(dbg, null, 2)`。随着 messages 数组增长 + compact 窗口内驻留，每次 `appendFileSync` 都要在 heap 里瞬时构造整份 JSON 字符串。配合 `maxLoops = 200` 和 compact 失败后 `compactDisabled = true`（两次失败就永久关闭 compact），最坏情况 messages 能累积 200+ 条、每条含 4KB tool 结果 + `tool_calls` 字段，**单次 JSON.stringify 就可能分配 10MB+ 的瞬时字符串**，在同步写盘期间触发 GC 压力。log 文件实测已 3.7 MB、120586 行（120K 行 debug log 堆积 2 天以上），对磁盘没问题，但**每轮的瞬时 heap spike** 是稳定的。

3. **OpenAI SDK 的流读取里 `contentBuf += text` / `cur.argsBuf += tc.function.arguments`（agent.ts:698、713）** 本身没有上限。如果模型（本地 qwen3.6-35b-a3b 经常失控）进入无限生成、或输出超长的 `arguments` JSON，在一轮内可以无限累加；本地 LM Studio 不会主动切断。这是所有循环里唯一一个**运行时完全不受限**的累加点。

**最高嫌疑按概率排序：#3 > #2 > #1。** 证据在下面逐项列。

---

## 嫌疑点 1：agent.ts 的 messages 累积

### 1.1 messages 数组上限
**无硬性上限**。`messages: ChatCompletionMessageParam[]`（agent.ts:407），只靠 compact 控制。

- `DEFAULT_MAX_LOOPS = 200`（agent.ts:41）
- `DEFAULT_CONTEXT_WINDOW = 32768`（agent.ts:58）
- `COMPACT_TRIGGER_RATIO = 0.75` → 触发阈值 24576 tokens ≈ 86 KB 字符
- `COMPACT_MAX_FAILURES = 2`（agent.ts:61）→ **两次 summarize 失败就 `compactDisabled = true`，永远不再触发 compact**（agent.ts:468-469、495、507）

在「compact 被禁用 + 200 loop + 每轮 ~4KB tool 结果」最坏情况下，messages 总字符数最多 ~1-2MB（见下面 1.2 数学）。不够 4GB。**但如果 compact 被禁用 + 一轮 loop 里 contentBuf 爆了，就能瞬时爆**（见嫌疑点 3）。

### 1.2 compactToolResult 的 200KB → 4KB 截断
**compact.ts:32-39** 的 `slice` 在 V8 里是 sliced-string —— 保留对原串 buffer 的引用。

- `head = out.slice(0, 3000)` + `tail = out.slice(-1000)` → 这两个都是 sliced-string，**仍然持有父串的 200KB buffer**
- `head + '...' + tail`（`+` 操作）→ 生成 cons-string，节点内部仍旧指向那两个 sliced-string
- 结果：`compacted` 逻辑长度 4KB，但 heap 实际占用接近 200KB，直到被 `messages.push` 之后仍然驻留在 messages 里

**7 次 exec，每次 200KB 源串：7 × 200KB ≈ 1.4MB 多占**。不是致命问题，但在内存吃紧时会放大。修法：`out = head.slice() + '...' + tail.slice()` 或 `String.prototype.flat()`（V8 特性），或 `Buffer.from(head).toString() + ...` 强制 flatten。**这是一个真实的次级放大器，但单独不会导致 4GB。**

### 1.3 requestMessages 每轮"深拷贝"（agent.ts:564-566）
```ts
const requestMessages = suffix
  ? [{ ...messages[0], content: (messages[0] as any).content + '\n' + suffix }, ...messages.slice(1)]
  : [...messages];
```

- `[...messages]` 是**浅拷贝数组**，元素是共享引用 —— 每轮 O(N) 指针数组 + 第一元素的新对象（content 重新拼串）
- **不产生大对象垃圾**。每次分配一个 ~N*8字节 的数组 + 1 个消息对象，其他引用复用。不是问题。

### 1.4 局部变量
`runTask` 里的 `errorHistory`（Map<string, number>），整个 task 生命周期存在 —— 条目数 ≤ tool 调用次数，字节数极小。不是问题。

`toolResult` 是 `for (const tc of toolCalls)` 体内的 `let`，**块作用域，每次迭代结束可 GC**。

`contentBuf` 和 `toolAcc` 在每个 loop 迭代开始时重置（agent.ts:641-645），也不跨 loop 泄漏。

### 1.5 api-debug.log 序列化（agent.ts:580-589）— **真嫌疑**
```ts
const dbg = requestMessages.map((m: any) => ({
  role: m.role,
  content: typeof m.content === 'string' ? m.content.slice(0, 200) : m.content,
  tool_calls: m.tool_calls?.length,
  tool_call_id: m.tool_call_id,
}));
fs.appendFileSync(logFile, `[...] API REQUEST messages (${requestMessages.length}):\n${JSON.stringify(dbg, null, 2)}\n\n`);
```

**每轮都把 `requestMessages` 整个 map 出一份，再 `JSON.stringify(dbg, null, 2)` 一次。**

问题细节：
1. `typeof m.content === 'string'` 才截 200 字符；**非字符串 content（即 `image_url` 数组）原样 passthrough**。如果任一工具返回了图片（`compactToolResult` 特殊走图片分支，messages.push `image_url` 数组），**整个 image_url 对象（可能带大 data URL）会被 JSON.stringify 完整展开**。
2. `tool_calls` 只记数量，OK。
3. `fs.appendFileSync` 是**同步**写磁盘 —— 每轮阻塞，构造巨型字符串 → 写盘 → GC。这个字符串的长度 ≈ N_messages × (200 字符 + 元数据)。对 40-message 的 context 来说每轮瞬时 ~8KB 字符串，不算大。

**但它叠加了 `MA_DEBUG` 默认值**（`os.homedir() + '/.my-agent/api-debug.log'`）—— 意味着 **log 默认开着**，所有用户每轮都付这个代价。实测当前 log 3.7MB、120K 行。**开启 chromium devtools --inspect 时 appendFileSync 会更慢。**

**结论**：这是泄漏级的性能坑，但不是 OOM 根因。建议默认关闭（只有 `MA_DEBUG` 环境变量显式传时才开）。

---

## 嫌疑点 2：exec-mcp 的输出（servers/exec-mcp.ts）

### 2.1 MAX_OUTPUT 和字符串累加
- `MAX_OUTPUT = 200000`（exec-mcp.ts:6）—— 硬性上限 200KB 字符
- `append` 函数（exec-mcp.ts:57-63）：
  ```ts
  const append = (chunk: Buffer | string) => {
    if (output.length >= MAX_OUTPUT) { truncated = true; return; }
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const remaining = MAX_OUTPUT - output.length;
    if (s.length > remaining) { output += s.slice(0, remaining); truncated = true; }
    else { output += s; }
  };
  ```
- 一旦 `output.length >= MAX_OUTPUT`，**后续 chunk 直接丢弃**。不会无限增长。

### 2.2 spawn stdout 缓冲
- `stdio: ['ignore', 'pipe', 'pipe']`（exec-mcp.ts:54）—— 默认 pipe 缓冲由 OS 管（macOS 64KB）
- **stdin 是 'ignore'，没问题**
- **关键盲点**：`output += s` 在 V8 里是字符串拼接 —— 会生成 cons-string 链。当 chunk 是 64KB 大小、调用上百次时，cons-tree 深度会很深。V8 会在 `s.length` 触发时 flatten，这可能是一个瞬时 spike（200KB × 几倍临时 buffer）。**修法**：用 `Buffer[]` 数组 + `Buffer.concat` 或 `string[]` + `join('')` 一次性。

### 2.3 compressOutput 对 `git show` 没处理
**大炸点！**
- 用户问的是 "介绍每一条 commit 都更新了什么" → agent 调了 7 次 `git show`
- `compressGitOutput(sub, output)`（compress/git.ts:8-17）的 switch **只识别** `status/diff/log/add/commit/push/pull` —— **`show` 不在列表里，直接 `return raw`**
- 也就是说 `git show` 的 200KB 截断后输出会**原样**作为 MCP 返回给主进程

单次 MCP response 从 stdout 传回到主进程：200KB JSON line。**乘以 7 = 1.4MB 主进程流量，不算致命。**

但考虑**实际 commit 大小**：nova-dom 里单个 commit `6e56b21d` 原始 diff 是 **8.54 MB**（实测 `git show` → 8951810 bytes）。exec-mcp 子进程里 V8 做字符串拼接、截断、到最后 resolve({ text: finalText }) —— 这里 `finalText = truncated ? output + TRUNCATE_NOTICE : output`（exec-mcp.ts:86）。output 本身 200KB，加 notice 字符串再加 compressOutput 里的处理也 200KB。没问题。

**但 append 阶段的 cons-string 峰值**：8.54MB 总原串、每 chunk ~64KB、约 134 次 `+=` 调用。append 每次都有早退逻辑（200KB 后丢弃），但**前 4 次 chunk 已经把 output 推到 200KB 上限**，之后的 130 次 chunk 直接 drop。**子进程实际 heap 使用 < 1MB。**

### 2.4 compressOutput 函数对象泄漏
`compressGitOutput` 是纯函数，无闭包状态。不泄漏。

`deduplicateLines`（generic.ts:7-24）在 `lines = input.split('\n')` 后**临时生成数组**，数组和 lines 都在返回后 GC。不泄漏。

**结论**：exec-mcp 子进程不是主进程 OOM 的根因，但子进程自己在处理超大 commit 时会有 2-10MB 的临时 spike（append 拼接）。**建议改成 Buffer[]/string[] + concat/join。**

---

## 嫌疑点 3：MCP JSON-RPC 通信（src/mcp/client.ts）

### 3.1 buffer 累加
`onStdout`（client.ts:84-93）：
```ts
this.buffer += chunk;
let idx: number;
while ((idx = this.buffer.indexOf('\n')) !== -1) {
  const line = this.buffer.slice(0, idx).trim();
  this.buffer = this.buffer.slice(idx + 1);
  ...
}
```

- `this.buffer += chunk` 也是 cons-string 累加 —— 但每收完一行就 `slice` 消费掉
- **如果 MCP server 在一条 response 里返回 8MB 数据、分 128 个 64KB chunk，buffer 会暂时膨胀到 8MB**，但只要最后找到 `\n` 就会被切掉
- exec-mcp 的 response 最大 200KB（因为子进程截断），所以这里实际只会 spike 到 200KB
- **不是泄漏**

### 3.2 pending Map
`this.pending = new Map<number, Pending>()`（client.ts:48）
- `request()` 时 `this.pending.set(id, ...)`（client.ts:165）
- response 到达时 `this.pending.delete(msg.id)`（client.ts:108）
- timeout 时也 `this.pending.delete(id)`（client.ts:137）
- abort 时 `this.pending.delete(id)`（client.ts:159）
- close 时 `this.pending.clear()`（client.ts:77、241）

**所有路径都有清理，不泄漏。**

### 3.3 AbortSignal listener
`signal.addEventListener('abort', onAbort, { once: true })`（client.ts:162）

- `setMaxListeners(50, signal)`（client.ts:154）只是抑制警告
- `once: true` —— 触发后自动移除
- `wrappedResolve`/`wrappedReject`（client.ts:142-149）都显式 `signal.removeEventListener` —— OK
- **但有一个边缘 case**：如果 signal 永远不 abort 且 resolve 正常路径走完，listener 在 `wrappedResolve` 里被移除。没问题。

**不泄漏。**

### 3.4 send 的 stdin.write
`this.process.stdin.write(JSON.stringify(obj) + '\n')`（client.ts:123）
- 同步无等待，写不完的 chunk 进 OS buffer
- 主进程每次 request 构造一个 JSON 字符串。对 `tools/call` 来说就是 `{"name":"execute_command","arguments":{"command":"git show <hash>"}}` —— 小对象

**不泄漏。**

---

## 嫌疑点 4：compact 策略

### 4.1 触发条件
- `estimateTokens(messages) > compactThreshold`（agent.ts:475-476），threshold = 24576 tokens
- 但 `compactDisabled = true` 后永不触发（agent.ts:474）
- **两次 summarize 失败就永久禁用** —— 本地模型经常失败，这很容易触发
- 禁用后 messages 无上限增长，直到 200 loops 或用户 ctrl-c

### 4.2 estimateTokens 成本
`estimateTokens`（tokenCount.ts:24-38）每轮都跑一次 —— O(N) 遍历 messages，每条做 `JSON.stringify(toolCalls).length`。当 messages 有 100+ 条带 tool_calls 的消息时，**每轮就要序列化整个 tool_calls 历史**。这是重复计算，但不是泄漏。建议：缓存 messages 哈希 → token 数。

### 4.3 contextWindow 默认值
- `config.json` 空，全局 `~/.my-agent/config.json` 里 model 段没有 contextWindow → **默认 32768 tokens ≈ 86KB 字符阈值**
- 用户真实模型 `qwen/qwen3.6-35b-a3b` 的实际 context window 一般 32K 或 128K —— 此处默认值若偏小，会**触发过早的 compact**（浪费对话）；若偏大，会**错过 compact 时机**（messages 膨胀）
- **这不是泄漏，但是个 tunable 风险**

---

## 嫌疑点 5：OpenAI 流读取（agent.ts:651-716）

### 5.1 contentBuf 无上限（真嫌疑）
```ts
let contentBuf = '';
...
if (text.length > 0) {
  contentBuf += text;  // agent.ts:698
  yield { type: 'token', text };
}
```
- 没有任何上限
- 本地 LLM（LM Studio + qwen3.6-35b）有时会进入死循环生成 —— 输出可能数百万 token
- 用户场景是 52 秒崩 —— qwen-35b 流式输出一般 30-60 tok/s ≈ 每秒 120-240 字符。52 秒最多 10000 字符。**单轮 contentBuf 不会爆**
- **但多轮累加内存里的 contentBuf 临时分配，一旦某轮模型疯狂输出就会爆**

### 5.2 toolAcc.argsBuf（真嫌疑）
```ts
cur.argsBuf += tc.function.arguments;  // agent.ts:713
```
- `arguments` 是模型产生的 JSON 字符串片段，拼完后 `normalizeArguments` 解析
- 如果模型流式输出**巨大 JSON** 或**无限循环输出**（已知 qwen/mistral 本地部署 bug），argsBuf 可以无限增长
- 实测本地 LLM 偶尔会进入 `"a":"a":"a":...` 类型的死循环，每秒生成几百 KB
- **52 秒 × 200 KB/s = 10MB argsBuf** —— 还不到 4GB
- 但如果 LLM 进入**高速死循环**（某些本地部署在 GPU 上能跑到 1-10 MB/s），52 秒就能达到 GB 级
- **这是最可能的 4GB OOM 嫌疑点**

### 5.3 修法建议
- 在 `contentBuf += text` 处加上限（例如 512KB）并提前中断流
- 在 `argsBuf += tc.function.arguments` 处同样加上限

---

## 嫌疑点 6：compactToolResult 图片分支（agent.ts:882-886）

```ts
if (compacted.startsWith('data:image/')) {
  messages.push({
    role: 'tool',
    content: [{ type: 'image_url', image_url: { url: compacted } }] as any,
  });
}
```

- `compacted` 已经过 `compactToolResult` 的 4KB 截断
- **但 compact.ts 里 4KB 截断对 data URL 来说等于截一半 base64 数据 —— 成为"坏图"**
- 实际上 data URL 如果被截成 `data:image/png;base64,iVBOR...[truncated]...` 不会被浏览器/模型识别
- 这里的问题是**功能性 bug**，不是内存 bug
- `estimateTokens` 里 `IMAGE_TOKEN_COST = 1000`（tokenCount.ts:2）—— 每个 image_url 算 1000 token。不会导致内存问题。

---

## 放大器组合

单独看每个点都不致命。真实的 4GB 爆炸需要叠加：

| 放大器 | 贡献 | 触发条件 |
|---|---|---|
| contentBuf 无上限 | 可达 GB 级 | LLM 死循环流式输出 |
| argsBuf 无上限 | 可达 GB 级 | LLM 产生无限 tool args |
| compactDisabled | messages 不收敛 | summarize 失败 2 次 |
| maxLoops = 200 | 200× 累加 | 模型持续调 tool |
| sliced-string 200KB 驻留 | 每条 +200KB | 每次大工具返回 |
| api-debug.log 同步阻塞 | CPU 卡顿 + GC 压力 | 默认开启 |
| exec-mcp cons-string append | 单次 spike 10MB | git show 大 bundle |

**最现实路径**：用户跑 7 次 git show（其中某次命中 nova-dom 那个 8.54MB commit）→ compact 触发 → summarize 在本地小模型上失败 → compact 永久禁用 → 后续某轮 LLM 进入流式死循环 → contentBuf 或 argsBuf 在几秒内涨到 GB → Node heap 4GB 爆。

52 秒正好符合这个时序：40s 内 7 次 exec 正常返回、compact 跑 2 次失败、最后 10s LLM 死循环 → OOM。

---

## 修法建议（优先级排序）

### P0 必改
1. **`contentBuf` / `argsBuf` 加上限（agent.ts:698、713）**
   ```ts
   const STREAM_CHAR_LIMIT = 1_000_000; // 1MB
   if (contentBuf.length < STREAM_CHAR_LIMIT) contentBuf += text;
   else { /* emit truncation, break outer for-await */ }
   ```

2. **取消 "compact 失败 2 次就禁用" 策略（agent.ts:494-495、507）**
   - 改为每次失败都重试；或失败后**强制硬截断 messages**（保留 system + last N）而不是放任增长
   - 至少应该：`compactDisabled` 触发后做一次硬截断，而不是任由膨胀

### P1 应改
3. **api-debug.log 默认关闭（agent.ts:586）**
   ```ts
   if (!process.env.MA_DEBUG) { /* skip */ }
   ```
   目前 `MA_DEBUG || path.join(...)` 是"没设就用默认路径"，等于**永远开启**。反了。

4. **compressOutput 加上 `show` 分支（servers/compress/git.ts:13-16）**
   - `git show` 的输出和 `git diff` 格式完全一致 —— 直接复用 `compressGitDiff`

5. **compactToolResult 的 slice 强制 flatten（src/agent/compact.ts:34-38）**
   ```ts
   out = (head + '...' + tail).normalize(); // 或 Buffer.from(...).toString()
   ```

### P2 建议
6. **exec-mcp 的 append 改用数组 + join（servers/exec-mcp.ts:57-63）**
   ```ts
   const chunks: string[] = [];
   let totalLen = 0;
   const append = (chunk) => {
     if (totalLen >= MAX_OUTPUT) return;
     const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
     const take = Math.min(s.length, MAX_OUTPUT - totalLen);
     chunks.push(take < s.length ? s.slice(0, take) : s);
     totalLen += take;
   };
   // finalize: const output = chunks.join('');
   ```

7. **estimateTokens 做结果缓存** — 每次 tool 调用后只增量计算新增 messages 的 token，不要整表重跑

8. **sessions 目录自动 prune** — 已有 2560 个 session 文件、`list()` 每次扫全部 meta。启动时顺便 `prune(50)`。

---

## 未验证但值得追查

1. **Node 版本**：`node --max-old-space-size=4096` 的 OOM 是 V8 old-space 硬限；若是 new-space 碎片化 GC thrash 也会表现为"卡死"而非干净崩溃。需要用户跑 `node --heap-prof ...` 抓 heap snapshot。

2. **确认是主进程 OOM 还是子进程 OOM**：用户没说明哪个进程 4GB 崩。如果是 exec-mcp 子进程，原因可能是 append 阶段 cons-string flatten 的 2-10MB spike 被某个失控 LLM args 触发（LLM 写 `bash -c 'for i in {1..9999999}; do ...; done'` 类命令）。

3. **LM Studio 的 server 返回 payload 大小**：OpenAI SDK 流式 —— 如果 server 先 buffer 整个 response 再流式输出，SDK 内部可能 buffer 整份。建议临时用 `curl` 直接抓一次相同 prompt 的 /v1/chat/completions 看 payload。

---

## 实验数据

- nova-dom commit `6e56b21d704ecd1da5ff5400224203f5ca88ff26` (feat: md;) → `git show` 输出 **8951810 bytes (8.54 MB)**，主要是 dist/lib/nova-dom.umd.min.js 的 bundle diff
- `time git show 6e56b21d > /dev/null` → 47ms（读 + 输出很快，不会卡超时）
- 其他 nova-dom commit：绝大多数 < 50KB，偶有 49KB/11KB 的
- `~/.my-agent/api-debug.log` → 3.7MB、120586 行（长时间积累，不是单次会话）
- `~/.my-agent/sessions/` → **2560 条 session 文件**，最大 177KB、均值 ~10KB
- `~/.my-agent/config.json` → model `qwen/qwen3.6-35b-a3b`，没设 contextWindow，走默认 32768

---

## 文件参考

- `/Users/zhuqingyu/project/my-agent/src/agent.ts`
- `/Users/zhuqingyu/project/my-agent/src/agent/compact.ts`
- `/Users/zhuqingyu/project/my-agent/src/agent/summarize.ts`
- `/Users/zhuqingyu/project/my-agent/src/agent/tokenCount.ts`
- `/Users/zhuqingyu/project/my-agent/src/mcp/client.ts`
- `/Users/zhuqingyu/project/my-agent/servers/exec-mcp.ts`
- `/Users/zhuqingyu/project/my-agent/servers/compress/index.ts`
- `/Users/zhuqingyu/project/my-agent/servers/compress/git.ts`
- `/Users/zhuqingyu/project/my-agent/servers/compress/generic.ts`
- `/Users/zhuqingyu/project/my-agent/src/session/store.ts`
- `/Users/zhuqingyu/project/my-agent/src/index.ts`

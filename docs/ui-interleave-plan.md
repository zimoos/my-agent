# UI Tool/Text Interleave Plan

## 1. Current Rendering Pipeline

```
Agent (async iterator)
  |
  v
useAgent.ts :: applyEvent()
  |
  |-- token/text --> store.appendToken() --> tokenBuffer --> [16ms flush] --> state.inFlightText (string)
  |-- tool:call  --> store.updateThinking() --> state.thinking (只更新状态栏)
  |-- tool:result --> store.pushMessage({kind:'tool'}) --> state.messages[] (立即入列)
  |-- task:done  --> store.flushInFlight() --> 把 inFlightText 变成 {kind:'assistant'} 入 messages[]
  |
  v
App.tsx render:
  1) <ChatHistory messages={messages} />   ← ink <Static>, 渲染所有已入列的 message（含 tool）
  2) {inFlightText && <Text>...</Text>}    ← 流式文本，在 ChatHistory 下方单独渲染
  3) <ThinkingBar />                        ← 状态栏
```

**关键：`<Static>` 是 Ink 的特殊组件 — 已渲染的 item 不会移动/重排，新 item 只能追加在末尾。**

## 2. Problem Root Cause

**精确定位：**

| 位置 | 行号 | 问题 |
|------|------|------|
| `store.ts` | L14, L30 | `inFlightText` 是单个 string，所有 token 无条件追加。无法表达"这段文字在哪个 tool 之前/之后" |
| `useAgent.ts` | L57-65 | `tool:result` 事件直接 `pushMessage` 进 messages[]，而当时已积累的 token 仍留在 inFlightText 里，没被 flush 成独立消息 |
| `App.tsx` | L194-200 | ChatHistory（含 tool messages）和 inFlightText 是两个独立渲染区域，物理上分隔 |

**因果链：**

1. 模型输出 "我来查看项目结构" → token 事件 → 追加到 inFlightText
2. 模型发起 tool_call → tool:call 事件 → 只更新 thinking 状态
3. Tool 返回 → tool:result 事件 → pushMessage({kind:'tool'}) 入 messages[]
4. 模型输出 "找到了" → token 事件 → 继续追加到 inFlightText
5. 重复 2-4 多次...
6. task:done → flushInFlight → 所有文本变成一条 assistant 消息入 messages[]

**渲染结果：**
- messages[] 里先有一堆 tool 消息（步骤 3 反复入列）
- 流式阶段：ChatHistory 渲染所有 tool 消息在上面，inFlightText 渲染所有文本在下面
- 最终态：assistant 消息在 tool 消息之后（因为 task:done 才入列），顺序也是错的

## 3. Modification Plan

### Core Idea

在 `tool:result` 到来时，把当前积累的 inFlightText 先 flush 成一条 assistant 文本消息，然后再 push tool 消息。这样 messages[] 里天然按时间顺序交错。

### 3.1 Changes to `useAgent.ts` (minimal, ~5 lines)

**Before (L51-65):**
```ts
case 'tool:result': {
  const preview = ...;
  store.pushMessage({ kind: 'tool', ... });
  store.updateThinking({ event: ... });
  break;
}
```

**After:**
```ts
case 'tool:result': {
  // Flush accumulated text BEFORE the tool message to preserve chronological order
  const pendingText = store.flushInFlight();
  if (pendingText.trim()) {
    store.pushMessage({
      kind: 'assistant',
      id: nextId(),
      markdown: pendingText,
      elapsedMs: 0,
    });
  }
  const preview = event.content
    .replace(/<[^>]*>/g, '')
    .trim()
    .split('\n')[0]
    .slice(0, 50);
  store.pushMessage({
    kind: 'tool',
    id: nextId(),
    name: store.getState().thinking?.toolName || '',
    ok: event.ok,
    preview: preview || (event.ok ? '完成' : '失败'),
  });
  store.updateThinking({ event: event.ok ? '分析结果中' : '处理错误中' });
  break;
}
```

### 3.2 Changes to `useAgent.ts` task:done handler

**Before (L73-91):**
```ts
case 'task:done': {
  const md = store.flushInFlight();
  ...
  if (md.trim()) {
    store.pushMessage({ kind: 'assistant', ... });
  }
  store.pushMessage({ kind: 'separator', ... });
  break;
}
```

**After:** No change needed. flushInFlight() at task:done will catch any trailing text after the last tool call. If text was already flushed by tool:result, flushInFlight returns '' and the `if (md.trim())` guard skips it. Existing logic is correct.

### 3.3 Changes to `store.ts` — None

`flushInFlight()` already does `flushTokenBuffer()` first (L88), returns the accumulated text, and resets. No modification needed.

### 3.4 Changes to `App.tsx` — None

The `inFlightText` rendering block (L196-200) still handles the "currently streaming" text. Between tool calls it will grow and display; on each tool:result it gets flushed into messages[]. The UX is:
- Text streams visually in the inFlightText area
- When a tool completes, that text block jumps into Static (ChatHistory) and the tool result appears after it
- Then new text starts streaming fresh

### 3.5 What NOT to Change

| Component | Reason |
|-----------|--------|
| `ChatHistory.tsx` | Already renders messages in order via Static |
| `MessageView.tsx` | Already handles both `assistant` and `tool` kinds correctly |
| `store.ts` | flushInFlight already works correctly for this use case |
| `App.tsx` | Layout is correct, no structural change needed |
| `types.ts` | No new message kinds needed |

### 3.6 Resulting Render Order

```
messages[]:
  {kind:'assistant', markdown:"我来查看项目结构。"}     ← flushed at tool:result
  {kind:'tool', name:"fs → list_directory", ok:true}    ← pushed at tool:result
  {kind:'assistant', markdown:"找到了目录，看看里面..."}  ← flushed at next tool:result
  {kind:'tool', name:"fs → read_file", ok:true}         ← pushed at next tool:result
  {kind:'assistant', markdown:"代码结构如下..."}         ← flushed at task:done
  {kind:'separator'}                                     ← pushed at task:done
```

Visual output:
```
我来查看项目结构。
  ✓ fs → list_directory
找到了目录，看看里面有什么。
  ✓ fs → read_file
代码结构如下...
───────── 12s ─────────
```

## 4. Risk Analysis

### OOM Risk: NONE

- No new buffers introduced. We're calling the existing `flushInFlight()` more often (at each tool:result), which **reduces** memory pressure — inFlightText gets shorter bursts instead of one giant string.
- The 16ms tokenBuffer throttle is untouched.
- `flushTokenBuffer()` is called inside `flushInFlight()` and inside `pushMessage()`, so ordering is safe.

### Render Performance: LOW RISK

- More messages in the `<Static>` list (each text chunk becomes a separate assistant message instead of one big one at the end).
- Static items render once and never re-render. More items = slightly more DOM nodes, but each is smaller. Net effect negligible.
- assistant messages in ChatHistory use `<Markdown>` component, but each fragment is short. The expensive case (giant Markdown) is actually improved because text is split into smaller chunks.

### Edge Cases

| Case | Handling |
|------|----------|
| No text before first tool call | `pendingText.trim()` is empty → skipped, tool message appears directly |
| Multiple tool calls with no text between them | Same — empty text skipped, consecutive tool messages render correctly |
| tool:call without subsequent tool:result | No flush happens (flush only on tool:result). Text continues accumulating. |
| Very fast tool calls (< 16ms apart) | flushTokenBuffer() is called synchronously inside flushInFlight(), so even un-flushed buffer contents are captured |
| task:done with no trailing text | Existing guard `if (md.trim())` handles this |
| Concurrent/nested tool calls | Current architecture processes events serially (single for-await loop), so ordering is deterministic |

### Breaking Change Risk: NONE

- The final assembled message sequence is identical in content, just split into more granular pieces.
- No API changes. No new types. No new state fields.
- ChatHistory/MessageView already handle multiple consecutive assistant messages — no visual artifact.

## 5. Implementation Effort

**1 file changed, ~8 lines added.** The fix is entirely within `useAgent.ts` at the `tool:result` case handler.

Total estimated time: 5 minutes of coding + validation.

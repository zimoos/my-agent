import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type { ChatContent } from '../mcp/types.js';

/**
 * Centralized, encapsulated store for the agent's conversation messages.
 *
 * ALL mutations to the message history must go through this class.
 * This prevents the "18 scattered mutation sites" problem where any
 * code path could accidentally break tool_call/tool_result pairing
 * or corrupt the context window.
 */
export class MessageStore {
  private messages: ChatCompletionMessageParam[] = [];
  private persistedCount = 0;

  init(
    systemPrompt: string,
    resumeMessages?: ChatCompletionMessageParam[]
  ): void {
    this.messages = [{ role: 'system', content: systemPrompt }];
    this.persistedCount = 1;
    if (resumeMessages) {
      for (const m of resumeMessages) {
        if (m.role === 'system') continue;
        this.messages.push(m);
      }
    }
  }

  reset(systemPrompt: string): void {
    this.messages = [{ role: 'system', content: systemPrompt }];
    this.persistedCount = 1;
  }

  get length(): number {
    return this.messages.length;
  }

  /** Return a shallow copy of the internal array for read-only inspection. */
  snapshot(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  at(index: number): ChatCompletionMessageParam | undefined {
    return this.messages[index];
  }

  findIndex(
    predicate: (m: ChatCompletionMessageParam, index: number) => boolean
  ): number {
    return this.messages.findIndex(predicate);
  }

  /** Append a user message. */
  appendUser(content: ChatContent): void {
    this.messages.push({ role: 'user', content: content as any });
  }

  /** Append an assistant message, optionally with tool_calls. */
  appendAssistant(
    content: string,
    toolCalls?: ChatCompletionMessageToolCall[]
  ): void {
    const msg: ChatCompletionMessageParam = {
      role: 'assistant',
      content: content.trim() || '',
    };
    if (toolCalls && toolCalls.length > 0) {
      (msg as any).tool_calls = toolCalls;
    }
    this.messages.push(msg);
  }

  /** Append a tool result message (handles both text and inline images). */
  appendToolResult(toolCallId: string, content: string): void {
    if (content.startsWith('data:image/')) {
      this.messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: [{ type: 'image_url', image_url: { url: content } }] as any,
      });
    } else {
      this.messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content,
      });
    }
  }

  /** Append a plain system message. */
  appendSystem(content: string): void {
    this.messages.push({ role: 'system', content });
  }

  /** Nudge the model after empty content following tool use. */
  appendNudge(): void {
    this.messages.push({ role: 'assistant', content: '' });
    this.messages.push({
      role: 'user',
      content: 'Please provide your answer based on the tool results above.',
    });
  }

  /** Remove the last assistant message (used for empty-args retry). */
  popAssistant(): void {
    this.messages.pop();
  }

  /** Find a safe cut index that does not land inside a tool-result block. */
  findSafeCutIndex(desiredCut: number): number {
    let cut = Math.max(1, Math.min(desiredCut, this.messages.length));
    while (cut < this.messages.length && this.messages[cut].role === 'tool') {
      cut += 1;
    }
    return cut;
  }

  /** Replace middle messages with a compact summary. */
  compact(cutIndex: number, summary: string, fallbackUserContent?: string): void {
    if (cutIndex <= 1 || cutIndex >= this.messages.length) return;
    this.messages.splice(1, cutIndex - 1, {
      role: 'system',
      content: `[compact summary]\n${summary}`,
    });

    // Safety: ensure at least one user message remains after compact.
    // Without this, Qwen3 jinja templates throw "No user query found in messages".
    const hasUser = this.messages.some((m) => m.role === 'user');
    if (!hasUser && fallbackUserContent) {
      const userContent = fallbackUserContent.slice(0, 200);
      // Insert right after the summary (index 2) to maintain message order
      this.messages.splice(2, 0, { role: 'user', content: userContent });
    }
  }

  /**
   * Fold messages from anchor onward into a single summary message.
   * Returns the folded slice so the caller can archive it.
   */
  fold(
    anchor: number,
    summary: string
  ): ChatCompletionMessageParam[] | null {
    if (anchor < 0 || anchor > this.messages.length) return null;
    const folded = this.messages.splice(anchor);
    const userMsg = folded.find((m) => m.role === 'user');
    const userQ =
      userMsg && typeof userMsg.content === 'string'
        ? userMsg.content
        : '';
    const foldSummary = userQ
      ? `[conversation] User asked: "${userQ.slice(0, 100)}" → ${summary || '(no answer)'}`
      : `[stack:completed] Summary: ${summary}`;
    this.messages.push({ role: 'system', content: foldSummary });
    return folded;
  }

  /** Truncate messages for 500-error recovery. */
  truncateForRecovery(firstUserIdx: number, tailStart: number): void {
    const newMessages: ChatCompletionMessageParam[] = [this.messages[0]];
    if (firstUserIdx > 1) {
      newMessages.push({
        role: 'system',
        content: '[context truncated due to server error]',
      });
    }
    if (firstUserIdx > 0) {
      newMessages.push(this.messages[firstUserIdx]);
    }
    for (let i = tailStart; i < this.messages.length; i++) {
      newMessages.push(this.messages[i]);
    }
    this.messages = newMessages;
  }

  /**
   * Build the messages array to send to the LLM.
   * The suffix (stack-state + loop-warning) is appended to the system
   * prompt WITHOUT mutating the internal store.
   */
  buildRequestMessages(suffix: string): ChatCompletionMessageParam[] {
    if (!suffix) return [...this.messages];
    const system = this.messages[0];
    const patchedSystem: ChatCompletionMessageParam = {
      role: 'system',
      content: (system.content as string) + '\n' + suffix,
    } as any;
    return [patchedSystem, ...this.messages.slice(1)];
  }

  /** Get messages that have not yet been persisted (system excluded). */
  getPendingForPersist(): ChatCompletionMessageParam[] {
    return this.messages
      .slice(this.persistedCount)
      .filter((m) => m.role !== 'system');
  }

  /** Mark everything currently in the store as persisted. */
  markPersisted(): void {
    this.persistedCount = this.messages.length;
  }
}

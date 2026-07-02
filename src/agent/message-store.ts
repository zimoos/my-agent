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
  private rootTurnAnchors: number[] = [];

  init(
    systemPrompt: string,
    resumeMessages?: ChatCompletionMessageParam[]
  ): void {
    this.messages = [{ role: 'system', content: systemPrompt }];
    this.persistedCount = 1;
    this.rootTurnAnchors = [];
    if (resumeMessages) {
      for (const m of resumeMessages) {
        if (m.role === 'system') continue;
        this.messages.push(m);
      }
    }
    this.persistedCount = this.messages.length;
  }

  reset(systemPrompt: string): void {
    this.messages = [{ role: 'system', content: systemPrompt }];
    this.persistedCount = 1;
    this.rootTurnAnchors = [];
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
  appendUser(content: ChatContent, opts: { rootTurn?: boolean } = {}): void {
    if (opts.rootTurn) {
      this.rootTurnAnchors.push(this.messages.length);
    }
    this.messages.push({ role: 'user', content: content as any });
  }

  /** Append an assistant message, optionally with tool_calls. */
  appendAssistant(
    content: string,
    toolCalls?: ChatCompletionMessageToolCall[],
    opts: { reasoningContent?: string } = {}
  ): void {
    const msg: ChatCompletionMessageParam = {
      role: 'assistant',
      content: content.trim() || '',
    };
    if (opts.reasoningContent) {
      (msg as any).reasoning_content = opts.reasoningContent;
    }
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

  /** Drop the latest user turn and everything after it from in-memory context. */
  revertLastTurn(): number {
    for (let i = this.messages.length - 1; i >= 1; i--) {
      if (this.messages[i].role === 'user') {
        return this.truncateFrom(i);
      }
    }
    return 0;
  }

  /** Drop the latest root user turn and everything after it. */
  revertLastRootTurn(): number {
    const anchor = this.rootTurnAnchors.pop();
    return anchor === undefined ? 0 : this.truncateFrom(anchor);
  }

  /** Truncate context from a known message anchor. */
  truncateFrom(anchor: number): number {
    if (anchor < 1 || anchor >= this.messages.length) return 0;
    const removed = this.messages.length - anchor;
    this.messages.splice(anchor);
    if (this.persistedCount > this.messages.length) {
      this.persistedCount = this.messages.length;
    }
    this.rootTurnAnchors = this.rootTurnAnchors.filter((idx) => idx < anchor);
    return removed;
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
    this.rootTurnAnchors = this.rootTurnAnchors.filter((idx) => idx < anchor);
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

  /**
   * Build the messages array to send to the LLM.
   *
   * The system prompt at position [0] is kept immutable so that the
   * prefix stays cache-stable across turns. Dynamic content (stack state,
   * loop warnings) is appended as a separate system message at the tail.
   */
  buildRequestMessages(suffix: string): ChatCompletionMessageParam[] {
    if (!suffix) return [...this.messages];
    return [
      ...this.messages,
      { role: 'system', content: suffix },
    ];
  }

  buildContextRequestMessages(
    suffix: string,
    body: ChatCompletionMessageParam[]
  ): ChatCompletionMessageParam[] {
    const system = this.messages[0];
    const patchedSystem: ChatCompletionMessageParam = {
      role: 'system',
      content: (system.content as string) + (suffix ? '\n' + suffix : ''),
    } as any;
    return [patchedSystem, ...body];
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

import type {
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type { AgentEvent } from './events.js';
import { normalizeToolCalls } from './normalize.js';
import type { ParsedAssistantTurn } from '../provider/types.js';

export interface StreamParserOptions {
  maxContentChars?: number;
  repeatWindowChars?: number;
  repeatWindowRepeats?: number;
}

function hasRepeatedSuffix(
  text: string,
  windowChars: number,
  repeats: number
): boolean {
  if (windowChars <= 0 || repeats <= 1) return false;
  const needed = windowChars * repeats;
  if (text.length < needed) return false;

  const end = text.length;
  const last = text.slice(end - windowChars, end);
  if (last.trim().length < Math.floor(windowChars * 0.6)) return false;

  for (let i = 2; i <= repeats; i++) {
    const start = end - windowChars * i;
    const prev = text.slice(start, start + windowChars);
    if (prev !== last) return false;
  }
  return true;
}

/**
 * Parses an OpenAI-compatible streaming response.
 *
 * Yields token / thinking events as they arrive, and returns the final
 * aggregated content + reasoning content + tool calls when the stream ends.
 */
export class StreamParser {
  constructor(private readonly options: StreamParserOptions = {}) {}

  async *parse(
    stream: AsyncIterable<any>
  ): AsyncGenerator<
    AgentEvent,
    ParsedAssistantTurn,
    unknown
  > {
    let contentBuf = '';
    let reasoningBuf = '';
    const toolAcc = new Map<
      number,
      { id: string; name: string; argsBuf: string }
    >();
    let isThinking = false;
    let thinkingViaReasoning = false;
    let thinkingStartTime = 0;
    let finishReason: string | undefined;

    for await (const chunk of stream) {
      const choice = chunk?.choices?.[0];
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
      const delta = choice?.delta;
      if (!delta) continue;

      // Handle reasoning_content field (Qwen/Gemma thinking mode)
      if (
        typeof (delta as any).reasoning_content === 'string' &&
        (delta as any).reasoning_content.length > 0
      ) {
        reasoningBuf += (delta as any).reasoning_content;
        if (!isThinking) {
          isThinking = true;
          thinkingViaReasoning = true;
          thinkingStartTime = Date.now();
          yield { type: 'thinking:start' };
        }
        continue;
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        // If thinking was started via reasoning_content, content appearing means thinking ended
        if (isThinking && thinkingViaReasoning) {
          isThinking = false;
          thinkingViaReasoning = false;
          yield {
            type: 'thinking:end',
            durationMs: Date.now() - thinkingStartTime,
          };
        }

        let text = delta.content;

        // Simple thinking token filter (strip inline markers for Gemma)
        if (text.includes('<|channel>thought') || text.includes('<think>')) {
          if (!isThinking) {
            isThinking = true;
            thinkingStartTime = Date.now();
            yield { type: 'thinking:start' };
          }
          text = text
            .replace(/<\|channel>thought/g, '')
            .replace(/<think>/g, '');
        }
        if (text.includes('<channel|>') || text.includes('</think>')) {
          text = text.replace(/<channel\|>/g, '').replace(/<\/think>/g, '');
          if (isThinking) {
            isThinking = false;
            yield {
              type: 'thinking:end',
              durationMs: Date.now() - thinkingStartTime,
            };
          }
        }

        // If currently thinking, skip content
        if (isThinking) continue;

        if (text.length > 0) {
          contentBuf += text;
          const maxContentChars = this.options.maxContentChars;
          if (
            typeof maxContentChars === 'number' &&
            maxContentChars > 0 &&
            contentBuf.length > maxContentChars
          ) {
            throw new Error(
              `model output exceeded maxOutputChars (${maxContentChars}); aborted likely runaway generation`
            );
          }
          const repeatWindowChars = this.options.repeatWindowChars ?? 0;
          const repeatWindowRepeats = this.options.repeatWindowRepeats ?? 0;
          if (
            hasRepeatedSuffix(
              contentBuf,
              repeatWindowChars,
              repeatWindowRepeats
            )
          ) {
            throw new Error(
              `model output repeated the last ${repeatWindowChars} characters ${repeatWindowRepeats} times; aborted likely runaway generation`
            );
          }
          yield { type: 'token', text };
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          let cur = toolAcc.get(idx);
          if (!cur) {
            cur = { id: '', name: '', argsBuf: '' };
            toolAcc.set(idx, cur);
          }
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.argsBuf += tc.function.arguments;
        }
      }
    }

    // Close unclosed thinking state
    if (isThinking) {
      isThinking = false;
      yield {
        type: 'thinking:end',
        durationMs: Date.now() - thinkingStartTime,
      };
    }
    const assembled = [...toolAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => ({
        id: v.id,
        type: 'function' as const,
        function: { name: v.name, arguments: v.argsBuf },
      }));
    const toolCalls = normalizeToolCalls(assembled);
    return {
      content: contentBuf,
      toolCalls,
      reasoningContent: reasoningBuf || undefined,
      finishReason,
    };
  }
}

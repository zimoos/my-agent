import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export const CHARS_PER_TOKEN = 3.5;
export const IMAGE_TOKEN_COST = 1000;

export function estimateSerializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function partLength(part: unknown): number {
  if (!part || typeof part !== 'object') return 0;
  const p = part as any;
  if (p.type === 'text' && typeof p.text === 'string') return p.text.length;
  if (p.type === 'image_url') return IMAGE_TOKEN_COST * CHARS_PER_TOKEN;
  return 0;
}

function contentLength(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let sum = 0;
    for (const part of content) sum += partLength(part);
    return sum;
  }
  return 0;
}

export function estimateTokens(messages: ChatCompletionMessageParam[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += contentLength((msg as any).content);
    const toolCalls = (msg as any).tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      try {
        chars += JSON.stringify(toolCalls).length;
      } catch {
        // ignore serialization failure
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

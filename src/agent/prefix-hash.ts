import { createHash } from 'node:crypto';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * Compute a diagnostic hash of the stable prefix — system prompt at [0] +
 * all messages through the last immutable one (before dynamic suffix).
 *
 * Used to detect unexpected prefix changes that would invalidate cache.
 */
export function prefixHash(messages: ChatCompletionMessageParam[]): string {
  const h = createHash('sha256');
  for (const m of messages) {
    // Only hash role + content shape; skip tool_call_id, image data etc.
    h.update(m.role);
    if (typeof m.content === 'string') {
      h.update(m.content.slice(0, 200)); // first 200 chars is enough for fingerprint
    } else if (Array.isArray(m.content)) {
      h.update(JSON.stringify(m.content.slice(0, 2)));
    }
  }
  return h.digest('hex').slice(0, 16);
}

export interface PrefixDiagnostic {
  hash: string;
  messageCount: number;
  lastRole: string;
  timestamp: string;
}

/**
 * Build a diagnostic snapshot for the current prefix state.
 */
export function prefixDiagnostic(
  messages: ChatCompletionMessageParam[]
): PrefixDiagnostic {
  return {
    hash: prefixHash(messages),
    messageCount: messages.length,
    lastRole: messages.length > 0 ? messages[messages.length - 1].role : 'none',
    timestamp: new Date().toISOString(),
  };
}

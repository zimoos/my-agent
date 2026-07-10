import { encode as toonEncode } from '@toon-format/toon';

export const TOOL_RESULT_MAX_CHARS = 4000;

export function compactToolResult(
  result: string,
  maxChars: number = TOOL_RESULT_MAX_CHARS
): string {
  // Base64 images are atomic payloads. Text truncation corrupts the URL while
  // leaving a misleading data:image prefix that downstream code may trust.
  if (/^data:image\/[^;,]+;base64,/i.test(result)) {
    return result;
  }

  let out = result;

  try {
    const parsed = JSON.parse(out);
    const hasArrayShape =
      Array.isArray(parsed) ||
      (parsed &&
        typeof parsed === 'object' &&
        Object.values(parsed).some(Array.isArray));
    if (hasArrayShape) {
      try {
        const toon = toonEncode(parsed);
        if (typeof toon === 'string' && toon.length < out.length) {
          out = toon;
        }
      } catch {
        // TOON encode failed, keep JSON
      }
    }
  } catch {
    // not JSON, keep as-is
  }

  if (out.length > maxChars) {
    const headLen = Math.floor(maxChars * 0.75);
    const tailLen = Math.floor(maxChars * 0.25);
    const head = out.slice(0, headLen);
    const tail = out.slice(-tailLen);
    const dropped = out.length - headLen - tailLen;
    out = head + `\n\n[...truncated ${dropped} chars...]\n\n` + tail;
  }

  return out;
}

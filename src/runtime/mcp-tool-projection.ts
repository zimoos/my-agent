import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { McpCallResult } from '../mcp/types.js';

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject { [key: string]: JsonValue }

export interface ProjectedMcpToolResult {
  content: Array<TextContent | ImageContent>;
  details: {
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  isError: boolean;
}

class McpToolProjectionError extends Error {
  constructor(readonly code: 'MCP_TOOL_RESULT_INVALID' | 'MCP_TOOL_RESULT_EMPTY') {
    super(code);
    this.name = 'McpToolProjectionError';
  }
}

function invalid(): never {
  throw new McpToolProjectionError('MCP_TOOL_RESULT_INVALID');
}

/** Read descriptors before values so accessors and inherited fields never supply data. */
function ownRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}

function shape(
  value: unknown, required: readonly string[], optional: readonly string[] = [],
): Record<string, unknown> {
  const data = ownRecord(value);
  if (required.some(key => !Object.hasOwn(data, key))) invalid();
  if (Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return data;
}

function ownArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) invalid();
  const length = lengthDescriptor.value as number;
  // JSON arrays cannot have holes, extra properties or symbol keys.
  if (Reflect.ownKeys(value).length !== length + 1) invalid();
  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
    copy.push(descriptor.value);
  }
  return copy;
}

function cloneJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid();
  if (typeof value !== 'object') invalid();
  if (ancestors.has(value)) invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return ownArray(value).map(item => cloneJson(item, ancestors));
    const data = ownRecord(value);
    const copy: JsonObject = {};
    for (const key of Object.keys(data)) {
      // Define rather than assign so an own JSON "__proto__" key stays data.
      Object.defineProperty(copy, key, {
        value: cloneJson(data[key], ancestors), enumerable: true, writable: true, configurable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function cloneJsonRecord(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return cloneJson(value) as JsonObject;
}

function projectBlock(value: unknown): TextContent | ImageContent {
  const data = ownRecord(value);
  if (data.type === 'text') {
    shape(value, ['type', 'text']);
    if (typeof data.text !== 'string') invalid();
    return { type: 'text', text: data.text };
  }
  if (data.type === 'image') {
    shape(value, ['type', 'data', 'mimeType'], ['uri']);
    if (typeof data.data !== 'string' || data.data.length === 0
      || typeof data.mimeType !== 'string' || data.mimeType.length === 0) invalid();
    if (Object.hasOwn(data, 'uri') && typeof data.uri !== 'string') invalid();
    // Pi's public ImageContent carries the bytes and MIME type, not a resource URI.
    return { type: 'image', data: data.data, mimeType: data.mimeType };
  }
  return invalid();
}

/** Pure content projection; isError is not evidence about transport or remote effects. */
export function projectMcpToolResult(result: McpCallResult): ProjectedMcpToolResult {
  const data = shape(result, ['content', 'isError'], ['contentBlocks', 'structuredContent', '_meta']);
  if (typeof data.content !== 'string' || typeof data.isError !== 'boolean') invalid();
  const details: ProjectedMcpToolResult['details'] = {};
  if (Object.hasOwn(data, 'structuredContent')) {
    details.structuredContent = cloneJsonRecord(data.structuredContent);
  }
  if (Object.hasOwn(data, '_meta')) details._meta = cloneJsonRecord(data._meta);

  const hasBlocks = Object.hasOwn(data, 'contentBlocks');
  const content: Array<TextContent | ImageContent> = hasBlocks
    ? ownArray(data.contentBlocks).map(projectBlock) : [];
  // This is the existing McpClient's text representation for supported blocks.
  const blockText = content.map(block => block.type === 'text'
    ? block.text : `[image:${block.mimeType}]`).join('\n');
  if (data.content.length > 0 && (!hasBlocks || data.content !== blockText)) {
    content.push({ type: 'text', text: data.content });
  }
  // A mismatched legacy string can include text from blocks the client filtered out.
  // Preserve it whole; substring deletion could remove unrelated, meaningful text.
  const readable = content.some(block => block.type === 'image' || block.text.trim().length > 0);
  if (!readable) {
    if (!Object.hasOwn(details, 'structuredContent')) {
      throw new McpToolProjectionError('MCP_TOOL_RESULT_EMPTY');
    }
    content.push({ type: 'text', text: JSON.stringify(details.structuredContent) });
  }
  return { content, details, isError: data.isError };
}

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createHash } from 'node:crypto';
import { estimateSerializedBytes, estimateTokens } from './tokenCount.js';
import {
  sanitizeZimoosToolResultForHistory,
} from './runtime-context-slots.js';

const DEFAULT_RECENT_GROUPS = 8;
export const DEFAULT_REQUEST_CONTEXT_BYTE_LIMIT = 16 * 1024 * 1024;
export const DEFAULT_REQUEST_ENVELOPE_RESERVE_BYTES = 8 * 1024;
const PROVIDER_PRIVATE_FIELDS = ['reasoning_content'] as const;

type TranscriptGroupKind = 'single' | 'tool';

interface TranscriptGroup {
  index: number;
  start: number;
  messages: ChatCompletionMessageParam[];
  kind: TranscriptGroupKind;
  tokens: number;
  bytes: number;
  valid: boolean;
  invalidReason?: string;
}

export interface RequestContextBuildOptions {
  suffix?: string;
  maxTokens: number;
  maxBytes?: number;
  recentGroups?: number;
  /** Absolute indexes in sourceMessages that must survive windowing. */
  protectedMessageIndexes?: number[];
  requestOnlyAttachment?: string;
  requestOnlyAttachments?: string[];
  latestMessageAttachments?: string[];
}

export interface RequestContextBuildResult {
  messages: ChatCompletionMessageParam[];
  rawTokens: number;
  requestTokens: number;
  protectedTokens: number;
  rawBytes: number;
  requestBytes: number;
  protectedBytes: number;
  maxBytes: number;
  historicalImagesSummarized: number;
  currentImagesSummarized: number;
  omittedGroups: number;
  omittedInvalidGroups: number;
  windowed: boolean;
}

export class RequestContextOverflowError extends Error {
  readonly rawTokens: number;
  readonly protectedTokens: number;
  readonly maxTokens: number;
  readonly rawBytes: number;
  readonly protectedBytes: number;
  readonly maxBytes: number;

  constructor(message: string, params: {
    rawTokens: number;
    protectedTokens: number;
    maxTokens: number;
    rawBytes?: number;
    protectedBytes?: number;
    maxBytes?: number;
  }) {
    super(message);
    this.name = 'RequestContextOverflowError';
    this.rawTokens = params.rawTokens;
    this.protectedTokens = params.protectedTokens;
    this.maxTokens = params.maxTokens;
    this.rawBytes = params.rawBytes ?? 0;
    this.protectedBytes = params.protectedBytes ?? 0;
    this.maxBytes = params.maxBytes ?? DEFAULT_REQUEST_CONTEXT_BYTE_LIMIT;
  }
}

function hasToolCalls(message: ChatCompletionMessageParam): boolean {
  return Array.isArray((message as any).tool_calls) &&
    (message as any).tool_calls.length > 0;
}

function toolCallIds(message: ChatCompletionMessageParam): string[] {
  const calls = (message as any).tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map((call) => (typeof call?.id === 'string' ? call.id : ''))
    .filter(Boolean);
}

function toolCallNameById(message: ChatCompletionMessageParam): Map<string, string> {
  const out = new Map<string, string>();
  const calls = (message as any).tool_calls;
  if (!Array.isArray(calls)) return out;
  for (const call of calls) {
    if (typeof call?.id === 'string') {
      out.set(call.id, String(call?.function?.name ?? 'zimoos'));
    }
  }
  return out;
}

function stripProviderPrivateFields(
  message: ChatCompletionMessageParam
): ChatCompletionMessageParam {
  let copy: Record<string, unknown> | null = null;
  for (const field of PROVIDER_PRIVATE_FIELDS) {
    if ((message as any)[field] !== undefined) {
      const next: Record<string, unknown> = copy ?? { ...(message as any) };
      delete next[field];
      copy = next;
    }
  }
  return (copy ?? message) as ChatCompletionMessageParam;
}

function sanitizeTranscriptMessage(
  message: ChatCompletionMessageParam
): ChatCompletionMessageParam {
  return stripProviderPrivateFields(message);
}

interface HistoricalImageSummaryResult {
  message: ChatCompletionMessageParam;
  summarized: number;
}

function summarizeImageUrl(
  url: string,
  scope: 'historical' | 'current-budget'
): string {
  const prefix = scope === 'historical'
    ? 'historical image omitted from request'
    : 'current-turn image omitted because request byte budget was exceeded';
  const recovery = scope === 'historical'
    ? 'original retained in session history'
    : 'model did not receive pixels; request a smaller image if visual details are required';
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(url);
  if (!match) {
    const urlBytes = Buffer.byteLength(url, 'utf8');
    const sha256 = createHash('sha256').update(url).digest('hex');
    return `[${prefix}: source=url; reference_bytes=${urlBytes}; sha256=${sha256}; ${recovery}]`;
  }

  const mediaType = match[1].toLowerCase();
  const encoded = match[2].replace(/\s+/g, '');
  const decoded = Buffer.from(encoded, 'base64');
  const sha256 = createHash('sha256').update(decoded).digest('hex');
  return `[${prefix}: source=data-url; media_type=${mediaType}; encoded_bytes=${Buffer.byteLength(encoded, 'utf8')}; decoded_bytes=${decoded.byteLength}; sha256=${sha256}; ${recovery}]`;
}

function summarizeHistoricalImages(
  message: ChatCompletionMessageParam
): HistoricalImageSummaryResult {
  const sanitized = stripProviderPrivateFields(message) as any;
  if (!Array.isArray(sanitized.content)) {
    return { message: sanitized, summarized: 0 };
  }

  let summarized = 0;
  const content = sanitized.content.map((part: any) => {
    if (
      part?.type !== 'image_url' ||
      typeof part?.image_url?.url !== 'string'
    ) {
      return part;
    }
    summarized += 1;
    return {
      type: 'text',
      text: summarizeImageUrl(part.image_url.url, 'historical'),
    };
  });
  if (summarized === 0) return { message: sanitized, summarized: 0 };
  return {
    message: { ...sanitized, content } as ChatCompletionMessageParam,
    summarized,
  };
}

function summarizeOneCurrentImage(group: TranscriptGroup): boolean {
  for (let messageIndex = 0; messageIndex < group.messages.length; messageIndex++) {
    const message = group.messages[messageIndex] as any;
    if (!Array.isArray(message.content)) continue;
    const partIndex = message.content.findIndex((part: any) =>
      part?.type === 'image_url' && typeof part?.image_url?.url === 'string'
    );
    if (partIndex < 0) continue;

    const part = message.content[partIndex];
    const content = [...message.content];
    content[partIndex] = {
      type: 'text',
      text: summarizeImageUrl(part.image_url.url, 'current-budget'),
    };
    const messages = [...group.messages];
    messages[messageIndex] = { ...message, content } as ChatCompletionMessageParam;
    group.messages = messages;
    group.tokens = groupTokens(messages);
    group.bytes = groupBytes(messages);
    return true;
  }
  return false;
}

function summarizeGroupHistoricalImages(group: TranscriptGroup): number {
  let summarized = 0;
  const messages = group.messages.map((message) => {
    const result = summarizeHistoricalImages(message);
    summarized += result.summarized;
    return result.message;
  });
  if (summarized > 0) {
    group.messages = messages;
    group.tokens = groupTokens(messages);
    group.bytes = groupBytes(messages);
  }
  return summarized;
}

function sanitizeToolMessage(
  message: ChatCompletionMessageParam,
  sourceTool: string
): ChatCompletionMessageParam {
  const sanitized = stripProviderPrivateFields(message);
  const content = (sanitized as any).content;
  if (typeof content !== 'string') return sanitized;
  const sanitizedContent = sanitizeZimoosToolResultForHistory({
    rawResult: content,
    sourceTool,
  });
  if (!sanitizedContent) return sanitized;
  return {
    ...(sanitized as any),
    content: sanitizedContent,
  } as ChatCompletionMessageParam;
}

function groupTokens(messages: ChatCompletionMessageParam[]): number {
  return estimateTokens(messages);
}

function groupBytes(messages: ChatCompletionMessageParam[]): number {
  return estimateSerializedBytes(messages);
}

function makeGroup(
  params: Omit<TranscriptGroup, 'tokens' | 'bytes'>
): TranscriptGroup {
  return {
    ...params,
    tokens: groupTokens(params.messages),
    bytes: groupBytes(params.messages),
  };
}

function groupTranscript(
  messages: ChatCompletionMessageParam[],
  latestUserMessageIndex: number,
  explicitlyProtectedMessageIndexes: Set<number>
): { groups: TranscriptGroup[]; historicalImagesSummarized: number } {
  const groups: TranscriptGroup[] = [];
  let historicalImagesSummarized = 0;
  let i = 0;

  const sanitizeForIndex = (
    message: ChatCompletionMessageParam,
    index: number
  ): ChatCompletionMessageParam => {
    if (
      explicitlyProtectedMessageIndexes.has(index) ||
      (latestUserMessageIndex >= 0 && index >= latestUserMessageIndex)
    ) {
      return sanitizeTranscriptMessage(message);
    }
    const result = summarizeHistoricalImages(message);
    historicalImagesSummarized += result.summarized;
    return result.message;
  };

  while (i < messages.length) {
    const start = i;
    const message = messages[i];

    if (message.role === 'tool') {
      const historical = sanitizeForIndex(message, i);
      groups.push(makeGroup({
        index: groups.length,
        start,
        messages: [sanitizeToolMessage(historical, 'unknown')],
        kind: 'tool',
        valid: false,
        invalidReason: 'orphan tool result without matching assistant tool_call',
      }));
      i += 1;
      continue;
    }

    if (message.role === 'assistant' && hasToolCalls(message)) {
      const expectedIds = toolCallIds(message);
      const callCounts = countIds(expectedIds);
      const resultCounts = new Map<string, number>();
      let hasEmptyResultId = false;
      const names = toolCallNameById(message);
      const group: ChatCompletionMessageParam[] = [sanitizeForIndex(message, i)];
      i += 1;

      while (i < messages.length && messages[i].role === 'tool') {
        const tool = messages[i] as any;
        const id = typeof tool.tool_call_id === 'string' ? tool.tool_call_id : '';
        const sourceTool = names.get(id) ?? 'zimoos';
        group.push(sanitizeToolMessage(sanitizeForIndex(messages[i], i), sourceTool));
        if (id) resultCounts.set(id, (resultCounts.get(id) ?? 0) + 1);
        else hasEmptyResultId = true;
        i += 1;
      }

      const rawCalls = (message as any).tool_calls as unknown[];
      const missing = [...callCounts].filter(([id, count]) =>
        (resultCounts.get(id) ?? 0) < count
      ).map(([id]) => id);
      const extra = [...resultCounts].filter(([id, count]) =>
        count > (callCounts.get(id) ?? 0)
      ).map(([id]) => id);
      const duplicateCalls = [...callCounts]
        .filter(([, count]) => count !== 1)
        .map(([id]) => id);
      const duplicateResults = [...resultCounts]
        .filter(([, count]) => count !== 1)
        .map(([id]) => id);
      const hasEmptyCallId = expectedIds.length !== rawCalls.length;
      const valid =
        expectedIds.length > 0 &&
        !hasEmptyCallId &&
        missing.length === 0 &&
        extra.length === 0 &&
        duplicateCalls.length === 0 &&
        duplicateResults.length === 0 &&
        !hasEmptyResultId;
      groups.push(makeGroup({
        index: groups.length,
        start,
        messages: group,
        kind: 'tool',
        valid,
        invalidReason: valid
          ? undefined
          : `invalid assistant tool_call group (missing: ${missing.join(', ') || 'none'}, extra: ${extra.join(', ') || 'none'}, duplicate calls: ${duplicateCalls.join(', ') || 'none'}, duplicate results: ${duplicateResults.join(', ') || 'none'}, empty call id: ${hasEmptyCallId ? 'yes' : 'no'}, empty result id: ${hasEmptyResultId ? 'yes' : 'no'})`,
      }));
      continue;
    }

    groups.push(makeGroup({
      index: groups.length,
      start,
      messages: [sanitizeForIndex(message, i)],
      kind: 'single',
      valid: true,
    }));
    i += 1;
  }

  return { groups, historicalImagesSummarized };
}

function countIds(ids: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function lastUserMessageIndex(messages: ChatCompletionMessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

function lastUserGroupIndex(groups: TranscriptGroup[]): number {
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].messages[0]?.role === 'user') return i;
  }
  return -1;
}

function buildSuffixGroup(suffix?: string): ChatCompletionMessageParam[] {
  const text = suffix?.trim();
  return text ? [{ role: 'system', content: text }] : [];
}

function requestOnlyAttachmentText(options: RequestContextBuildOptions): string {
  return [
    options.requestOnlyAttachment,
    ...(options.requestOnlyAttachments ?? []),
    ...(options.latestMessageAttachments ?? []),
  ]
    .map((item) => item?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
}

function appendTextToUserContent(
  content: unknown,
  text: string
): ChatCompletionMessageParam['content'] {
  if (Array.isArray(content)) {
    return [
      ...content,
      { type: 'text', text },
    ] as ChatCompletionMessageParam['content'];
  }
  if (typeof content === 'string') {
    return content.trim().length > 0 ? `${content}\n\n${text}` : text;
  }
  return text;
}

function attachRequestOnlyContext(
  messages: ChatCompletionMessageParam[],
  attachment: string
): ChatCompletionMessageParam[] {
  const text = attachment.trim();
  if (!text) return messages;

  const out = [...messages];
  const last = out[out.length - 1] as any;
  if (last?.role === 'user') {
    out[out.length - 1] = {
      ...last,
      content: appendTextToUserContent(last.content, text),
    } as ChatCompletionMessageParam;
    return out;
  }

  out.push({
    role: 'user',
    content: `Request-only ZimoOS current frame for this turn:\n\n${text}`,
  } as ChatCompletionMessageParam);
  return out;
}

export class RequestContextBuilder {
  build(
    sourceMessages: ChatCompletionMessageParam[],
    options: RequestContextBuildOptions
  ): RequestContextBuildResult {
    if (sourceMessages.length === 0 || sourceMessages[0].role !== 'system') {
      throw new Error('request context requires system[0] as the stable first message');
    }
    if (options.maxTokens <= 0) {
      throw new Error(`invalid request context token limit: ${options.maxTokens}`);
    }
    const maxBytes = options.maxBytes ?? DEFAULT_REQUEST_CONTEXT_BYTE_LIMIT;
    if (maxBytes <= 0) {
      throw new Error(`invalid request context byte limit: ${maxBytes}`);
    }

    const system = sanitizeTranscriptMessage(sourceMessages[0]);
    const suffixMessages = buildSuffixGroup(options.suffix);
    const requestOnlyAttachment = requestOnlyAttachmentText(options);
    const transcript = sourceMessages.slice(1);
    const latestUserMessage = lastUserMessageIndex(transcript);
    const explicitlyProtectedTranscriptIndexes = new Set(
      (options.protectedMessageIndexes ?? [])
        .map((sourceIndex) => sourceIndex - 1)
        .filter((index) => index >= 0)
    );
    const grouped = groupTranscript(
      transcript,
      latestUserMessage,
      explicitlyProtectedTranscriptIndexes
    );
    const groups = grouped.groups;
    let historicalImagesSummarized = grouped.historicalImagesSummarized;
    const recentGroups = Math.max(0, options.recentGroups ?? DEFAULT_RECENT_GROUPS);
    const latestUser = lastUserGroupIndex(groups);
    const protectedIndexes = new Set<number>();
    const recentStart = Math.max(0, groups.length - recentGroups);

    for (let i = recentStart; i < groups.length; i++) protectedIndexes.add(i);
    if (latestUser >= 0) protectedIndexes.add(latestUser);
    for (const sourceIndex of options.protectedMessageIndexes ?? []) {
      const transcriptIndex = sourceIndex - 1;
      const group = groups.find((item) =>
        transcriptIndex >= item.start &&
        transcriptIndex < item.start + item.messages.length
      );
      if (group) protectedIndexes.add(group.index);
    }

    const rawMessages = attachRequestOnlyContext([
      system,
      ...groups.flatMap((group) => group.messages),
      ...suffixMessages,
    ], requestOnlyAttachment);
    const rawTokens = estimateTokens(rawMessages);
    const rawBytes = estimateSerializedBytes(rawMessages);
    for (const group of groups) {
      if (!protectedIndexes.has(group.index)) {
        historicalImagesSummarized += summarizeGroupHistoricalImages(group);
      }
    }
    const protectedGroups = groups.filter((group) =>
      protectedIndexes.has(group.index)
    );
    const invalidProtected = protectedGroups.find((group) => !group.valid);
    const buildProtectedMessages = () => attachRequestOnlyContext([
      system,
      ...protectedGroups.flatMap((group) => group.messages),
      ...suffixMessages,
    ], requestOnlyAttachment);
    let baseMessages = buildProtectedMessages();
    let protectedTokens = estimateTokens(baseMessages);
    let protectedBytes = estimateSerializedBytes(baseMessages);
    let currentImagesSummarized = 0;

    if (invalidProtected) {
      throw new RequestContextOverflowError(
        `protected request context contains invalid tool protocol: ${invalidProtected.invalidReason}`,
        { rawTokens, protectedTokens, maxTokens: options.maxTokens, rawBytes, protectedBytes, maxBytes }
      );
    }
    const degradableProtectedGroups = protectedGroups
      .filter((group) => group.kind === 'tool')
      .sort((a, b) => a.index - b.index);
    while (
      protectedBytes > maxBytes ||
      protectedTokens > options.maxTokens
    ) {
      const degraded = degradableProtectedGroups.some((group) =>
        summarizeOneCurrentImage(group)
      );
      if (!degraded) break;
      currentImagesSummarized += 1;
      baseMessages = buildProtectedMessages();
      protectedTokens = estimateTokens(baseMessages);
      protectedBytes = estimateSerializedBytes(baseMessages);
    }
    if (protectedTokens > options.maxTokens) {
      throw new RequestContextOverflowError(
        `protected request context is too large (${protectedTokens}/${options.maxTokens} tokens) after safe image degradation`,
        { rawTokens, protectedTokens, maxTokens: options.maxTokens, rawBytes, protectedBytes, maxBytes }
      );
    }
    if (protectedBytes > maxBytes) {
      throw new RequestContextOverflowError(
        `current request context is too large (${protectedBytes}/${maxBytes} bytes) after safe image degradation; retry with fewer or smaller input images, or compress images before sending`,
        { rawTokens, protectedTokens, maxTokens: options.maxTokens, rawBytes, protectedBytes, maxBytes }
      );
    }

    const selected = new Set<number>(protectedIndexes);
    let selectedTokens = protectedTokens;

    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      if (selected.has(group.index) || !group.valid) continue;
      if (selectedTokens + group.tokens > options.maxTokens) continue;
      const candidate = new Set(selected);
      candidate.add(group.index);
      const candidateMessages = attachRequestOnlyContext([
        system,
        ...groups
          .filter((item) => candidate.has(item.index))
          .flatMap((item) => item.messages),
        ...suffixMessages,
      ], requestOnlyAttachment);
      if (estimateSerializedBytes(candidateMessages) > maxBytes) continue;
      selected.add(group.index);
      selectedTokens += group.tokens;
    }

    const selectedGroups = groups.filter((group) => selected.has(group.index));
    const requestMessages = attachRequestOnlyContext([
      system,
      ...selectedGroups.flatMap((group) => group.messages),
      ...suffixMessages,
    ], requestOnlyAttachment);
    const requestTokens = estimateTokens(requestMessages);
    const requestBytes = estimateSerializedBytes(requestMessages);
    const omittedGroups = groups.length - selectedGroups.length;
    const omittedInvalidGroups = groups.filter((group) =>
      !group.valid && !selected.has(group.index)
    ).length;

    return {
      messages: requestMessages,
      rawTokens,
      requestTokens,
      protectedTokens,
      rawBytes,
      requestBytes,
      protectedBytes,
      maxBytes,
      historicalImagesSummarized,
      currentImagesSummarized,
      omittedGroups,
      omittedInvalidGroups,
      windowed:
        rawTokens !== requestTokens ||
        rawBytes !== requestBytes ||
        omittedGroups > 0 ||
        omittedInvalidGroups > 0 ||
        historicalImagesSummarized > 0 ||
        currentImagesSummarized > 0,
    };
  }
}

import { cloneRuntimeJson, ownData } from './data.js';

// Pi 0.86.1's public session/message types permit these properties to be absent.
// Its in-memory records sometimes keep them as own undefined data properties,
// whereas its JSONL writer omits them. Do not relax the general JSON boundary.
const entryOptional: Record<string, readonly string[]> = {
  usage: ['note'], compaction: ['details', 'usage', 'fromHook', 'systemMessage'],
  branch_summary: ['details', 'usage', 'fromHook'], custom: ['data'],
  label: ['label'], session_info: ['name'], custom_message: ['details'],
};
const messageOptional: Record<string, readonly string[]> = {
  system: ['sections', 'toolsAdded', 'toolsRemoved'],
  assistant: ['responseModel', 'responseId', 'providerThinkingLevel', 'diagnostics', 'deferred',
    'errorMessage', 'rawStopReason', 'endTurn'],
  toolResult: ['details', 'usage'], custom: ['details'],
  bashExecution: ['exitCode', 'fullOutputPath', 'excludeFromContext'],
};
const blockOptional: Record<string, readonly string[]> = {
  text: ['textSignature'], thinking: ['thinkingSignature', 'redacted'], toolCall: ['thoughtSignature', 'namespace'],
};

function fail(): never { throw new Error('MA_INVALID_JSON'); }
function record(value: unknown, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail();
    if (descriptor.value === undefined && optional.includes(key)) continue;
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function optional(table: Record<string, readonly string[]>, value: unknown): readonly string[] {
  return typeof value === 'string' && Object.hasOwn(table, value) ? table[value] : [];
}
function array(value: unknown, project: (value: unknown) => unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) fail();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail();
    result.push(project(descriptor.value));
  }
  return result;
}
function usage(value: unknown): Record<string, unknown> {
  return record(value, ['cacheWrite1h', 'reasoning']);
}
function message(value: unknown): Record<string, unknown> {
  const output = record(value, optional(messageOptional, ownData(value, 'role')));
  if (Array.isArray(output.content)) output.content = array(output.content,
    block => record(block, optional(blockOptional, ownData(block, 'type'))));
  if (Object.hasOwn(output, 'usage')) output.usage = usage(output.usage);
  if (Object.hasOwn(output, 'deferred')) output.deferred = record(output.deferred, ['expiresAt', 'pollAfterMs', 'data']);
  return output;
}

/** Read-only JSON projection of SDK-owned history; no serialization hooks run. */
export function projectPiHistory(entries: unknown): ReadonlyArray<Record<string, unknown>> {
  const projected = array(entries, entry => {
    const output = record(entry, optional(entryOptional, ownData(entry, 'type')));
    if (output.type === 'message') output.message = message(output.message);
    if (Object.hasOwn(output, 'usage')) output.usage = usage(output.usage);
    if (Object.hasOwn(output, 'systemMessage')) output.systemMessage = message(output.systemMessage);
    return output;
  });
  // Unknown properties and nested details remain strict JSON. Required undefined,
  // array holes, functions, symbols, BigInt, accessors and custom prototypes fail.
  return cloneRuntimeJson(projected) as ReadonlyArray<Record<string, unknown>>;
}

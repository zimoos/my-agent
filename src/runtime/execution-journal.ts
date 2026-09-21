import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Invocation, ToolReceipt, TurnScope } from './contracts.js';

interface JournalFields {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  operationId: string;
  turnId: string;
  epoch: number;
  at: string;
}

export type ExecutionJournalInput = JournalFields & (
  | { kind: 'turn.registered'; turn: TurnScope }
  | { kind: 'turn.revoked' }
  | {
      kind: 'execution.prepared' | 'execution.authorized' | 'execution.dispatching';
      invocation: Invocation;
    }
  | { kind: 'execution.receipt'; invocation: Invocation; receipt: ToolReceipt }
);

export type ExecutionJournalEntry = ExecutionJournalInput & { seq: number };

export interface JournalReadResult {
  entries: ExecutionJournalEntry[];
  incompleteTail: boolean;
}

export interface ExecutionJournal {
  append(event: ExecutionJournalInput): Promise<ExecutionJournalEntry>;
  read(): Promise<JournalReadResult>;
  close(): Promise<void>;
}

type JournalErrorCode =
  | 'JOURNAL_LOCKED'
  | 'JOURNAL_INVALID_EVENT'
  | 'JOURNAL_CORRUPT'
  | 'JOURNAL_INCOMPLETE_TAIL'
  | 'JOURNAL_CLOSED'
  | 'JOURNAL_IO'
  | 'JOURNAL_QUEUE_FULL';

export class ExecutionJournalError extends Error {
  constructor(public readonly code: JournalErrorCode, message: string) {
    super(message);
    this.name = 'ExecutionJournalError';
  }
}

const COMMON_KEYS = [
  'schemaVersion', 'eventId', 'sessionId', 'operationId', 'turnId', 'epoch', 'at', 'kind',
];
const MAX_PENDING_APPENDS = 256;
const NOFOLLOW = constants.O_NOFOLLOW;

function invalid(): never {
  throw new ExecutionJournalError('JOURNAL_INVALID_EVENT', 'Invalid execution journal event');
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}

function id(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) invalid();
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}

function source(value: unknown): Invocation['source'] {
  const data = object(value);
  keys(data, ['serverId', 'toolName']);
  return { serverId: id(data.serverId), toolName: id(data.toolName) };
}

function sameScope(nested: TurnScope | Invocation, outer: JournalFields): void {
  if (nested.sessionId !== outer.sessionId || nested.operationId !== outer.operationId
    || nested.turnId !== outer.turnId || nested.epoch !== outer.epoch) invalid();
}

function turn(value: unknown, outer: JournalFields): TurnScope {
  const data = object(value);
  keys(data, ['sessionId', 'turnId', 'epoch', 'operationId', 'stageId', 'budgetRef']);
  const result: TurnScope = {
    sessionId: id(data.sessionId), turnId: id(data.turnId), epoch: positiveInteger(data.epoch),
    operationId: id(data.operationId), stageId: id(data.stageId), budgetRef: id(data.budgetRef),
  };
  sameScope(result, outer);
  return result;
}

function invocation(value: unknown, outer: JournalFields): Invocation {
  const data = object(value);
  keys(data, ['executionId', 'toolCallId', 'sessionId', 'operationId', 'turnId', 'epoch',
    'source', 'argsSha256', 'permissionScopeHash']);
  const result: Invocation = {
    executionId: id(data.executionId), toolCallId: id(data.toolCallId),
    sessionId: id(data.sessionId), operationId: id(data.operationId), turnId: id(data.turnId),
    epoch: positiveInteger(data.epoch), source: source(data.source),
    argsSha256: hash(data.argsSha256), permissionScopeHash: hash(data.permissionScopeHash),
  };
  sameScope(result, outer);
  return result;
}

function receipt(value: unknown, call: Invocation): ToolReceipt {
  const data = object(value);
  keys(data, ['executionId', 'source', 'status', 'resultRef', 'stopConfirmed', 'evidenceRef']);
  const statuses = ['succeeded', 'failed', 'denied', 'cancelled_not_sent', 'unknown'];
  if (typeof data.status !== 'string' || !statuses.includes(data.status)
    || typeof data.stopConfirmed !== 'boolean') invalid();
  const result: ToolReceipt = {
    executionId: id(data.executionId), source: source(data.source),
    status: data.status as ToolReceipt['status'], stopConfirmed: data.stopConfirmed,
  };
  if ('resultRef' in data) result.resultRef = id(data.resultRef);
  if ('evidenceRef' in data) result.evidenceRef = id(data.evidenceRef);
  if (result.executionId !== call.executionId || result.source.serverId !== call.source.serverId
    || result.source.toolName !== call.source.toolName) invalid();
  return result;
}

/** Rebuild every nested object before an append can enter the queue. */
function cloneEvent(value: unknown, sessionId: string, reading = false): ExecutionJournalInput {
  const data = object(value);
  const common = reading ? [...COMMON_KEYS, 'seq'] : COMMON_KEYS;
  if (data.schemaVersion !== 1) invalid();
  const fields: JournalFields = {
    schemaVersion: 1, eventId: id(data.eventId), sessionId: id(data.sessionId),
    operationId: id(data.operationId), turnId: id(data.turnId),
    epoch: positiveInteger(data.epoch), at: timestamp(data.at),
  };
  if (fields.sessionId !== sessionId) invalid();
  switch (data.kind) {
    case 'turn.registered':
      keys(data, [...common, 'turn']);
      return { ...fields, kind: data.kind, turn: turn(data.turn, fields) };
    case 'turn.revoked':
      keys(data, common);
      return { ...fields, kind: data.kind };
    case 'execution.prepared':
    case 'execution.authorized':
    case 'execution.dispatching':
      keys(data, [...common, 'invocation']);
      return { ...fields, kind: data.kind, invocation: invocation(data.invocation, fields) };
    case 'execution.receipt': {
      keys(data, [...common, 'invocation', 'receipt']);
      const call = invocation(data.invocation, fields);
      return { ...fields, kind: data.kind, invocation: call, receipt: receipt(data.receipt, call) };
    }
    default:
      return invalid();
  }
}

function io(error: unknown): ExecutionJournalError {
  if (error instanceof ExecutionJournalError) return error;
  return new ExecutionJournalError('JOURNAL_IO', 'Execution journal filesystem operation failed');
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function regularFile(handle: FileHandle): Promise<void> {
  if (!(await handle.stat()).isFile()) {
    throw new ExecutionJournalError('JOURNAL_IO', 'Execution journal leaf must be a regular file');
  }
}

function decodeEntries(bytes: Uint8Array, sessionId: string): JournalReadResult {
  const incompleteTail = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a;
  const confirmed = bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(confirmed);
  } catch {
    throw new ExecutionJournalError('JOURNAL_CORRUPT', 'Invalid journal encoding');
  }
  const lines = text.split('\n');
  lines.pop(); // The empty suffix after the last confirmed newline.
  const entries: ExecutionJournalEntry[] = [];
  const eventIds = new Set<string>();
  for (const line of lines) {
    try {
      const raw: unknown = JSON.parse(line);
      const data = object(raw);
      const event = cloneEvent(data, sessionId, true);
      const seq = positiveInteger(data.seq);
      if (seq !== entries.length + 1 || eventIds.has(event.eventId)) invalid();
      eventIds.add(event.eventId);
      entries.push({ ...event, seq });
    } catch {
      throw new ExecutionJournalError('JOURNAL_CORRUPT', 'Invalid complete execution journal record');
    }
  }
  return { entries, incompleteTail };
}

export async function readExecutionJournal(options: {
  directory: string;
  sessionId: string;
}): Promise<JournalReadResult> {
  const sessionId = id(options.sessionId);
  if (typeof options.directory !== 'string' || options.directory.trim().length === 0) invalid();
  let handle: FileHandle | undefined;
  try {
    handle = await open(join(resolve(options.directory), 'execution.jsonl'), constants.O_RDONLY | NOFOLLOW);
    await regularFile(handle);
    return decodeEntries(await handle.readFile(), sessionId);
  } catch (error) {
    throw io(error);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

export async function openExecutionJournal(options: {
  directory: string;
  sessionId: string;
  ownerId: string;
}): Promise<ExecutionJournal> {
  const sessionId = id(options.sessionId);
  const ownerId = id(options.ownerId);
  if (typeof options.directory !== 'string' || options.directory.trim().length === 0) invalid();
  const directory = resolve(options.directory);
  const lockPath = join(directory, '.writer.lock');
  const logPath = join(directory, 'execution.jsonl');
  const instanceId = randomUUID();
  let directoryHandle: FileHandle | undefined;
  let lockHandle: FileHandle | undefined;
  let logHandle: FileHandle | undefined;
  let lockIdentity: { dev: number; ino: number } | undefined;

  async function releaseOwnLock(): Promise<void> {
    if (!lockHandle || !lockIdentity) return;
    let current: FileHandle | undefined;
    try {
      current = await open(lockPath, constants.O_RDONLY | NOFOLLOW);
      const stat = await current.stat();
      if (!stat.isFile() || stat.dev !== lockIdentity.dev || stat.ino !== lockIdentity.ino) return;
      const contents: unknown = JSON.parse(await current.readFile('utf8'));
      if (contents === null || typeof contents !== 'object'
        || !('instanceId' in contents) || contents.instanceId !== instanceId) return;
      const pathStat = await lstat(lockPath);
      if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino || !pathStat.isFile()) return;
      await unlink(lockPath);
      await directoryHandle?.sync();
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    } finally {
      if (current) await current.close();
    }
  }

  try {
    const firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 });
    directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
    const ancestor = firstCreated ? dirname(resolve(firstCreated)) : dirname(directory);
    for (let path = dirname(directory); ; path = dirname(path)) {
      const parent = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await parent.sync(); } finally { await parent.close(); }
      if (path === ancestor || path === dirname(path)) break;
    }
    try {
      lockHandle = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    } catch (error) {
      if (isCode(error, 'EEXIST')) {
        throw new ExecutionJournalError('JOURNAL_LOCKED', 'Execution journal already has a writer lock');
      }
      throw error;
    }
    const lockStat = await lockHandle.stat();
    lockIdentity = { dev: lockStat.dev, ino: lockStat.ino };
    await lockHandle.writeFile(JSON.stringify({ ownerId, sessionId, pid: process.pid, instanceId }) + '\n');
    await lockHandle.sync();
    await directoryHandle.sync();
    logHandle = await open(logPath, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | NOFOLLOW, 0o600);
    await regularFile(logHandle);
    const initial = decodeEntries(await logHandle.readFile(), sessionId);
    if (initial.incompleteTail) {
      throw new ExecutionJournalError('JOURNAL_INCOMPLETE_TAIL', 'Unconfirmed journal tail prevents append');
    }
    await logHandle.chmod(0o600);
    await logHandle.sync();
    await directoryHandle.sync();

    const file = logHandle;
    const eventIds = new Set(initial.entries.map(entry => entry.eventId));
    let nextSeq = initial.entries.length + 1;
    let pendingAppends = 0;
    let closing = false;
    let failed: ExecutionJournalError | undefined;
    let queue: Promise<void> = Promise.resolve();
    let closePromise: Promise<void> | undefined;

    function enqueue<T>(work: () => Promise<T>): Promise<T> {
      const result = queue.then(work);
      queue = result.then(() => undefined, () => undefined);
      return result;
    }

    const journal: ExecutionJournal = {
      append(event) {
        if (closing) return Promise.reject(new ExecutionJournalError('JOURNAL_CLOSED', 'Journal is closing or closed'));
        if (failed) return Promise.reject(failed);
        if (pendingAppends >= MAX_PENDING_APPENDS) {
          return Promise.reject(new ExecutionJournalError('JOURNAL_QUEUE_FULL', 'Journal append queue is full'));
        }
        let snapshot: ExecutionJournalInput;
        try {
          snapshot = cloneEvent(event, sessionId);
          if (eventIds.has(snapshot.eventId)) invalid();
        } catch (error) {
          return Promise.reject(error instanceof ExecutionJournalError ? error
            : new ExecutionJournalError('JOURNAL_INVALID_EVENT', 'Invalid execution journal event'));
        }
        pendingAppends += 1;
        eventIds.add(snapshot.eventId);
        return enqueue(async () => {
          if (failed) throw failed;
          try {
            const entry: ExecutionJournalEntry = { ...snapshot, seq: nextSeq };
            if (!Number.isSafeInteger(nextSeq)) invalid();
            await file.writeFile(JSON.stringify(entry) + '\n');
            await file.sync();
            nextSeq += 1;
            return entry;
          } catch (error) {
            failed = io(error);
            throw failed;
          }
        }).finally(() => { pendingAppends -= 1; });
      },
      read() {
        if (closing) return Promise.reject(new ExecutionJournalError('JOURNAL_CLOSED', 'Journal is closing or closed'));
        return enqueue(() => readExecutionJournal({ directory, sessionId }));
      },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
          await queue;
          let failure: unknown;
          try { await file.close(); } catch (error) { failure = error; }
          try { await releaseOwnLock(); } catch (error) { failure ??= error; }
          try { await lockHandle?.close(); } catch (error) { failure ??= error; }
          try { await directoryHandle?.close(); } catch (error) { failure ??= error; }
          if (failure) throw io(failure);
        })();
        return closePromise;
      },
    };
    return journal;
  } catch (error) {
    if (logHandle) await logHandle.close().catch(() => undefined);
    await releaseOwnLock().catch(() => undefined);
    if (lockHandle) await lockHandle.close().catch(() => undefined);
    if (directoryHandle) await directoryHandle.close().catch(() => undefined);
    throw io(error);
  }
}

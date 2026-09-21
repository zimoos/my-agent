import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  openExecutionJournal,
  readExecutionJournal,
  type ExecutionJournalInput,
} from '../../src/runtime/execution-journal.js';
import { journalTurnVector, journalExecutionVector } from './fixtures/batch1-vectors.js';

const sessionId = 'ma-session-a';
const ownerId = 'test-owner-a';
const knownCodes = new Set([
  'JOURNAL_LOCKED', 'JOURNAL_INVALID_EVENT', 'JOURNAL_CORRUPT',
  'JOURNAL_INCOMPLETE_TAIL', 'JOURNAL_CLOSED', 'JOURNAL_IO', 'JOURNAL_QUEUE_FULL',
]);
const hasCode = (code: string) => (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === code;

async function directoryFor(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ma-next-journal-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function syncPrototype(directory: string): Promise<{ sync(this: FileHandle): Promise<void> }> {
  const probePath = path.join(directory, 'sync-probe');
  const handle = await fs.open(probePath, 'wx', 0o600);
  const prototype = Object.getPrototypeOf(handle) as { sync(this: FileHandle): Promise<void> };
  await handle.close();
  await fs.unlink(probePath);
  return prototype;
}

function waitBounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000); }),
  ]).finally(() => clearTimeout(timer));
}

test('A2 appends all frozen event kinds, fsyncs before returning, and reopens exact records', async (t) => {
  const directory = await directoryFor(t);
  const prototype = await syncPrototype(directory);
  const original = prototype.sync;
  let synced = 0;
  prototype.sync = async function () { await original.call(this); synced++; };
  t.after(() => { prototype.sync = original; });
  const journal = await openExecutionJournal({ directory, sessionId, ownerId });
  const { turn: _turn, ...base } = journalTurnVector(2);
  const events: ExecutionJournalInput[] = [journalTurnVector(1), { ...base, kind: 'turn.revoked' }];
  for (const [offset, kind] of ['execution.prepared', 'execution.authorized', 'execution.dispatching'].entries()) {
    const { receipt: _receipt, ...event } = journalExecutionVector(offset + 3);
    events.push({ ...event, kind } as ExecutionJournalInput);
  }
  events.push(journalExecutionVector(6));
  const expected: unknown[] = [];
  for (const [index, event] of events.entries()) {
    const before = synced;
    const result = await journal.append(event);
    assert.ok(synced > before, 'append resolved before a real FileHandle.sync completed');
    expected.push({ ...event, seq: index + 1 });
    assert.deepEqual(result, expected[index]);
  }
  assert.deepEqual(await journal.read(), { entries: expected, incompleteTail: false });
  const logPath = path.join(directory, 'execution.jsonl');
  const lockPath = path.join(directory, '.writer.lock');
  assert.equal((await fs.stat(logPath)).mode & 0o077, 0, 'journal permissions must be private');
  assert.equal((await fs.stat(lockPath)).mode & 0o077, 0, 'lock permissions must be private');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<string, unknown>;
  assert.equal(lock.ownerId, ownerId);
  assert.equal(lock.sessionId, sessionId);
  assert.equal(lock.pid, process.pid);
  const raw = await fs.readFile(logPath, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.equal(raw.trimEnd().split('\n').length, 6);
  await journal.close();
  await assert.rejects(fs.stat(lockPath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  const reopened = await openExecutionJournal({ directory, sessionId, ownerId: 'test-owner-b' });
  assert.deepEqual(await reopened.read(), { entries: expected, incompleteTail: false });
  const next = await reopened.append(journalTurnVector(7));
  assert.equal(next.seq, 7);
  await reopened.close();
});

test('A2 clones nested invocation/receipt data at append call time', async (t) => {
  const directory = await directoryFor(t);
  const journal = await openExecutionJournal({ directory, sessionId, ownerId });
  const event = journalExecutionVector(1);
  const expected = structuredClone(event);
  const pending = journal.append(event);
  event.invocation.source.serverId = 'mutated-server';
  event.receipt.source.toolName = 'mutated-tool';
  event.invocation.argsSha256 = 'DO_NOT_PERSIST_SECRET_A';
  event.eventId = 'mutated-event';
  const appended = await pending;
  assert.deepEqual(appended, { ...expected, seq: 1 });
  const raw = await fs.readFile(path.join(directory, 'execution.jsonl'), 'utf8');
  assert.ok(!raw.includes('mutated-'));
  assert.ok(!raw.includes('DO_NOT_PERSIST_SECRET_A'));
  await journal.close();
});

test('A2 close drains accepted work, rejects later append, and readonly inspection does not alter files', async (t) => {
  const directory = await directoryFor(t);
  const journal = await openExecutionJournal({ directory, sessionId, ownerId });
  const first = journal.append(journalTurnVector(1));
  const second = journal.append(journalTurnVector(2));
  const closing = journal.close();
  await Promise.all([first, second, closing]);
  await assert.rejects(journal.append(journalTurnVector(3)), hasCode('JOURNAL_CLOSED'));
  const raw = await fs.readFile(path.join(directory, 'execution.jsonl'));
  assert.deepEqual(await readExecutionJournal({ directory, sessionId }), {
    entries: [{ ...journalTurnVector(1), seq: 1 }, { ...journalTurnVector(2), seq: 2 }], incompleteTail: false,
  });
  assert.deepEqual(await fs.readFile(path.join(directory, 'execution.jsonl')), raw);
  await assert.rejects(fs.stat(path.join(directory, '.writer.lock')), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
});

test('A2 bounds accepted unsettled appends to 256 including active fsync', async (t) => {
  const directory = await directoryFor(t);
  const prototype = await syncPrototype(directory);
  const journal = await openExecutionJournal({ directory, sessionId, ownerId });
  const original = prototype.sync;
  let release!: () => void;
  let reached!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const activeSync = new Promise<void>((resolve) => { reached = resolve; });
  let blockedOnce = false;
  prototype.sync = async function () {
    if (!blockedOnce) { blockedOnce = true; reached(); await barrier; }
    await original.call(this);
  };
  t.after(() => { release(); prototype.sync = original; });
  const attempts = [journal.append(journalTurnVector(1)).then(
    (entry) => ({ accepted: true as const, entry }),
    (error: unknown) => ({ accepted: false as const, error }),
  )];
  await waitBounded(activeSync, 'active fsync');
  for (let index = 2; index <= 1024; index++) {
    attempts.push(journal.append(journalTurnVector(index)).then(
      (entry) => ({ accepted: true as const, entry }),
      (error: unknown) => ({ accepted: false as const, error }),
    ));
  }
  release();
  const results = await waitBounded(Promise.all(attempts), 'bounded append queue');
  const accepted = results.filter((result) => result.accepted);
  const rejected = results.filter((result) => !result.accepted);
  assert.equal(accepted.length, 256);
  assert.equal(rejected.length, 768);
  for (const result of rejected) assert.ok(hasCode('JOURNAL_QUEUE_FULL')(result.error));
  assert.deepEqual(accepted.map((result) => result.entry.seq), Array.from({ length: 256 }, (_, index) => index + 1));
  assert.deepEqual(accepted.map((result) => result.entry.eventId), Array.from({ length: 256 }, (_, index) => `event-${index + 1}`));
  assert.equal((await journal.read()).entries.length, 256);
  await journal.close();
});

test('A2 single real FileHandle.sync EIO propagates and fences subsequent writes', async (t) => {
  const directory = await directoryFor(t);
  const prototype = await syncPrototype(directory);
  const journal = await openExecutionJournal({ directory, sessionId, ownerId });
  const original = prototype.sync;
  let injected = false;
  prototype.sync = async function () {
    if (!injected) { injected = true; throw Object.assign(new Error('test-only sync failure'), { code: 'EIO' }); }
    await original.call(this);
  };
  t.after(() => { prototype.sync = original; });
  await assert.rejects(journal.append(journalTurnVector(1)), hasCode('JOURNAL_IO'));
  prototype.sync = original;
  assert.ok(injected);
  const before = await fs.readFile(path.join(directory, 'execution.jsonl'));
  await assert.rejects(journal.append(journalTurnVector(2)), (error: unknown) => hasCode('JOURNAL_IO')(error) || hasCode('JOURNAL_CLOSED')(error));
  assert.deepEqual(await fs.readFile(path.join(directory, 'execution.jsonl')), before, 'write continued after fsync failure');
  await journal.close().catch((error: unknown) => { assert.ok(hasCode('JOURNAL_IO')(error) || hasCode('JOURNAL_CLOSED')(error)); });
});

test('A2 validates every record field and nested correlation before persisting it', async (t) => {
  const rootDirectory = await directoryFor(t);
  const invalid: Array<[string, unknown]> = [];
  const event = journalExecutionVector(1);
  for (const key of Object.keys(event)) {
    const missing = { ...event } as Record<string, unknown>;
    delete missing[key];
    invalid.push([`missing-${key}`, missing]);
  }
  for (const epoch of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7']) invalid.push(['epoch', { ...event, epoch }]);
  for (const at of ['2026-02-30T00:00:00.000Z', '2026-09-21T00:00:00Z', '2026-09-21T00:00:00.000+00:00', 'invalid']) invalid.push(['timestamp', { ...event, at }]);
  for (const key of ['eventId', 'sessionId', 'operationId', 'turnId']) {
    for (const value of ['', 'x'.repeat(129)]) invalid.push([key, { ...event, [key]: value }]);
  }
  invalid.push(['extra-seq', { ...event, seq: 1 }]);
  invalid.push(['extra-credentials', { ...event, apiKey: 'DO_NOT_PERSIST_SECRET_A' }]);
  invalid.push(['schema', { ...event, schemaVersion: 2 }]);
  invalid.push(['unknown-kind', { ...event, kind: 'mission.accepted' }]);
  for (const key of ['sessionId', 'operationId', 'turnId', 'epoch']) invalid.push([`invocation-${key}`, { ...event, invocation: { ...event.invocation, [key]: key === 'epoch' ? 8 : 'other' } }]);
  for (const key of ['argsSha256', 'permissionScopeHash']) {
    for (const hash of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) invalid.push([key, { ...event, invocation: { ...event.invocation, [key]: hash } }]);
  }
  invalid.push(['raw-arguments', { ...event, invocation: { ...event.invocation, arguments: { secret: 'DO_NOT_PERSIST_SECRET_A' } } }]);
  invalid.push(['execution-mismatch', { ...event, receipt: { ...event.receipt, executionId: 'other' } }]);
  invalid.push(['source-mismatch', { ...event, receipt: { ...event.receipt, source: { ...event.receipt.source, serverId: 'other' } } }]);
  invalid.push(['tool-mismatch', { ...event, receipt: { ...event.receipt, source: { ...event.receipt.source, toolName: 'other' } } }]);
  invalid.push(['receipt-status', { ...event, receipt: { ...event.receipt, status: 'accepted' } }]);
  invalid.push(['stop-boolean', { ...event, receipt: { ...event.receipt, stopConfirmed: 'true' } }]);
  for (const key of ['resultRef', 'evidenceRef']) {
    for (const value of ['', 'x'.repeat(129)]) invalid.push([key, { ...event, receipt: { ...event.receipt, [key]: value } }]);
  }
  const turn = journalTurnVector(1);
  for (const key of ['sessionId', 'operationId', 'turnId', 'epoch']) invalid.push([`turn-${key}`, { ...turn, turn: { ...turn.turn, [key]: key === 'epoch' ? 8 : 'other' } }]);
  for (const [index, [label, input]] of invalid.entries()) {
    const directory = path.join(rootDirectory, `case-${index}`);
    const journal = await openExecutionJournal({ directory, sessionId, ownerId });
    await assert.rejects(journal.append(input as ExecutionJournalInput), hasCode('JOURNAL_INVALID_EVENT'), label);
    const contents = await fs.readFile(path.join(directory, 'execution.jsonl'), 'utf8');
    assert.equal(contents, '', `invalid ${label} was persisted`);
    await journal.close();
  }
});

test('A2 accepts maximum bounded IDs and rejects duplicate event identity', async (t) => {
  const directory = await directoryFor(t);
  const journal = await openExecutionJournal({ directory, sessionId, ownerId });
  const event = { ...journalExecutionVector(1), eventId: 'x'.repeat(128) };
  event.receipt = { ...event.receipt, resultRef: 'r'.repeat(128), evidenceRef: 'e'.repeat(128) } as typeof event.receipt;
  await journal.append(event);
  await assert.rejects(journal.append(event), hasCode('JOURNAL_INVALID_EVENT'));
  assert.equal((await journal.read()).entries.length, 1);
  await journal.close();
});

test('A2 complete and truncated trailing JSON both remain unconfirmed and block append', async (t) => {
  const rootDirectory = await directoryFor(t);
  const first = { ...journalTurnVector(1), seq: 1 };
  const next = { ...journalTurnVector(2), seq: 2 };
  for (const [index, tail] of [JSON.stringify(next), '{"schemaVersion":1,'].entries()) {
    const directory = path.join(rootDirectory, `tail-${index}`);
    await fs.mkdir(directory);
    const raw = `${JSON.stringify(first)}\n${tail}`;
    const filename = path.join(directory, 'execution.jsonl');
    await fs.writeFile(filename, raw, { mode: 0o600 });
    assert.deepEqual(await readExecutionJournal({ directory, sessionId }), { entries: [first], incompleteTail: true });
    await assert.rejects(openExecutionJournal({ directory, sessionId, ownerId }), hasCode('JOURNAL_INCOMPLETE_TAIL'));
    assert.equal(await fs.readFile(filename, 'utf8'), raw, 'open must not truncate the tail');
  }
});

test('A2 read rejects middle corruption, blank lines, scope/schema damage and sequence discontinuities', async (t) => {
  const rootDirectory = await directoryFor(t);
  const first = { ...journalTurnVector(1), seq: 1 };
  const next = { ...journalTurnVector(2), seq: 2 };
  const encode = (value: unknown) => `${JSON.stringify(value)}\n`;
  const cases = [
    `${encode(first)}{broken}\n${encode(next)}`,
    `${encode(first)}\n${encode(next)}`,
    encode({ ...first, seq: 0 }),
    encode({ ...first, seq: 2 }),
    `${encode(first)}${encode({ ...next, seq: 3 })}`,
    `${encode(first)}${encode({ ...next, seq: 1 })}`,
    `${encode(first)}${encode({ ...next, eventId: first.eventId })}`,
    encode({ ...first, schemaVersion: 2 }),
    encode({ ...first, sessionId: 'foreign-session' }),
    encode({ ...first, extra: 'DO_NOT_PERSIST_SECRET_A' }),
    `${encode(first)}null\n`,
  ];
  for (const [index, raw] of cases.entries()) {
    const directory = path.join(rootDirectory, `corrupt-${index}`);
    await fs.mkdir(directory);
    const filename = path.join(directory, 'execution.jsonl');
    await fs.writeFile(filename, raw, { mode: 0o600 });
    await assert.rejects(readExecutionJournal({ directory, sessionId }), hasCode('JOURNAL_CORRUPT'), `corrupt case ${index}`);
    await assert.rejects(openExecutionJournal({ directory, sessionId, ownerId }), hasCode('JOURNAL_CORRUPT'), `open corrupt case ${index}`);
    assert.equal(await fs.readFile(filename, 'utf8'), raw);
  }
});

test('A2 incomplete UTF-8 at an unconfirmed tail preserves the prefix; a terminated bad line is corrupt', async (t) => {
  const rootDirectory = await directoryFor(t);
  const first = { ...journalTurnVector(1), seq: 1 };
  const prefix = Buffer.from(`${JSON.stringify(first)}\n`, 'utf8');
  const truncatedCharacter = Buffer.from('中', 'utf8').subarray(0, 2);
  const tail = Buffer.concat([Buffer.from('{"unconfirmed":"'), truncatedCharacter]);
  const directory = path.join(rootDirectory, 'unterminated');
  await fs.mkdir(directory);
  const bytes = Buffer.concat([prefix, tail]);
  const filename = path.join(directory, 'execution.jsonl');
  await fs.writeFile(filename, bytes, { mode: 0o600 });
  assert.deepEqual(await readExecutionJournal({ directory, sessionId }), { entries: [first], incompleteTail: true });
  await assert.rejects(openExecutionJournal({ directory, sessionId, ownerId }), hasCode('JOURNAL_INCOMPLETE_TAIL'));
  assert.deepEqual(await fs.readFile(filename), bytes);

  const corruptDirectory = path.join(rootDirectory, 'terminated');
  await fs.mkdir(corruptDirectory);
  const corruptBytes = Buffer.concat([prefix, tail, Buffer.from('"}\n')]);
  const corruptFilename = path.join(corruptDirectory, 'execution.jsonl');
  await fs.writeFile(corruptFilename, corruptBytes, { mode: 0o600 });
  await assert.rejects(readExecutionJournal({ directory: corruptDirectory, sessionId }), hasCode('JOURNAL_CORRUPT'));
  assert.deepEqual(await fs.readFile(corruptFilename), corruptBytes);
});

test('A2 leaf symlinks cannot redirect the journal or lock to another file', async (t) => {
  const rootDirectory = await directoryFor(t);
  const target = path.join(rootDirectory, 'unrelated-file');
  await fs.writeFile(target, 'UNCHANGED');
  for (const leaf of ['execution.jsonl', '.writer.lock']) {
    const directory = path.join(rootDirectory, leaf === '.writer.lock' ? 'lock-link' : 'log-link');
    await fs.mkdir(directory);
    await fs.symlink(target, path.join(directory, leaf));
    await assert.rejects(openExecutionJournal({ directory, sessionId, ownerId }), (error: unknown) => knownCodes.has((error as { code: string }).code));
    assert.equal(await fs.readFile(target, 'utf8'), 'UNCHANGED');
    assert.ok((await fs.lstat(path.join(directory, leaf))).isSymbolicLink());
    if (leaf === 'execution.jsonl') await assert.rejects(readExecutionJournal({ directory, sessionId }), (error: unknown) => knownCodes.has((error as { code: string }).code));
  }
});

test('A2 close never deletes a replaced writer lock belonging to another instance', async (t) => {
  const directory = await directoryFor(t);
  const journal = await openExecutionJournal({ directory, sessionId, ownerId });
  const filename = path.join(directory, '.writer.lock');
  const replacement = JSON.stringify({ ownerId: 'foreign-owner', sessionId, pid: process.pid, instanceId: 'foreign-instance' });
  await fs.writeFile(filename, replacement);
  await journal.close().catch((error: unknown) => { assert.ok(hasCode('JOURNAL_LOCKED')(error) || hasCode('JOURNAL_IO')(error)); });
  assert.equal(await fs.readFile(filename, 'utf8'), replacement);
});

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { openExecutionJournal, readExecutionJournal, type ExecutionJournalInput } from '../../src/runtime/execution-journal.js';
import type { Invocation, ModelCallBinding, TurnScope } from '../../src/runtime/contracts.js';
import { verifiedNodeExecutable } from '../fixtures/pi-integrity/approved-identity.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const sessionId = 'r2-session';
const ownerId = 'r2-qa';
let nextId = 0;
const scope: TurnScope = { sessionId, operationId: 'r2-operation', turnId: 'r2-turn', epoch: 1, stageId: 'r2-stage', budgetRef: 'r2-budget' };
const request = { model: 'offline-fixture', messages: [{ role: 'user', content: '中文🙂' }], max_tokens: 17 };
const requestHash = createHash('sha256').update(JSON.stringify(request), 'utf8').digest('hex');
const call: ModelCallBinding = { operationId: scope.operationId, stageId: scope.stageId, logicalCallId: 'logical-a', callId: 'call-a', missionId: 'mission-a', turnId: scope.turnId, epoch: 1, sessionId, providerProfileId: 'profile-a', modelId: 'offline-fixture', modelPurpose: 'answer', capabilitySnapshotId: 'snapshot-a', requestRevision: 1, requestSha256: requestHash };
const invocation: Invocation = { executionId: 'execution-a', toolCallId: 'tool-a', sessionId, operationId: scope.operationId, turnId: scope.turnId, epoch: 1, source: { serverId: 'server-a', toolName: 'write-a' }, argsSha256: 'a'.repeat(64), permissionScopeHash: 'b'.repeat(64) };
function common() { return { schemaVersion: 1 as const, eventId: `r2-event-${++nextId}`, sessionId, operationId: scope.operationId, turnId: scope.turnId, epoch: 1, at: '2026-09-21T00:00:00.000Z' }; }
function events(): ExecutionJournalInput[] {
  return [
    { ...common(), kind: 'model.prepared', call: structuredClone(call) },
    { ...common(), kind: 'model.dispatching', call: structuredClone(call) },
    { ...common(), kind: 'model.receipt', call: structuredClone(call), receipt: { callId: call.callId, status: 'succeeded', evidenceRef: 'fixture-evidence' } },
    { ...common(), kind: 'execution.model-bound', invocation: structuredClone(invocation), origin: { callId: call.callId, logicalCallId: call.logicalCallId } },
    { ...common(), kind: 'turn.completed', turn: structuredClone(scope) },
  ];
}
const code = (expected: string) => (error: unknown) => (error as { code?: string })?.code === expected;
const cast = (value: unknown) => value as ExecutionJournalInput;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
async function directoryFor(t: TestContext) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ma-r2-journal-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function withJournal(t: TestContext) {
  const directory = await directoryFor(t);
  const journal = await openExecutionJournal({ directory, sessionId, ownerId });
  t.after(() => journal.close());
  return { directory, journal };
}
async function filePrototype(directory: string): Promise<{ sync(this: FileHandle): Promise<void>; writeFile: FileHandle['writeFile'] }> {
  const handle = await fs.open(join(directory, 'qa-sync-probe'), 'wx');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  await fs.unlink(join(directory, 'qa-sync-probe'));
  return prototype;
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('R2 barrier timeout')), 8000); })]).finally(() => clearTimeout(timer));
}

test('R2a five new events roundtrip with every old schema-1 shape, retaining old bytes and no invented origin', async (t) => {
  const directory = await directoryFor(t);
  const old: ExecutionJournalInput[] = [
    { ...common(), kind: 'turn.registered', turn: structuredClone(scope) },
    { ...common(), kind: 'turn.revoked' },
    ...(['execution.prepared', 'execution.authorized', 'execution.dispatching'] as const).map(kind => ({ ...common(), kind, invocation: structuredClone(invocation) })),
    { ...common(), kind: 'execution.receipt', invocation: structuredClone(invocation), receipt: { executionId: invocation.executionId, source: invocation.source, status: 'failed', stopConfirmed: false } },
  ];
  const oldEntries = old.map((event, index) => ({ ...event, seq: index + 1 }));
  const oldBytes = Buffer.concat(oldEntries.map(encode));
  await fs.writeFile(join(directory, 'execution.jsonl'), oldBytes, { mode: 0o600 });
  const journal = await openExecutionJournal({ directory, sessionId, ownerId });
  const expected = [...oldEntries];
  for (const event of events()) expected.push(await journal.append(event));
  await journal.close();
  const bytes = await fs.readFile(join(directory, 'execution.jsonl'));
  assert.deepEqual(bytes.subarray(0, oldBytes.length), oldBytes);
  assert.deepEqual(await readExecutionJournal({ directory, sessionId }), { entries: expected, incompleteTail: false });
  assert.equal('origin' in expected[4], false);
  const reopened = await openExecutionJournal({ directory, sessionId, ownerId: 'r2-successor' });
  assert.equal((await reopened.append(events()[0])).seq, 12);
  await reopened.close();
});

test('R2a records four model purposes/statuses, bounded IDs and native JSON request hashes without canonicalization', async (t) => {
  const { journal } = await withJournal(t);
  const reordered = { max_tokens: request.max_tokens, messages: request.messages, model: request.model };
  const secondHash = createHash('sha256').update(JSON.stringify(reordered), 'utf8').digest('hex');
  assert.notEqual(requestHash, secondHash, 'native property order is part of final supplier request bytes');
  const purposes = ['answer', 'tool_loop', 'compaction', 'branch_summary'] as const;
  const statuses = ['succeeded', 'failed', 'not_sent', 'unknown'] as const;
  for (let index = 0; index < purposes.length; index++) {
    const binding = { ...call, modelPurpose: purposes[index], requestRevision: Number.MAX_SAFE_INTEGER, callId: 'c'.repeat(128), logicalCallId: 'l'.repeat(128), requestSha256: index % 2 ? secondHash : requestHash };
    const event = { ...common(), kind: 'model.receipt' as const, call: binding, receipt: { callId: binding.callId, status: statuses[index], evidenceRef: 'e'.repeat(128) } };
    assert.deepEqual(await journal.append(event), { ...event, seq: index + 1 });
  }
  const raw = JSON.stringify(await journal.read());
  assert.equal(raw.includes('中文'), false, 'raw supplier messages do not belong in this journal');
  assert.equal(raw.includes('max_tokens'), false);
});

test('R2a rejects missing, inherited, accessor, hidden, symbol and unknown fields at every new event object boundary', async (t) => {
  const { directory, journal } = await withJournal(t);
  let getterCalls = 0;
  for (const original of events()) {
    const objectPaths = [[], ...(original.kind.startsWith('model.') ? [['call']] : []), ...(original.kind === 'model.receipt' ? [['receipt']] : []), ...(original.kind === 'execution.model-bound' ? [['invocation'], ['invocation', 'source'], ['origin']] : []), ...(original.kind === 'turn.completed' ? [['turn']] : [])];
    for (const objectPath of objectPaths) {
      const targetOf = (value: any) => objectPath.reduce((current, key) => current[key], value);
      const base = targetOf(original);
      const optional = objectPath[0] === 'call' ? ['missionId'] : objectPath[0] === 'receipt' ? ['evidenceRef'] : [];
      for (const key of Object.keys(base).filter(key => !optional.includes(key))) {
        for (const variant of ['missing', 'getter', 'hidden', 'inherited'] as const) {
          const bad = structuredClone(original); const target = targetOf(bad); const value = target[key]; delete target[key];
          if (variant === 'getter') Object.defineProperty(target, key, { enumerable: true, get() { getterCalls++; return value; } });
          if (variant === 'hidden') Object.defineProperty(target, key, { enumerable: false, value });
          if (variant === 'inherited') Object.setPrototypeOf(target, { [key]: value });
          await assert.rejects(journal.append(bad), code('JOURNAL_INVALID_EVENT'), `${original.kind}/${objectPath.join('.')}/${key}/${variant}`);
        }
      }
      for (const key of ['apiKey', '__proto__', Symbol('unknown')]) {
        const bad = structuredClone(original);
        Object.defineProperty(targetOf(bad), key, { enumerable: true, value: 'DO_NOT_PERSIST_R2_SECRET' });
        await assert.rejects(journal.append(bad), code('JOURNAL_INVALID_EVENT'));
      }
    }
  }
  assert.equal(getterCalls, 0);
  assert.equal(await fs.readFile(join(directory, 'execution.jsonl'), 'utf8'), '');
});

test('R2a Object.prototype cannot supply required fields; inherited optional fields are ignored without executing getters', async (t) => {
  const { journal } = await withJournal(t);
  for (const key of Object.keys(call).filter(key => key !== 'missionId')) {
    const bad = events()[0] as Extract<ExecutionJournalInput, { kind: 'model.prepared' | 'model.dispatching' }>;
    const value = (bad.call as any)[key]; delete (bad.call as any)[key];
    assert.equal(Object.hasOwn(Object.prototype, key), false);
    Object.defineProperty(Object.prototype, key, { configurable: true, value });
    try { await assert.rejects(journal.append(bad), code('JOURNAL_INVALID_EVENT'), key); }
    finally { delete (Object.prototype as any)[key]; }
  }
  let reads = 0;
  const event = events()[2] as Extract<ExecutionJournalInput, { kind: 'model.receipt' }>;
  delete event.call.missionId; delete event.receipt.evidenceRef;
  for (const key of ['missionId', 'evidenceRef']) Object.defineProperty(Object.prototype, key, { configurable: true, get() { reads++; return 'inherited-untrusted'; } });
  try {
    const result = await journal.append(event);
    assert.equal(Object.hasOwn((result as typeof event).call, 'missionId'), false);
    assert.equal(Object.hasOwn((result as typeof event).receipt, 'evidenceRef'), false);
    assert.equal(reads, 0);
  } finally { delete (Object.prototype as any).missionId; delete (Object.prototype as any).evidenceRef; }
});

test('R2a rejects every nested scope mismatch, receipt call substitution and malformed model/origin values before disk', async (t) => {
  const { journal, directory } = await withJournal(t);
  const invalid: unknown[] = [];
  for (const original of events()) {
    const field = 'call' in original ? 'call' : 'invocation' in original ? 'invocation' : 'turn';
    for (const key of ['sessionId', 'operationId', 'turnId', 'epoch']) {
      const bad = structuredClone(original) as any; bad[field][key] = key === 'epoch' ? 2 : 'foreign'; invalid.push(bad);
    }
  }
  for (const key of Object.keys(call)) {
    const badValues = key === 'epoch' || key === 'requestRevision' ? [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']
      : key === 'requestSha256' ? ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]
      : key === 'modelPurpose' ? ['warmup', 'accepted', null] : ['', ' ', 'x'.repeat(129), null, 1];
    for (const value of badValues) invalid.push({ ...events()[0], call: { ...call, [key]: value } });
  }
  for (const receipt of [{ callId: 'other', status: 'succeeded' }, { callId: call.callId, status: 'cancelled' }, { callId: call.callId, status: 'unknown', evidenceRef: undefined }, { callId: call.callId, status: 'failed', evidenceRef: '' }]) invalid.push({ ...events()[2], receipt });
  for (const key of ['callId', 'logicalCallId']) for (const value of ['', 'x'.repeat(129), undefined]) invalid.push({ ...events()[3], origin: { callId: call.callId, logicalCallId: call.logicalCallId, [key]: value } });
  for (const field of ['signal', 'request', 'response', 'token', 'supplierCost']) invalid.push({ ...events()[0], call: { ...call, [field]: 'DO_NOT_PERSIST_R2_SECRET' } });
  for (const bad of invalid) await assert.rejects(journal.append(cast(bad)), code('JOURNAL_INVALID_EVENT'));
  assert.equal(await fs.readFile(join(directory, 'execution.jsonl'), 'utf8'), '');
});

test('R2a snapshots newly added nested values synchronously and returned mutations cannot rewrite durable bytes', async (t) => {
  const { journal } = await withJournal(t);
  for (const original of events()) {
    const expected = structuredClone(original);
    const pending = journal.append(original);
    if ('call' in original) original.call.callId = 'MUTATED';
    if ('origin' in original) original.origin.callId = 'MUTATED';
    if ('turn' in original) original.turn.budgetRef = 'MUTATED';
    if ('receipt' in original) original.receipt.evidenceRef = 'MUTATED';
    const result = await pending;
    assert.deepEqual(result, { ...expected, seq: result.seq });
    if ('call' in result) result.call.requestSha256 = 'f'.repeat(64);
    if ('origin' in result) result.origin.callId = 'RETURN_MUTATED';
    const readback = (await journal.read()).entries.at(-1)!;
    assert.deepEqual(readback, { ...expected, seq: result.seq });
  }
});

test('R2a all five new events settle only after the actual log FileHandle.sync returns', async (t) => {
  const { directory, journal } = await withJournal(t);
  const prototype = await filePrototype(directory); const original = prototype.sync;
  const logInode = (await fs.stat(join(directory, 'execution.jsonl'))).ino;
  try {
    for (const event of events()) {
      const entered = deferred(); const release = deferred(); let realSyncs = 0; let settled = false;
      prototype.sync = async function () {
        assert.equal((await this.stat()).ino, logInode);
        entered.resolve(); await release.promise; await original.call(this); realSyncs++;
      };
      const pending = journal.append(event).finally(() => { settled = true; });
      await bounded(entered.promise); await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false); assert.equal(realSyncs, 0);
      release.resolve(); await pending;
      assert.equal(realSyncs, 1); assert.equal(settled, true);
      prototype.sync = original;
    }
  } finally { prototype.sync = original; }
});

test('R2a actual log sync EIO rejects new-model append and permanently fences the instance even if bytes are readable', async (t) => {
  const { directory, journal } = await withJournal(t);
  const prototype = await filePrototype(directory); const original = prototype.sync;
  const baseline = await journal.append(events()[0]);
  let injected = 0;
  prototype.sync = async function () { injected++; throw Object.assign(new Error('R2 sync EIO'), { code: 'EIO' }); };
  try { await assert.rejects(journal.append(events()[1]), code('JOURNAL_IO')); }
  finally { prototype.sync = original; }
  assert.equal(injected, 1);
  const bytes = await fs.readFile(join(directory, 'execution.jsonl'));
  const diagnosis = await readExecutionJournal({ directory, sessionId });
  assert.deepEqual(diagnosis.entries[0], baseline);
  assert.equal(diagnosis.entries.length, 2, 'complete visible bytes after EIO are diagnostic, not a successful append receipt');
  await assert.rejects(journal.append(events()[4]), code('JOURNAL_IO'));
  assert.deepEqual(await fs.readFile(join(directory, 'execution.jsonl')), bytes);
});

test('R2a partial real write followed by EIO preserves only the confirmed new-event prefix and never repairs the tail', async (t) => {
  const { directory, journal } = await withJournal(t);
  const first = await journal.append(events()[0]);
  const prototype = await filePrototype(directory); const original = prototype.writeFile;
  prototype.writeFile = async function (this: FileHandle, data: any) {
    const bytes = Buffer.from(data); await this.write(bytes.subarray(0, 37));
    throw Object.assign(new Error('R2 partial write EIO'), { code: 'EIO' });
  };
  try { await assert.rejects(journal.append(events()[1]), code('JOURNAL_IO')); }
  finally { prototype.writeFile = original; }
  const raw = await fs.readFile(join(directory, 'execution.jsonl'));
  assert.deepEqual(await readExecutionJournal({ directory, sessionId }), { entries: [first], incompleteTail: true });
  await journal.close();
  await assert.rejects(openExecutionJournal({ directory, sessionId, ownerId }), code('JOURNAL_INCOMPLETE_TAIL'));
  assert.deepEqual(await fs.readFile(join(directory, 'execution.jsonl')), raw);
});

test('R2a truncated new-event UTF-8 preserves prefix, while terminated corruption or identity substitution is fatal', async (t) => {
  const root = await directoryFor(t);
  const first = { ...events()[0], seq: 1 }; const next = { ...events()[2], seq: 2 };
  const partial = Buffer.concat([Buffer.from('{"call":"'), Buffer.from('🙂').subarray(0, 3)]);
  const cases: Array<{ bytes: Buffer; error: string }> = [
    { bytes: Buffer.concat([encode(first), partial]), error: 'JOURNAL_INCOMPLETE_TAIL' },
    { bytes: Buffer.concat([encode(first), Buffer.from(JSON.stringify(next))]), error: 'JOURNAL_INCOMPLETE_TAIL' },
    { bytes: Buffer.concat([encode(first), partial, Buffer.from('"}\n')]), error: 'JOURNAL_CORRUPT' },
    { bytes: Buffer.concat([encode(first), encode({ ...next, receipt: { callId: 'unrelated', status: 'succeeded' } })]), error: 'JOURNAL_CORRUPT' },
    { bytes: Buffer.concat([encode(first), Buffer.from('{broken}\n'), encode(next)]), error: 'JOURNAL_CORRUPT' },
    { bytes: Buffer.concat([encode(first), encode({ ...next, call: { ...call, sessionId: 'foreign' } })]), error: 'JOURNAL_CORRUPT' },
    { bytes: Buffer.concat([encode(first), encode({ ...next, call: { ...call, signal: {} } })]), error: 'JOURNAL_CORRUPT' },
  ];
  for (const [index, item] of cases.entries()) {
    const directory = join(root, String(index)); await fs.mkdir(directory);
    const filename = join(directory, 'execution.jsonl'); await fs.writeFile(filename, item.bytes);
    if (item.error === 'JOURNAL_INCOMPLETE_TAIL') assert.deepEqual(await readExecutionJournal({ directory, sessionId }), { entries: [first], incompleteTail: true });
    else await assert.rejects(readExecutionJournal({ directory, sessionId }), code('JOURNAL_CORRUPT'));
    await assert.rejects(openExecutionJournal({ directory, sessionId, ownerId }), code(item.error));
    assert.deepEqual(await fs.readFile(filename), item.bytes);
  }
});

test('R2a read/open options reject inherited or accessor identity and prototype replacement before filesystem access', async (t) => {
  const directory = await directoryFor(t); let getters = 0;
  for (const factory of [readExecutionJournal, openExecutionJournal]) {
    const valid = { directory, sessionId, ownerId };
    for (const key of factory === openExecutionJournal ? ['directory', 'sessionId', 'ownerId'] : ['directory', 'sessionId']) {
      const value = valid[key as keyof typeof valid]; const missing = { ...valid } as any; delete missing[key];
      Object.defineProperty(Object.prototype, key, { configurable: true, value });
      try { await assert.rejects(factory(missing), code('JOURNAL_INVALID_EVENT')); }
      finally { delete (Object.prototype as any)[key]; }
      const accessor = { ...valid }; Object.defineProperty(accessor, key, { enumerable: true, get() { getters++; return value; } });
      await assert.rejects(factory(accessor), code('JOURNAL_INVALID_EVENT'));
    }
    await assert.rejects(factory(Object.assign(Object.create({ polluted: true }), valid)), code('JOURNAL_INVALID_EVENT'));
  }
  assert.equal(getters, 0);
  assert.deepEqual(await fs.readdir(directory), []);
});

async function childSetup(t: TestContext) {
  const node = await verifiedNodeExecutable(); const scratch = await directoryFor(t);
  const out = join(scratch, 'compiled'); await fs.mkdir(out);
  const compiled = spawnSync(node, [join(repository, 'node_modules/typescript/bin/tsc'), '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--types', 'node', '--rootDir', join(repository, 'src/runtime'), '--outDir', out, join(repository, 'src/runtime/execution-journal.ts')], { cwd: repository, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(compiled.status, 0, compiled.stderr + compiled.stdout);
  await fs.writeFile(join(out, 'package.json'), '{"type":"module"}');
  await fs.copyFile(join(repository, 'test/runtime/fixtures/r2-journal-child.mjs'), join(out, 'child.mjs'));
  const directory = join(scratch, 'journal'); await fs.mkdir(directory);
  const deniedDirectory = await directoryFor(t); const sentinel = join(deniedDirectory, 'personal-sentinel'); await fs.writeFile(sentinel, 'MUST_NOT_READ');
  return { node, out, scratch, directory, sentinel };
}
function spawnChild(t: TestContext, config: Awaited<ReturnType<typeof childSetup>>, mode: 'read' | 'kill-before-sync') {
  // Node22 disables fchmod under its Permission Model. The coordinator approved
  // a narrow path guard for this writer fixture; it is not an OS sandbox claim.
  const permissions = mode === 'read' ? ['--permission', `--allow-fs-read=${config.scratch}`, `--allow-fs-write=${config.scratch}`] : [];
  const child = spawn(config.node, [...permissions, join(config.out, 'child.mjs'), JSON.stringify({ directory: config.directory, scratch: config.scratch, sessionId, ownerId, mode, sentinel: config.sentinel, event: events()[1] })], { cwd: config.scratch, env: { PATH: '/usr/bin:/bin', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } });
  return child;
}
function childMessage(child: ChildProcess): Promise<any> {
  return bounded(new Promise((resolve, reject) => {
    let stderr = ''; child.stderr?.on('data', data => { stderr += String(data); });
    child.once('message', resolve); child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`R2 child exited ${code}/${signal}: ${stderr}`)));
  }));
}

test('R2a a permission-confined real Node process reads mixed durable events with no network or personal resource access', async (t) => {
  const config = await childSetup(t);
  const journal = await openExecutionJournal({ directory: config.directory, sessionId, ownerId });
  const expected = [];
  expected.push(await journal.append({ ...common(), kind: 'execution.dispatching', invocation: structuredClone(invocation) }));
  for (const event of events()) expected.push(await journal.append(event));
  await journal.close();
  const child = spawnChild(t, config, 'read'); const message = await childMessage(child);
  assert.equal(message.pid, child.pid); assert.notEqual(message.pid, process.pid);
  assert.equal(message.version, 'v22.23.2'); assert.equal(message.sentinelCode, 'ERR_ACCESS_DENIED'); assert.equal(message.networkCalls, 0);
  assert.deepEqual(message.result, { entries: expected, incompleteTail: false });
  const [exitCode] = await once(child, 'exit'); assert.equal(exitCode, 0);
});

test('R2a SIGKILL at the actual new-model fsync boundary yields no append success and retains the unknown writer lock', async (t) => {
  const config = await childSetup(t); const child = spawnChild(t, config, 'kill-before-sync');
  const message = await childMessage(child);
  assert.equal(message.kind, 'before-log-sync'); assert.equal(message.successReceipts, 0); assert.equal(message.networkCalls, 0);
  assert.equal(message.sentinelCode, 'R2_FS_SCOPE_DENIED');
  assert.equal(message.guardMode, 'observed-owned-paths');
  const lock = await fs.readFile(join(config.directory, '.writer.lock'));
  const bytes = await fs.readFile(join(config.directory, 'execution.jsonl'));
  assert.equal(bytes.length > 0, true, 'write really reached the file before the sync barrier');
  const exit = once(child, 'exit'); child.kill('SIGKILL'); assert.equal((await exit)[1], 'SIGKILL');
  const diagnosis = await readExecutionJournal({ directory: config.directory, sessionId });
  assert.equal(diagnosis.entries.length, 1); assert.equal(diagnosis.entries[0].kind, 'model.dispatching');
  await assert.rejects(openExecutionJournal({ directory: config.directory, sessionId, ownerId: 'successor' }), code('JOURNAL_LOCKED'));
  assert.deepEqual(await fs.readFile(join(config.directory, '.writer.lock')), lock);
  assert.deepEqual(await fs.readFile(join(config.directory, 'execution.jsonl')), bytes);
});

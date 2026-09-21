import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import { createTurnGate, type DispatchPermit } from '../../src/runtime/turn-gate.js';
import { openExecutionJournal, type ExecutionJournal, type ExecutionJournalInput } from '../../src/runtime/execution-journal.js';
import type { Invocation, TurnScope, ToolReceipt } from '../../src/runtime/contracts.js';

// Local, independent vectors: a permit certifies durable intent, never permission or remote stop.
// I clarified Q3's first-run error ambiguities: a safe but old epoch is a lifecycle
// conflict; registration before stop is durable must be rejected then explicitly
// retried; journal failures keep TURN_JOURNAL_FAILED on subsequent calls. These
// mappings preserve the same no-new-permit and no-erased-unknown execution gates.
const sessionId = 'session-a';
const turnA: TurnScope = {
  sessionId, turnId: 'turn-a', epoch: 7,
  operationId: 'operation-a', stageId: 'stage-a', budgetRef: 'budget-a',
};
function turnB(): TurnScope { return { ...turnA, turnId: 'turn-b', epoch: 8, stageId: 'stage-b' }; }
function invocation(index = 1, turn = turnA): Invocation {
  return {
    executionId: `execution-${index}`, toolCallId: `pi-tool-${index}`,
    sessionId: turn.sessionId, operationId: turn.operationId, turnId: turn.turnId, epoch: turn.epoch,
    source: { serverId: 'server-a', toolName: 'tool-a' },
    argsSha256: 'a'.repeat(64), permissionScopeHash: 'b'.repeat(64),
  };
}
function baseEvent(index: number, turn = turnA) {
  return {
    schemaVersion: 1 as const, eventId: `event-${index}`, sessionId: turn.sessionId,
    operationId: turn.operationId, turnId: turn.turnId, epoch: turn.epoch,
    at: '2026-09-21T00:00:00.000Z',
  };
}
function receiptEvent(index: number, call: Invocation, status: ToolReceipt['status'], stopConfirmed = false): ExecutionJournalInput {
  return {
    ...baseEvent(index, { ...turnA, ...call }), kind: 'execution.receipt', invocation: call,
    receipt: {
      executionId: call.executionId, source: { ...call.source }, status, stopConfirmed,
      resultRef: 'result-a', evidenceRef: 'evidence-a',
    },
  };
}
const hasCode = (code: string) => (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === code;
const settled = <T>(promise: Promise<T>) => promise.then(
  (value) => ({ ok: true as const, value }),
  (error: unknown) => ({ ok: false as const, error }),
);
function waitBounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000); }),
  ]).finally(() => clearTimeout(timer));
}

async function journalFor(t: TestContext): Promise<{ directory: string; journal: ExecutionJournal }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ma-next-turn-'));
  const journal = await openExecutionJournal({ directory, sessionId, ownerId: 'q-turn-owner' });
  t.after(async () => {
    await journal.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, journal };
}
async function gateFor(t: TestContext) {
  const fixture = await journalFor(t);
  return { ...fixture, gate: await createTurnGate({ sessionId, journal: fixture.journal }) };
}

async function patchableSync(directory: string) {
  const filename = path.join(directory, 'sync-probe');
  const handle = await fs.open(filename, 'wx', 0o600);
  const prototype = Object.getPrototypeOf(handle) as { sync(this: FileHandle): Promise<void> };
  await handle.close();
  await fs.unlink(filename);
  return prototype;
}
async function syncBarrier(directory: string) {
  const prototype = await patchableSync(directory);
  const original = prototype.sync;
  let release!: () => void;
  let reached!: () => void;
  let first = true;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  prototype.sync = async function () {
    if (first) { first = false; reached(); await held; }
    await original.call(this);
  };
  return {
    entered: () => waitBounded(entered, 'real fsync barrier'),
    release,
    restore: () => { release(); prototype.sync = original; },
  };
}
async function failOneSync(directory: string) {
  const prototype = await patchableSync(directory);
  const original = prototype.sync;
  let failed = false;
  prototype.sync = async function () {
    if (!failed) { failed = true; throw Object.assign(new Error('test-only durable write failure'), { code: 'EIO' }); }
    await original.call(this);
  };
  return () => { prototype.sync = original; };
}

test('A3 fresh gate awaits a real journal and exposes isolated snapshots', async (t) => {
  assert.equal(process.version, 'v22.23.2');
  const { gate, journal } = await gateFor(t);
  assert.deepEqual(gate.snapshot(), { sessionId, state: 'ready', currentTurn: null, lastEpoch: 0, inFlightExecutionIds: [] });
  await gate.register({ ...turnA });
  const snapshot = gate.snapshot();
  assert.deepEqual(snapshot, { sessionId, state: 'active', currentTurn: turnA, lastEpoch: 7, inFlightExecutionIds: [] });
  snapshot.currentTurn!.operationId = 'caller-mutated';
  snapshot.inFlightExecutionIds.push('caller-invented');
  snapshot.lastEpoch = 1000;
  snapshot.state = 'paused';
  assert.deepEqual(gate.snapshot(), { sessionId, state: 'active', currentTurn: turnA, lastEpoch: 7, inFlightExecutionIds: [] });
  const records = (await journal.read()).entries;
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, 'turn.registered');
  assert.equal(records[0]!.epoch, 7);
});

test('A3 repeated identical active registration is durable-idempotent; conflicting registration is rejected', async (t) => {
  const { gate, journal } = await gateFor(t);
  await gate.register({ ...turnA });
  await Promise.all([gate.register({ ...turnA }), gate.register({ ...turnA })]);
  for (const candidate of [turnB(), { ...turnA, stageId: 'other-stage' }, { ...turnA, epoch: 8 }]) {
    await assert.rejects(gate.register(candidate), hasCode('TURN_CONFLICT'));
  }
  assert.equal((await journal.read()).entries.length, 1);
  assert.deepEqual(gate.snapshot().currentTurn, turnA);
});

test('A3 registration rejects malformed scope without creating a journal record', async (t) => {
  const { gate, journal } = await gateFor(t);
  const invalid: unknown[] = [null, [], { ...turnA, sessionId: 'foreign-session' }, { ...turnA, apiKey: 'DO_NOT_PERSIST_SECRET_A' }];
  for (const key of Object.keys(turnA)) {
    const missing = { ...turnA } as Record<string, unknown>;
    delete missing[key];
    invalid.push(missing);
  }
  for (const key of ['sessionId', 'turnId', 'operationId', 'stageId', 'budgetRef']) {
    for (const value of ['', ' ', 'a'.repeat(129)]) invalid.push({ ...turnA, [key]: value });
  }
  for (const epoch of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7']) invalid.push({ ...turnA, epoch });
  for (const value of invalid) await assert.rejects(gate.register(value as TurnScope), hasCode('TURN_INVALID_SCOPE'));
  assert.equal((await journal.read()).entries.length, 0);
  assert.equal(gate.snapshot().state, 'ready');
  await gate.register({ ...turnA });
});

test('A3 dispatch validates every identity, source and hash before journaling', async (t) => {
  const { gate, journal } = await gateFor(t);
  await gate.register({ ...turnA });
  const call = invocation();
  const invalid: unknown[] = [null, [], { ...call, arguments: { secret: 'DO_NOT_PERSIST_SECRET_A' } }];
  for (const key of Object.keys(call)) {
    const missing = { ...call } as Record<string, unknown>;
    delete missing[key];
    invalid.push(missing);
  }
  for (const key of ['sessionId', 'operationId', 'turnId']) invalid.push({ ...call, [key]: 'foreign' });
  for (const epoch of [0, 6, 8, NaN, Infinity]) invalid.push({ ...call, epoch });
  for (const key of ['executionId', 'toolCallId']) {
    for (const value of ['', 'x'.repeat(129)]) invalid.push({ ...call, [key]: value });
  }
  for (const key of ['argsSha256', 'permissionScopeHash']) {
    for (const hash of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) invalid.push({ ...call, [key]: hash });
  }
  invalid.push({ ...call, source: { serverId: '', toolName: 'tool-a' } });
  invalid.push({ ...call, source: { serverId: 'server-a', toolName: '' } });
  invalid.push({ ...call, source: { ...call.source, authorization: 'model-says-yes' } });
  for (const value of invalid) await assert.rejects(gate.markDispatching(value as Invocation), hasCode('TURN_INVALID_SCOPE'));
  assert.equal((await journal.read()).entries.length, 1);
  assert.deepEqual(gate.snapshot().inFlightExecutionIds, []);
});

test('A3 permit appears only after real fsync and matches the immutable dispatch record', async (t) => {
  const { gate, journal, directory } = await gateFor(t);
  await gate.register({ ...turnA });
  const call = invocation();
  const before = structuredClone(call);
  const barrier = await syncBarrier(directory);
  try {
    let done = false;
    const pending = gate.markDispatching(call).finally(() => { done = true; });
    await barrier.entered();
    await nextImmediate();
    assert.equal(done, false);
    call.executionId = 'mutated-execution';
    call.source.serverId = 'mutated-source';
    barrier.release();
    const permit: DispatchPermit = await pending;
    assert.deepEqual(permit, { sessionId, turnId: 'turn-a', epoch: 7, executionId: 'execution-1', journalSeq: 2 });
    const record = (await journal.read()).entries[1]!;
    assert.equal(record.kind, 'execution.dispatching');
    if (record.kind === 'execution.dispatching') assert.deepEqual(record.invocation, before);
    assert.deepEqual(gate.snapshot().inFlightExecutionIds, ['execution-1']);
  } finally { barrier.restore(); }
});

test('A3 duplicate execution identity never yields a second permit or dispatch record', async (t) => {
  const { gate, journal } = await gateFor(t);
  await gate.register({ ...turnA });
  const first = await gate.markDispatching(invocation());
  await assert.rejects(gate.markDispatching(invocation()), hasCode('TURN_DUPLICATE_EXECUTION'));
  await assert.rejects(gate.markDispatching({ ...invocation(), toolCallId: 'other-pi-id' }), hasCode('TURN_DUPLICATE_EXECUTION'));
  assert.equal((await journal.read()).entries.filter((entry) => entry.kind === 'execution.dispatching').length, 1);
  assert.deepEqual(gate.snapshot().inFlightExecutionIds, [first.executionId]);
});

test('A3 stop preserves issued in-flight work, is idempotent, and resumes only the same operation budget', async (t) => {
  const { gate, journal } = await gateFor(t);
  await gate.register({ ...turnA });
  await gate.markDispatching(invocation());
  const stopped = await gate.stop('turn-a');
  assert.deepEqual(stopped, { revokedEpoch: 7, inFlightExecutionIds: ['execution-1'] });
  const before = (await journal.read()).entries.length;
  assert.deepEqual(await gate.stop('turn-a'), stopped);
  assert.equal((await journal.read()).entries.length, before);
  await assert.rejects(gate.stop('unknown-turn'), hasCode('TURN_NOT_FOUND'));
  await assert.rejects(gate.register({ ...turnA, epoch: 8 }), hasCode('TURN_REVOKED'));
  for (const candidate of [{ ...turnB(), operationId: 'other-operation' }, { ...turnB(), budgetRef: 'new-budget' }]) {
    await assert.rejects(gate.register(candidate), hasCode('TURN_INVALID_SCOPE'));
  }
  for (const epoch of [6, 7]) await assert.rejects(gate.register({ ...turnB(), epoch }), hasCode('TURN_CONFLICT'));
  await gate.register(turnB());
  await assert.rejects(gate.markDispatching(invocation(1, turnB())), hasCode('TURN_DUPLICATE_EXECUTION'));
  const newPermit = await gate.markDispatching(invocation(2, turnB()));
  assert.equal(newPermit.turnId, 'turn-b');
  assert.equal(newPermit.epoch, 8);
  assert.deepEqual(gate.snapshot().inFlightExecutionIds, ['execution-1', 'execution-2']);
  assert.deepEqual(gate.snapshot().currentTurn, turnB());
  assert.equal(gate.snapshot().lastEpoch, 8);
  assert.deepEqual(await gate.stop('turn-a'), stopped, 'old stop retry must not cancel the new Turn');
  assert.deepEqual(gate.snapshot().currentTurn, turnB());
});

test('A3 stop during dispatch fsync denies unsigned and queued permits but retains the entered dispatch', async (t) => {
  const { gate, journal, directory } = await gateFor(t);
  await gate.register({ ...turnA });
  const barrier = await syncBarrier(directory);
  try {
    const first = settled(gate.markDispatching(invocation(1)));
    await barrier.entered();
    const queued = settled(gate.markDispatching(invocation(2)));
    const stop = settled(gate.stop('turn-a'));
    const afterStop = settled(gate.markDispatching(invocation(3)));
    barrier.release();
    const outcomes = await waitBounded(Promise.all([first, queued, afterStop]), 'stop dispatch race');
    for (const outcome of outcomes) {
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.ok(hasCode('TURN_REVOKED')(outcome.error));
    }
    const stopResult = await stop;
    assert.equal(stopResult.ok, true);
    if (stopResult.ok) assert.deepEqual(stopResult.value, { revokedEpoch: 7, inFlightExecutionIds: ['execution-1'] });
    const entries = (await journal.read()).entries;
    assert.deepEqual(entries.map((entry) => entry.kind), ['turn.registered', 'execution.dispatching', 'turn.revoked']);
    assert.deepEqual(gate.snapshot().inFlightExecutionIds, ['execution-1']);
    await gate.register(turnB());
    await gate.markDispatching(invocation(4, turnB()));
    assert.deepEqual(gate.snapshot().inFlightExecutionIds, ['execution-1', 'execution-4']);
  } finally { barrier.restore(); }
});

test('A3 stop received while registration fsync is pending is not lost', async (t) => {
  const { gate, journal, directory } = await gateFor(t);
  const barrier = await syncBarrier(directory);
  try {
    const registering = settled(gate.register({ ...turnA }));
    await barrier.entered();
    const stopping = settled(gate.stop('turn-a'));
    const dispatching = settled(gate.markDispatching(invocation()));
    barrier.release();
    const result = await waitBounded(registering, 'pending registration cancellation');
    if (!result.ok) assert.ok(hasCode('TURN_REVOKED')(result.error));
    const stopped = await stopping;
    assert.equal(stopped.ok, true);
    if (stopped.ok) assert.deepEqual(stopped.value, { revokedEpoch: 7, inFlightExecutionIds: [] });
    const dispatch = await dispatching;
    assert.equal(dispatch.ok, false);
    if (!dispatch.ok) assert.ok(hasCode('TURN_REVOKED')(dispatch.error));
    assert.deepEqual((await journal.read()).entries.map((entry) => entry.kind), ['turn.registered', 'turn.revoked']);
    assert.notEqual(gate.snapshot().state, 'active');
    await gate.register(turnB());
    assert.equal(gate.snapshot().currentTurn!.turnId, 'turn-b');
  } finally { barrier.restore(); }
});

test('A3 new registration is rejected until prior stop is durable, then an explicit retry succeeds', async (t) => {
  const { gate, journal, directory } = await gateFor(t);
  await gate.register({ ...turnA });
  const barrier = await syncBarrier(directory);
  try {
    const stopping = gate.stop('turn-a');
    await barrier.entered();
    const next = await waitBounded(settled(gate.register(turnB())), 'early registration rejection');
    assert.equal(next.ok, false);
    if (!next.ok) assert.ok(hasCode('TURN_CONFLICT')(next.error));
    await assert.rejects(gate.markDispatching(invocation(2, turnB())), hasCode('TURN_INVALID_SCOPE'));
    assert.notEqual(gate.snapshot().currentTurn?.turnId, 'turn-b');
    assert.ok(!(await fs.readFile(path.join(directory, 'execution.jsonl'), 'utf8')).includes('turn-b'));
    barrier.release();
    await waitBounded(stopping, 'durable stop');
    await gate.register(turnB());
    assert.deepEqual((await journal.read()).entries.map((entry) => entry.kind), ['turn.registered', 'turn.revoked', 'turn.registered']);
    assert.deepEqual(gate.snapshot().currentTurn, turnB());
  } finally { barrier.restore(); }
});

for (const phase of ['register', 'dispatch', 'stop'] as const) {
  test(`A3 ${phase} fsync failure pauses the gate and prevents further registration or permits`, async (t) => {
    const { gate, journal, directory } = await gateFor(t);
    if (phase !== 'register') await gate.register({ ...turnA });
    if (phase === 'stop') await gate.markDispatching(invocation());
    const restore = await failOneSync(directory);
    try {
      const failing = phase === 'register' ? gate.register({ ...turnA })
        : phase === 'dispatch' ? gate.markDispatching(invocation()) : gate.stop('turn-a');
      await assert.rejects(failing, hasCode('TURN_JOURNAL_FAILED'));
    } finally { restore(); }
    assert.equal(gate.snapshot().state, 'paused');
    if (phase !== 'register') assert.deepEqual(gate.snapshot().inFlightExecutionIds, ['execution-1']);
    const before = await fs.readFile(path.join(directory, 'execution.jsonl'));
    await assert.rejects(gate.register(turnB()), hasCode('TURN_JOURNAL_FAILED'));
    await assert.rejects(gate.markDispatching(invocation(2)), hasCode('TURN_JOURNAL_FAILED'));
    assert.deepEqual(await fs.readFile(path.join(directory, 'execution.jsonl')), before);
    // Closing the real failed journal is cleanup; no fake successful journal is substituted.
    await journal.close();
  });
}

test('A3 constructor read failure returns an observable paused gate with journal-failure errors', async (t) => {
  const { journal, directory } = await journalFor(t);
  await fs.writeFile(path.join(directory, 'execution.jsonl'), '{broken}\n');
  const gate = await createTurnGate({ sessionId, journal });
  assert.equal(gate.snapshot().state, 'paused');
  await assert.rejects(gate.register({ ...turnA }), hasCode('TURN_JOURNAL_FAILED'));
  await assert.rejects(gate.markDispatching(invocation()), hasCode('TURN_JOURNAL_FAILED'));
});

test('A3 constructor awaits the actual queued read and returns recovery-required for existing records', async (t) => {
  const { journal, directory } = await journalFor(t);
  const barrier = await syncBarrier(directory);
  try {
    const write = journal.append({ ...baseEvent(1), kind: 'turn.registered', turn: { ...turnA } });
    await barrier.entered();
    let factorySettled = false;
    const creating = createTurnGate({ sessionId, journal }).finally(() => { factorySettled = true; });
    await nextImmediate();
    assert.equal(factorySettled, false);
    barrier.release();
    await write;
    const gate = await creating;
    assert.equal(gate.snapshot().state, 'paused');
    assert.equal(gate.snapshot().lastEpoch, 7);
    await assert.rejects(gate.register(turnB()), hasCode('TURN_RECOVERY_REQUIRED'));
    await assert.rejects(gate.markDispatching(invocation()), hasCode('TURN_RECOVERY_REQUIRED'));
  } finally { barrier.restore(); }
});

test('A3 recovery keeps unknown execution even with stopConfirmed and clears a matching known diagnostic failure', async (t) => {
  const { journal } = await journalFor(t);
  const known = invocation(1);
  const unknown = invocation(2);
  await journal.append({ ...baseEvent(1), kind: 'turn.registered', turn: { ...turnA } });
  await journal.append({ ...baseEvent(2), kind: 'execution.dispatching', invocation: known });
  await journal.append({ ...baseEvent(3), kind: 'execution.dispatching', invocation: unknown });
  await journal.append(receiptEvent(4, known, 'failed', false));
  await journal.append(receiptEvent(5, unknown, 'unknown', true));
  const later = { ...turnB(), epoch: 12 };
  await journal.append({ ...baseEvent(6, later), kind: 'turn.registered', turn: later });
  const gate = await createTurnGate({ sessionId, journal });
  assert.equal(gate.snapshot().state, 'paused');
  assert.equal(gate.snapshot().lastEpoch, 12);
  assert.deepEqual(gate.snapshot().inFlightExecutionIds, ['execution-2']);
  await assert.rejects(gate.register({ ...later, epoch: 13 }), hasCode('TURN_RECOVERY_REQUIRED'));
  await assert.rejects(gate.markDispatching(invocation(3, later)), hasCode('TURN_RECOVERY_REQUIRED'));
});

test('A3 an unrelated successful receipt cannot erase a dispatch with the same executionId', async (t) => {
  const original = invocation(1);
  const mismatches = [
    { ...original, toolCallId: 'different-pi-call' },
    { ...original, source: { ...original.source, serverId: 'different-server' } },
    { ...original, source: { ...original.source, toolName: 'different-tool' } },
    { ...original, argsSha256: 'c'.repeat(64) },
    { ...original, permissionScopeHash: 'd'.repeat(64) },
    { ...original, turnId: 'different-turn', epoch: 8 },
    { ...original, operationId: 'different-operation' },
  ];
  for (const changed of mismatches) {
    const { journal } = await journalFor(t);
    await journal.append({ ...baseEvent(1), kind: 'execution.dispatching', invocation: original });
    await journal.append(receiptEvent(2, changed, 'succeeded', false));
    const gate = await createTurnGate({ sessionId, journal });
    assert.equal(gate.snapshot().state, 'paused');
    assert.deepEqual(gate.snapshot().inFlightExecutionIds, ['execution-1']);
  }
});

test('A3 epoch exhaustion pauses rather than accepting an unsafe or recycled epoch', async (t) => {
  const { gate, journal } = await gateFor(t);
  const last = { ...turnA, epoch: Number.MAX_SAFE_INTEGER };
  await gate.register(last);
  await gate.stop(last.turnId);
  const count = (await journal.read()).entries.length;
  await assert.rejects(gate.register({ ...turnB(), epoch: Number.MAX_SAFE_INTEGER + 1 }), hasCode('TURN_PAUSED'));
  assert.equal(gate.snapshot().state, 'paused');
  assert.equal(gate.snapshot().lastEpoch, Number.MAX_SAFE_INTEGER);
  assert.equal((await journal.read()).entries.length, count);
});

test('A3 concurrent factories share one gate so stop through either handle fences both', async (t) => {
  const { journal } = await journalFor(t);
  const [first, second] = await Promise.all([
    createTurnGate({ sessionId, journal }),
    createTurnGate({ sessionId, journal }),
  ]);
  await first.register({ ...turnA });
  await second.register({ ...turnA });
  await first.stop('turn-a');
  await assert.rejects(second.markDispatching(invocation()), hasCode('TURN_REVOKED'));
  const entries = (await journal.read()).entries;
  assert.deepEqual(entries.map((entry) => entry.kind), ['turn.registered', 'turn.revoked']);
  assert.equal(entries.some((entry) => entry.kind === 'execution.dispatching'), false);
  assert.equal(first, second, 'same journal object and session must not create independent gates');
});

test('A3 factory identity is reserved before awaiting journal read and conflicting sessions are rejected', async (t) => {
  const { journal, directory } = await journalFor(t);
  const barrier = await syncBarrier(directory);
  try {
    const write = journal.append({ ...baseEvent(1), kind: 'turn.registered', turn: { ...turnA } });
    await barrier.entered();
    const first = createTurnGate({ sessionId, journal });
    const second = createTurnGate({ sessionId, journal });
    const conflict = settled(createTurnGate({ sessionId: 'conflicting-session', journal }));
    const conflictResult = await waitBounded(conflict, 'factory identity reservation before read');
    assert.equal(conflictResult.ok, false);
    if (!conflictResult.ok) assert.ok(hasCode('TURN_INVALID_SCOPE')(conflictResult.error));
    barrier.release();
    await write;
    const [firstGate, secondGate] = await Promise.all([first, second]);
    assert.equal(firstGate, secondGate);
    assert.equal(firstGate.snapshot().state, 'paused');
    await assert.rejects(createTurnGate({ sessionId: 'conflicting-session', journal }), hasCode('TURN_INVALID_SCOPE'));
  } finally { barrier.restore(); }
});

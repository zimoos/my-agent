import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import { createTurnGate, type TurnGate } from '../../src/runtime/turn-gate.js';
import { openExecutionJournal, type ExecutionJournal, type ExecutionJournalInput } from '../../src/runtime/execution-journal.js';
import type { TurnScope, ModelCallBinding, ModelCallReceipt, Invocation, ToolReceipt } from '../../src/runtime/contracts.js';

const sessionId = 'r2b-session';
const turn: TurnScope = { sessionId, turnId: 'turn-1', epoch: 1, operationId: 'operation-1', stageId: 'stage-1', budgetRef: 'budget-1' };
const nextTurn = (epoch = 2): TurnScope => ({ ...turn, turnId: `turn-${epoch}`, epoch, stageId: `stage-${epoch}` });
function model(index = 1, scope = turn): ModelCallBinding {
  return { sessionId: scope.sessionId, operationId: scope.operationId, turnId: scope.turnId, epoch: scope.epoch, stageId: scope.stageId, logicalCallId: `logical-${index}`, callId: `call-${index}`, providerProfileId: 'profile-fixture', modelId: 'offline-fixture', modelPurpose: 'answer', capabilitySnapshotId: 'capabilities-fixture', requestRevision: 1, requestSha256: 'a'.repeat(64) };
}
function invocation(index = 1, scope = turn): Invocation {
  return { executionId: `execution-${index}`, toolCallId: `tool-${index}`, sessionId: scope.sessionId, operationId: scope.operationId, turnId: scope.turnId, epoch: scope.epoch, source: { serverId: 'server-fixture', toolName: 'tool-fixture' }, argsSha256: 'b'.repeat(64), permissionScopeHash: 'c'.repeat(64) };
}
const origin = (call: ModelCallBinding) => ({ callId: call.callId, logicalCallId: call.logicalCallId });
const modelReceipt = (call: ModelCallBinding, status: ModelCallReceipt['status'], evidenceRef?: string): ModelCallReceipt => ({ callId: call.callId, status, ...(evidenceRef ? { evidenceRef } : {}) });
const toolReceipt = (call: Invocation, status: ToolReceipt['status'], evidenceRef?: string): ToolReceipt => ({ executionId: call.executionId, source: { ...call.source }, status, stopConfirmed: false, ...(evidenceRef ? { evidenceRef } : {}) });
const code = (value: string) => (error: unknown) => (error as { code?: string })?.code === value;
const settled = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
function requireRejected(result: Awaited<ReturnType<typeof settled>>, expected: string) {
  assert.equal(result.ok, false, `expected ${expected}, got ${JSON.stringify(result)}`);
  if (!result.ok) assert.ok(code(expected)(result.error), String(result.error));
}
function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('R2b barrier timeout')), 8000); })]).finally(() => clearTimeout(timer));
}
async function fixture(t: TestContext, register = true) {
  assert.equal(process.version, 'v22.23.2');
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ma-r2b-gate-')));
  const journal = await openExecutionJournal({ directory, sessionId, ownerId: 'r2b-qa' });
  t.after(async () => { await journal.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const gate = await createTurnGate({ sessionId, journal });
  if (register) await gate.register({ ...turn });
  return { directory, journal, gate };
}
async function syncControl(directory: string, failure = false) {
  const probe = await fs.open(join(directory, 'execution.jsonl'), 'r'); const ino = (await probe.stat()).ino;
  const prototype = Object.getPrototypeOf(probe) as { sync(this: FileHandle): Promise<void> }; await probe.close();
  const original = prototype.sync; let release!: () => void; let enter!: () => void; let first = true;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  prototype.sync = async function () {
    if (first && (await this.stat()).ino === ino) { first = false; enter(); if (failure) throw Object.assign(new Error('R2b real sync EIO'), { code: 'EIO' }); await held; }
    await original.call(this);
  };
  return { entered: () => bounded(entered), release, restore() { release(); prototype.sync = original; } };
}
async function successfulModel(gate: TurnGate, call = model()) {
  await gate.prepareModel(call); await gate.markModelDispatching(call.callId); await gate.recordModelReceipt(call.callId, modelReceipt(call, 'succeeded')); return call;
}
async function boundTool(gate: TurnGate, call = invocation(), parent = model()) {
  await successfulModel(gate, parent); await gate.bindInvocation(call, origin(parent)); return call;
}
const kinds = async (journal: ExecutionJournal) => (await journal.read()).entries.map(entry => entry.kind);

test('R2b pending unknown model receipt rejects a different terminal receipt until the first is durable', async t => {
  const { gate, journal, directory } = await fixture(t); const call = model();
  await gate.prepareModel(call); await gate.markModelDispatching(call.callId);
  const barrier = await syncControl(directory);
  try {
    const unknown = gate.recordModelReceipt(call.callId, modelReceipt(call, 'unknown'));
    await barrier.entered();
    const concurrent = settled(gate.recordModelReceipt(call.callId, modelReceipt(call, 'succeeded', 'later-confirmation')));
    barrier.release(); await unknown;
    requireRejected(await concurrent, 'TURN_RECEIPT_CONFLICT');
    assert.deepEqual(gate.snapshot().inFlightCallIds, [call.callId]);
    assert.equal((await kinds(journal)).filter(kind => kind === 'model.receipt').length, 1);
    await gate.recordModelReceipt(call.callId, modelReceipt(call, 'succeeded', 'later-confirmation'));
    assert.deepEqual(gate.snapshot().inFlightCallIds, []);
  } finally { barrier.restore(); }
});

test('R2b pending unknown tool receipt rejects a different terminal receipt until the first is durable', async t => {
  const { gate, journal, directory } = await fixture(t); const call = await boundTool(gate); await gate.markDispatching(call);
  const barrier = await syncControl(directory);
  try {
    const unknown = gate.recordReceipt(call, toolReceipt(call, 'unknown'));
    await barrier.entered();
    const concurrent = settled(gate.recordReceipt(call, toolReceipt(call, 'failed', 'compile-failure-confirmed')));
    barrier.release(); await unknown;
    requireRejected(await concurrent, 'TURN_RECEIPT_CONFLICT');
    assert.deepEqual(gate.snapshot().inFlightExecutionIds, [call.executionId]);
    assert.equal((await kinds(journal)).filter(kind => kind === 'execution.receipt').length, 1);
    await gate.recordReceipt(call, toolReceipt(call, 'failed', 'compile-failure-confirmed'));
    await gate.complete(turn.turnId);
  } finally { barrier.restore(); }
});

test('R2b unknown observed during another model dispatch fsync prevents that final permit and retains both attempts', async t => {
  const { gate, journal, directory } = await fixture(t); const first = model(1); const second = model(2);
  await gate.prepareModel(first); await gate.prepareModel(second); await gate.markModelDispatching(first.callId);
  const barrier = await syncControl(directory);
  try {
    const dispatch = settled(gate.markModelDispatching(second.callId)); await barrier.entered();
    const unknown = gate.recordModelReceipt(first.callId, modelReceipt(first, 'unknown'));
    barrier.release();
    requireRejected(await dispatch, 'TURN_MODEL_UNRESOLVED'); await unknown;
    assert.deepEqual(gate.snapshot().inFlightCallIds, [first.callId, second.callId]);
    assert.equal((await kinds(journal)).filter(kind => kind === 'model.dispatching').length, 2);
  } finally { barrier.restore(); }
});

test('R2b queued cancellation never persists an orphan not_sent receipt without its durable prepared fact', async t => {
  const { gate, journal, directory } = await fixture(t, false); const call = model();
  const barrier = await syncControl(directory);
  try {
    const registration = settled(gate.register(turn)); await barrier.entered();
    const prepared = settled(gate.prepareModel(call));
    const receipt = settled(gate.recordModelReceipt(call.callId, modelReceipt(call, 'not_sent')));
    const stopped = gate.stop(turn.turnId);
    barrier.release(); await registration; await prepared; const result = await receipt; await stopped;
    const rows = (await journal.read()).entries;
    const prep = rows.findIndex(entry => entry.kind === 'model.prepared' && entry.call.callId === call.callId);
    const rec = rows.findIndex(entry => entry.kind === 'model.receipt' && entry.call.callId === call.callId);
    if (result.ok) assert.ok(prep >= 0 && rec > prep, 'successful not_sent receipt must follow its actual durable prepared event');
    if (prep < 0) { assert.equal(result.ok, false); assert.equal(rec, -1, 'orphan receipt was persisted'); }
    assert.equal(rows.some(entry => entry.kind === 'model.dispatching'), false);
  } finally { barrier.restore(); }
});

test('R2b normal model-tool failure closes durably and permits a new Host operation without changing historical identity', async t => {
  const { gate, journal } = await fixture(t); const call = await boundTool(gate); const permit = await gate.markDispatching(call);
  await gate.recordReceipt(call, toolReceipt(call, 'failed'));
  const completion = await gate.complete(turn.turnId);
  assert.deepEqual(completion, { sessionId, turnId: turn.turnId, epoch: 1, journalSeq: 8 });
  assert.equal(permit.journalSeq, 6); assert.equal(gate.snapshot().state, 'ready');
  assert.equal(gate.snapshot().currentTurn, null); assert.deepEqual(gate.snapshot().inFlightExecutionIds, []);
  assert.deepEqual(await kinds(journal), ['turn.registered', 'model.prepared', 'model.dispatching', 'model.receipt', 'execution.model-bound', 'execution.dispatching', 'execution.receipt', 'turn.completed']);
  const next = { ...nextTurn(), operationId: 'operation-new', budgetRef: 'budget-new' }; await gate.register(next);
  completion.journalSeq = 1000; assert.equal((await gate.complete(turn.turnId)).journalSeq, 8);
  assert.deepEqual(gate.snapshot().currentTurn, next);
  await assert.rejects(gate.register({ ...turn, epoch: 3, operationId: next.operationId, budgetRef: next.budgetRef }), code('TURN_COMPLETED'));
  await assert.rejects(gate.prepareModel(model(9)), code('TURN_COMPLETED'));
});

test('R2b prepared attempts only close as not_sent and preserve distinct IDs for the same logical intent', async t => {
  const { gate, journal } = await fixture(t); const first = model(); const second = { ...model(2), logicalCallId: first.logicalCallId, requestRevision: 2 };
  const preparing = gate.prepareModel(first);
  await assert.rejects(gate.prepareModel(structuredClone(first)), code('TURN_DUPLICATE_CALL')); await preparing;
  await gate.prepareModel(second);
  for (const status of ['succeeded', 'failed', 'unknown'] as const) await assert.rejects(gate.recordModelReceipt(first.callId, modelReceipt(first, status, 'untrusted-status')), code('TURN_RECEIPT_CONFLICT'));
  await gate.recordModelReceipt(first.callId, modelReceipt(first, 'not_sent')); await gate.recordModelReceipt(second.callId, modelReceipt(second, 'not_sent'));
  await assert.rejects(gate.markModelDispatching(first.callId), code('TURN_RECEIPT_CONFLICT'));
  await assert.rejects(gate.recordModelReceipt('missing', modelReceipt(first, 'not_sent')), code('TURN_UNKNOWN_CALL'));
  await gate.complete(turn.turnId);
  assert.equal((await kinds(journal)).includes('model.dispatching'), false);
});

test('R2b current normal model calls may run in parallel; explicit unknown blocks new attempts until same-call evidence', async t => {
  const { gate } = await fixture(t); const calls = [model(1), model(2), model(3)];
  for (const call of calls) await gate.prepareModel(call);
  await Promise.all(calls.slice(0, 2).map(call => gate.markModelDispatching(call.callId)));
  assert.deepEqual(gate.snapshot().inFlightCallIds, ['call-1', 'call-2']);
  await gate.recordModelReceipt('call-1', modelReceipt(calls[0], 'unknown'));
  await assert.rejects(gate.markModelDispatching('call-3'), code('TURN_MODEL_UNRESOLVED'));
  await gate.recordModelReceipt('call-2', modelReceipt(calls[1], 'succeeded'));
  await assert.rejects(gate.markModelDispatching('call-3'), code('TURN_MODEL_UNRESOLVED'));
  await assert.rejects(gate.recordModelReceipt('call-1', modelReceipt(calls[0], 'failed')), code('TURN_RECEIPT_CONFLICT'));
  await gate.recordModelReceipt('call-1', modelReceipt(calls[0], 'failed', 'verified-ended'));
  await gate.markModelDispatching('call-3'); await gate.recordModelReceipt('call-3', modelReceipt(calls[2], 'succeeded')); await gate.complete(turn.turnId);
});

test('R2b binding requires a succeeded exact model origin and reserves both execution ID and source tuple', async t => {
  const { gate, journal } = await fixture(t); const call = model(); const tool = invocation();
  await assert.rejects(gate.markDispatching(tool), code('TURN_ORIGIN_MISMATCH'));
  await gate.prepareModel(call); await gate.markModelDispatching(call.callId);
  await assert.rejects(gate.bindInvocation(tool, origin(call)), code('TURN_ORIGIN_MISMATCH'));
  await gate.recordModelReceipt(call.callId, modelReceipt(call, 'succeeded'));
  for (const wrong of [{ ...origin(call), callId: 'other' }, { ...origin(call), logicalCallId: 'other' }]) await assert.rejects(gate.bindInvocation(tool, wrong), code('TURN_ORIGIN_MISMATCH'));
  await gate.bindInvocation(tool, origin(call)); const count = (await kinds(journal)).length;
  await gate.bindInvocation(structuredClone(tool), origin(call)); assert.equal((await kinds(journal)).length, count);
  await assert.rejects(gate.bindInvocation({ ...tool, executionId: 'other-execution' }, origin(call)), code('TURN_ORIGIN_MISMATCH'));
  for (const changed of [{ ...tool, argsSha256: 'd'.repeat(64) }, { ...tool, source: { ...tool.source, toolName: 'other' } }, { ...tool, toolCallId: 'other' }]) await assert.rejects(gate.bindInvocation(changed, origin(call)), code('TURN_ORIGIN_MISMATCH'));
  const otherModel = await successfulModel(gate, model(2)); await assert.rejects(gate.bindInvocation(tool, origin(otherModel)), code('TURN_ORIGIN_MISMATCH'));
  await gate.markDispatching(tool); await assert.rejects(gate.markDispatching(tool), code('TURN_DUPLICATE_EXECUTION'));
});

test('R2b complete rejects prepared, model in-flight/unknown and even undispatched bound tools until exact terminal receipts', async t => {
  const { gate, journal } = await fixture(t); const call = model(); const tool = invocation();
  const rejectComplete = async () => { const count = (await kinds(journal)).length; await assert.rejects(gate.complete(turn.turnId), code('TURN_UNRESOLVED')); assert.equal(gate.snapshot().state, 'active'); assert.equal((await kinds(journal)).length, count); };
  await gate.prepareModel(call); await rejectComplete(); await gate.markModelDispatching(call.callId); await rejectComplete();
  await gate.recordModelReceipt(call.callId, modelReceipt(call, 'unknown')); await rejectComplete();
  await gate.recordModelReceipt(call.callId, modelReceipt(call, 'succeeded', 'confirmed')); await gate.bindInvocation(tool, origin(call)); await rejectComplete();
  await gate.markDispatching(tool); await rejectComplete(); await gate.recordReceipt(tool, toolReceipt(tool, 'unknown')); await rejectComplete();
  await assert.rejects(gate.recordReceipt(tool, toolReceipt(tool, 'failed')), code('TURN_RECEIPT_CONFLICT'));
  await gate.recordReceipt(tool, toolReceipt(tool, 'failed', 'confirmed-compiler-error')); await gate.complete(turn.turnId);
  assert.equal(gate.snapshot().state, 'ready');
});

test('R2b dispatching not_sent requires evidence and confirmed model terminal values are immutable and idempotent', async t => {
  const { gate, journal } = await fixture(t); const call = model(); await gate.prepareModel(call); await gate.markModelDispatching(call.callId);
  await assert.rejects(gate.recordModelReceipt(call.callId, modelReceipt(call, 'not_sent')), code('TURN_RECEIPT_CONFLICT'));
  await assert.rejects(gate.recordModelReceipt(call.callId, { callId: 'other', status: 'failed' }), code('TURN_RECEIPT_CONFLICT'));
  const receipt = modelReceipt(call, 'not_sent', 'transport-confirmed-unsent'); await gate.recordModelReceipt(call.callId, receipt);
  const count = (await kinds(journal)).length; await gate.recordModelReceipt(call.callId, structuredClone(receipt)); assert.equal((await kinds(journal)).length, count);
  for (const next of [modelReceipt(call, 'succeeded', 'different'), { ...receipt, evidenceRef: 'changed' }]) await assert.rejects(gate.recordModelReceipt(call.callId, next), code('TURN_RECEIPT_CONFLICT'));
  await gate.complete(turn.turnId);
});

test('R2b ordinary tool terminal outcomes close without stopConfirmed, while unrelated success cannot clear unknown', async t => {
  for (const status of ['succeeded', 'failed', 'denied', 'cancelled_not_sent'] as const) {
    const { gate } = await fixture(t); const tool = await boundTool(gate); await gate.markDispatching(tool);
    await gate.recordReceipt(tool, toolReceipt(tool, 'unknown'));
    await assert.rejects(gate.recordReceipt({ ...tool, argsSha256: 'd'.repeat(64) }, toolReceipt(tool, 'succeeded', 'wrong')), code('TURN_ORIGIN_MISMATCH'));
    await assert.rejects(gate.recordReceipt(tool, { ...toolReceipt(tool, 'succeeded'), source: { ...tool.source, serverId: 'wrong' } }), code('TURN_RECEIPT_CONFLICT'));
    assert.deepEqual(gate.snapshot().inFlightExecutionIds, [tool.executionId]);
    const receipt = toolReceipt(tool, status, 'verified-local-fact'); await gate.recordReceipt(tool, receipt); await gate.recordReceipt(tool, structuredClone(receipt));
    await assert.rejects(gate.recordReceipt(tool, { ...receipt, status: 'unknown' }), code('TURN_RECEIPT_CONFLICT'));
    await gate.complete(turn.turnId); assert.equal(gate.snapshot().state, 'ready');
  }
});

test('R2b model receipt confirmation and identical pending replay remain in-flight until real fsync', async t => {
  const { gate, journal, directory } = await fixture(t); const call = model(); await gate.prepareModel(call); await gate.markModelDispatching(call.callId);
  const barrier = await syncControl(directory);
  try {
    const receipt = modelReceipt(call, 'succeeded'); let done = false;
    const first = gate.recordModelReceipt(call.callId, receipt).finally(() => { done = true; }); await barrier.entered();
    const same = gate.recordModelReceipt(call.callId, { ...receipt });
    await assert.rejects(gate.recordModelReceipt(call.callId, modelReceipt(call, 'failed')), code('TURN_RECEIPT_CONFLICT'));
    assert.equal(done, false); assert.deepEqual(gate.snapshot().inFlightCallIds, [call.callId]);
    await assert.rejects(gate.bindInvocation(invocation(), origin(call)), code('TURN_ORIGIN_MISMATCH'));
    await assert.rejects(gate.complete(turn.turnId), code('TURN_UNRESOLVED'));
    receipt.callId = 'mutated'; barrier.release(); await Promise.all([first, same]);
    assert.deepEqual(gate.snapshot().inFlightCallIds, []); assert.equal((await kinds(journal)).filter(kind => kind === 'model.receipt').length, 1);
  } finally { barrier.restore(); }
});

test('R2b bind and tool receipt are durable prerequisites, with no permit before origin fsync or terminal receipt completion', async t => {
  const { gate, journal, directory } = await fixture(t); const call = await successfulModel(gate); const tool = invocation();
  const bindingBarrier = await syncControl(directory);
  try {
    const binding = gate.bindInvocation(tool, origin(call)); await bindingBarrier.entered();
    await assert.rejects(gate.markDispatching(tool), code('TURN_ORIGIN_MISMATCH'));
    await assert.rejects(gate.complete(turn.turnId), code('TURN_UNRESOLVED'));
    bindingBarrier.release(); await binding;
  } finally { bindingBarrier.restore(); }
  await gate.markDispatching(tool); const barrier = await syncControl(directory);
  try {
    const receipt = toolReceipt(tool, 'failed'); const first = gate.recordReceipt(tool, receipt); await barrier.entered();
    const same = gate.recordReceipt(tool, structuredClone(receipt));
    await assert.rejects(gate.recordReceipt(tool, toolReceipt(tool, 'succeeded')), code('TURN_RECEIPT_CONFLICT'));
    assert.deepEqual(gate.snapshot().inFlightExecutionIds, [tool.executionId]);
    await assert.rejects(gate.complete(turn.turnId), code('TURN_UNRESOLVED'));
    barrier.release(); await Promise.all([first, same]); await gate.complete(turn.turnId);
    assert.equal((await kinds(journal)).filter(kind => kind === 'execution.receipt').length, 1);
  } finally { barrier.restore(); }
});

test('R2b stop during model dispatch fsync denies entered and queued permits without inventing not_sent evidence', async t => {
  const { gate, journal, directory } = await fixture(t); const first = model(1); const second = model(2);
  await gate.prepareModel(first); await gate.prepareModel(second); const barrier = await syncControl(directory);
  try {
    const dispatched = settled(gate.markModelDispatching(first.callId)); await barrier.entered();
    const queued = settled(gate.markModelDispatching(second.callId)); const stopped = gate.stop(turn.turnId);
    await assert.rejects(gate.complete(turn.turnId), code('TURN_REVOKED'));
    barrier.release(); requireRejected(await dispatched, 'TURN_REVOKED'); requireRejected(await queued, 'TURN_REVOKED'); await stopped;
    assert.deepEqual(gate.snapshot().inFlightCallIds, [first.callId]);
    await assert.rejects(gate.recordModelReceipt(first.callId, modelReceipt(first, 'not_sent')), code('TURN_RECEIPT_CONFLICT'));
    await gate.recordModelReceipt(second.callId, modelReceipt(second, 'not_sent'));
    await gate.register(nextTurn()); const third = model(3, nextTurn()); await gate.prepareModel(third);
    await assert.rejects(gate.markModelDispatching(third.callId), code('TURN_MODEL_UNRESOLVED'));
    await gate.recordModelReceipt(first.callId, modelReceipt(first, 'failed', 'confirmed-old-request-ended'));
    await gate.markModelDispatching(third.callId);
    const rows = (await journal.read()).entries; assert.equal(rows.filter(row => row.kind === 'model.dispatching' && row.call.callId === second.callId).length, 0);
  } finally { barrier.restore(); }
});

test('R2b late receipts retain old Turn ownership and a stopped Turn cannot reset operation or budget', async t => {
  const { gate, journal } = await fixture(t); const tool = await boundTool(gate); await gate.markDispatching(tool); await gate.stop(turn.turnId);
  await assert.rejects(gate.register({ ...nextTurn(), operationId: 'new-operation' }), code('TURN_INVALID_SCOPE'));
  await assert.rejects(gate.register({ ...nextTurn(), budgetRef: 'new-budget' }), code('TURN_INVALID_SCOPE'));
  await gate.register(nextTurn()); await assert.rejects(gate.complete(nextTurn().turnId), code('TURN_UNRESOLVED'));
  await gate.recordReceipt(tool, toolReceipt(tool, 'failed')); const last = (await journal.read()).entries.at(-1)!;
  assert.equal(last.turnId, turn.turnId); assert.equal(last.epoch, turn.epoch); assert.deepEqual(gate.snapshot().currentTurn, nextTurn());
  await gate.complete(nextTurn().turnId); await assert.rejects(gate.prepareModel(model()), code('TURN_REVOKED'));
});

test('R2b complete owns its synchronous fence and becomes ready only after actual fsync; cached result never touches the next Turn', async t => {
  const { gate, journal, directory } = await fixture(t); const barrier = await syncControl(directory);
  try {
    let done = false; const first = gate.complete(turn.turnId).finally(() => { done = true; }); await barrier.entered();
    const same = gate.complete(turn.turnId);
    await assert.rejects(gate.stop(turn.turnId), code('TURN_CONFLICT'));
    await assert.rejects(gate.prepareModel(model()), code('TURN_COMPLETED'));
    await assert.rejects(gate.bindInvocation(invocation(), origin(model())), code('TURN_COMPLETED'));
    await assert.rejects(gate.markDispatching(invocation()), code('TURN_COMPLETED'));
    await assert.rejects(gate.register(nextTurn()), code('TURN_CONFLICT'));
    assert.equal(done, false); assert.equal(gate.snapshot().state, 'active'); assert.deepEqual(gate.snapshot().currentTurn, turn);
    barrier.release(); const [a, b] = await Promise.all([first, same]); assert.deepEqual(a, b); assert.notEqual(a, b);
    a.journalSeq = 999; assert.equal((await gate.complete(turn.turnId)).journalSeq, 2);
    await gate.register({ ...nextTurn(), operationId: 'fresh-operation', budgetRef: 'fresh-budget' });
    await gate.complete(turn.turnId); assert.equal(gate.snapshot().currentTurn!.turnId, nextTurn().turnId);
    assert.equal((await kinds(journal)).filter(kind => kind === 'turn.completed').length, 1);
  } finally { barrier.restore(); }
});

test('R2b stop wins before complete and pending registration is serialized before a valid normal completion', async t => {
  const first = await fixture(t); const stopped = first.gate.stop(turn.turnId);
  await assert.rejects(first.gate.complete(turn.turnId), code('TURN_REVOKED')); await stopped;
  assert.equal((await kinds(first.journal)).includes('turn.completed'), false);
  const { gate, journal, directory } = await fixture(t, false); const barrier = await syncControl(directory);
  try {
    const registration = gate.register(turn); await barrier.entered(); const completion = gate.complete(turn.turnId);
    await assert.rejects(gate.prepareModel(model()), code('TURN_COMPLETED'));
    barrier.release(); await registration; await completion;
    assert.deepEqual(await kinds(journal), ['turn.registered', 'turn.completed']);
  } finally { barrier.restore(); }
});

test('R2b an accepted pending prepare blocks completion synchronously and can later close as not_sent', async t => {
  const { gate, journal, directory } = await fixture(t); const call = model(); const barrier = await syncControl(directory);
  try {
    const prepared = gate.prepareModel(call); await barrier.entered();
    await assert.rejects(gate.complete(turn.turnId), code('TURN_UNRESOLVED'));
    const receipt = gate.recordModelReceipt(call.callId, modelReceipt(call, 'not_sent'));
    barrier.release(); await prepared; await receipt; await gate.complete(turn.turnId);
    assert.deepEqual(await kinds(journal), ['turn.registered', 'model.prepared', 'model.receipt', 'turn.completed']);
  } finally { barrier.restore(); }
});

for (const phase of ['prepare', 'model-dispatch', 'model-receipt', 'bind', 'tool-receipt', 'complete'] as const) {
  test(`R2b ${phase} sync failure pauses and rejects all future new methods without clearing unresolved facts`, async t => {
    const { gate, journal, directory } = await fixture(t); const call = model(); const tool = invocation();
    if (phase === 'model-dispatch' || phase === 'model-receipt') await gate.prepareModel(call);
    if (phase === 'model-receipt') await gate.markModelDispatching(call.callId);
    if (phase === 'bind') await successfulModel(gate, call);
    if (phase === 'tool-receipt') { await boundTool(gate, tool, call); await gate.markDispatching(tool); }
    const control = await syncControl(directory, true);
    try {
      const work = phase === 'prepare' ? gate.prepareModel(call) : phase === 'model-dispatch' ? gate.markModelDispatching(call.callId)
        : phase === 'model-receipt' ? gate.recordModelReceipt(call.callId, modelReceipt(call, 'succeeded'))
        : phase === 'bind' ? gate.bindInvocation(tool, origin(call)) : phase === 'tool-receipt' ? gate.recordReceipt(tool, toolReceipt(tool, 'failed')) : gate.complete(turn.turnId);
      await assert.rejects(work, code('TURN_JOURNAL_FAILED'));
    } finally { control.restore(); }
    assert.equal(gate.snapshot().state, 'paused'); assert.deepEqual(gate.snapshot().currentTurn, turn);
    if (phase === 'model-dispatch' || phase === 'model-receipt') assert.deepEqual(gate.snapshot().inFlightCallIds, [call.callId]);
    if (phase === 'tool-receipt') assert.deepEqual(gate.snapshot().inFlightExecutionIds, [tool.executionId]);
    const bytes = await fs.readFile(join(directory, 'execution.jsonl'));
    for (const action of [() => gate.prepareModel(model(2)), () => gate.markModelDispatching('unknown'), () => gate.recordModelReceipt(call.callId, modelReceipt(call, 'not_sent')), () => gate.bindInvocation(tool, origin(call)), () => gate.recordReceipt(tool, toolReceipt(tool, 'failed')), () => gate.complete(turn.turnId), () => gate.register(nextTurn())]) await assert.rejects(action(), code('TURN_JOURNAL_FAILED'));
    assert.deepEqual(await fs.readFile(join(directory, 'execution.jsonl')), bytes);
    await journal.close();
  });
}

test('R2b all public object arguments reject missing, inherited, getter, hidden and unknown fields before accepting work', async t => {
  const { gate, journal } = await fixture(t); const call = model(); const tool = invocation(); let getterReads = 0;
  async function check(value: object, run: (bad: any) => Promise<unknown>, optional: string[] = []) {
    for (const key of Object.keys(value).filter(key => !optional.includes(key))) {
      for (const variant of ['missing', 'getter', 'hidden', 'prototype']) {
        const bad = structuredClone(value) as any; const original = bad[key]; delete bad[key];
        if (variant === 'getter') Object.defineProperty(bad, key, { enumerable: true, get() { getterReads++; return original; } });
        if (variant === 'hidden') Object.defineProperty(bad, key, { value: original, enumerable: false });
        if (variant === 'prototype') Object.setPrototypeOf(bad, { [key]: original });
        await assert.rejects(run(bad), code('TURN_INVALID_SCOPE'), `${key}/${variant}`);
      }
      const polluted = structuredClone(value) as any; const original = polluted[key]; delete polluted[key];
      assert.equal(Object.hasOwn(Object.prototype, key), false);
      Object.defineProperty(Object.prototype, key, { configurable: true, writable: true, value: original });
      try { await assert.rejects(run(polluted), code('TURN_INVALID_SCOPE'), `${key}/Object.prototype`); }
      finally { delete (Object.prototype as any)[key]; }
    }
    for (const key of ['apiKey', '__proto__', Symbol('unknown')]) {
      const bad = structuredClone(value); Object.defineProperty(bad, key, { enumerable: true, value: 'UNTRUSTED' });
      await assert.rejects(run(bad), code('TURN_INVALID_SCOPE'));
    }
  }
  await check(turn, bad => gate.register(bad)); await check(call, bad => gate.prepareModel(bad));
  await check(tool, bad => gate.markDispatching(bad)); await check(tool, bad => gate.bindInvocation(bad, origin(call)));
  await check(tool.source, bad => gate.markDispatching({ ...tool, source: bad }));
  await check(modelReceipt(call, 'not_sent'), bad => gate.recordModelReceipt(call.callId, bad));
  await check(origin(call), bad => gate.bindInvocation(tool, bad));
  await check(toolReceipt(tool, 'failed'), bad => gate.recordReceipt(tool, bad));
  await check(tool.source, bad => gate.recordReceipt(tool, { ...toolReceipt(tool, 'failed'), source: bad }));
  // The borrowed journal is not cloneable; build only malformed factory option wrappers.
  for (const key of ['sessionId', 'journal']) {
    const options: any = { sessionId, journal }; const original = options[key]; delete options[key];
    Object.defineProperty(Object.prototype, key, { configurable: true, writable: true, value: original });
    try { await assert.rejects(createTurnGate(options), code('TURN_INVALID_SCOPE')); }
    finally { delete (Object.prototype as any)[key]; }
    const getter: any = { sessionId, journal }; Object.defineProperty(getter, key, { enumerable: true, get() { getterReads++; return original; } });
    await assert.rejects(createTurnGate(getter), code('TURN_INVALID_SCOPE'));
  }
  assert.equal(getterReads, 0); assert.deepEqual(await kinds(journal), ['turn.registered']);
});

test('R2b model scope, stage, revision and hash are validated and unknown public IDs do not create facts', async t => {
  const { gate, journal } = await fixture(t);
  for (const key of ['sessionId', 'operationId', 'turnId', 'stageId']) await assert.rejects(gate.prepareModel({ ...model(), [key]: 'wrong' }), code('TURN_INVALID_SCOPE'));
  for (const key of ['epoch', 'requestRevision']) for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(gate.prepareModel({ ...model(), [key]: value }), code('TURN_INVALID_SCOPE'));
  for (const hash of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) await assert.rejects(gate.prepareModel({ ...model(), requestSha256: hash }), code('TURN_INVALID_SCOPE'));
  await assert.rejects(gate.markModelDispatching('unknown'), code('TURN_UNKNOWN_CALL'));
  await assert.rejects(gate.complete('unknown'), code('TURN_NOT_FOUND'));
  await assert.rejects(gate.recordReceipt(invocation(), toolReceipt(invocation(), 'failed')), code('TURN_ORIGIN_MISMATCH'));
  for (const value of ['', 'x'.repeat(129), null, 1]) await assert.rejects(gate.complete(value as string), code('TURN_INVALID_SCOPE'));
  assert.deepEqual(await kinds(journal), ['turn.registered']);
});

test('R2b caller mutation and snapshot mutation cannot alter model identity or in-flight diagnostics', async t => {
  const { gate, journal, directory } = await fixture(t); const call = model(); const expected = structuredClone(call);
  const barrier = await syncControl(directory);
  try {
    const prepared = gate.prepareModel(call); await barrier.entered(); call.callId = 'mutated'; call.requestSha256 = 'd'.repeat(64);
    barrier.release(); await prepared; await gate.markModelDispatching(expected.callId);
    const snapshot = gate.snapshot(); snapshot.inFlightCallIds.length = 0; snapshot.inFlightExecutionIds.push('fake'); snapshot.currentTurn!.budgetRef = 'fake';
    assert.deepEqual(gate.snapshot().inFlightCallIds, [expected.callId]); assert.deepEqual(gate.snapshot().inFlightExecutionIds, []); assert.equal(gate.snapshot().currentTurn!.budgetRef, turn.budgetRef);
    const facts = (await journal.read()).entries.filter(entry => entry.kind === 'model.prepared' || entry.kind === 'model.dispatching');
    for (const fact of facts) if ('call' in fact) assert.deepEqual(fact.call, expected);
  } finally { barrier.restore(); }
});

test('R2b reopening model facts remains recovery-required and only exact evidenced receipts clear diagnostic unknown IDs', async t => {
  const cases = [
    { name: 'ordinary-known-failure', unknown: false, evidence: false, changed: false, duplicate: false, unresolved: false },
    { name: 'unknown-no-evidence', unknown: true, evidence: false, changed: false, duplicate: false, unresolved: true },
    { name: 'unknown-evidenced', unknown: true, evidence: true, changed: false, duplicate: false, unresolved: false },
    { name: 'wrong-request-hash', unknown: true, evidence: true, changed: true, duplicate: false, unresolved: true },
    { name: 'ambiguous-duplicate-dispatch', unknown: true, evidence: true, changed: false, duplicate: true, unresolved: true },
  ];
  for (const item of cases) {
    const { journal, directory } = await fixture(t, false); const call = model(); let eventId = 0;
    const base = () => ({ schemaVersion: 1 as const, eventId: `recovery-${++eventId}`, sessionId, operationId: turn.operationId, turnId: turn.turnId, epoch: turn.epoch, at: '2026-09-21T00:00:00.000Z' });
    await journal.append({ ...base(), kind: 'model.prepared', call });
    await journal.append({ ...base(), kind: 'model.dispatching', call });
    if (item.duplicate) await journal.append({ ...base(), kind: 'model.dispatching', call });
    if (item.unknown) await journal.append({ ...base(), kind: 'model.receipt', call, receipt: modelReceipt(call, 'unknown') });
    const receiptCall = item.changed ? { ...call, requestSha256: 'd'.repeat(64) } : call;
    await journal.append({ ...base(), kind: 'model.receipt', call: receiptCall, receipt: modelReceipt(call, 'failed', item.evidence ? 'verified-readback' : undefined) });
    await journal.close(); const before = await fs.readFile(join(directory, 'execution.jsonl'));
    const reopened = await openExecutionJournal({ directory, sessionId, ownerId: 'r2b-reader' });
    try {
      const restored = await createTurnGate({ sessionId, journal: reopened });
      assert.equal(restored.snapshot().state, 'paused', item.name);
      assert.deepEqual(restored.snapshot().inFlightCallIds, item.unresolved ? [call.callId] : [], item.name);
      await assert.rejects(restored.register(nextTurn()), code('TURN_RECOVERY_REQUIRED'));
      await assert.rejects(restored.prepareModel(model(2)), code('TURN_RECOVERY_REQUIRED'));
      await assert.rejects(restored.complete(turn.turnId), code('TURN_RECOVERY_REQUIRED'));
      assert.deepEqual(await fs.readFile(join(directory, 'execution.jsonl')), before);
    } finally { await reopened.close(); }
  }
});

test('R2b shared factories retain one cancellation fence and completed Turns cannot reuse their epoch', async t => {
  const { gate, journal } = await fixture(t); const second = await createTurnGate({ sessionId, journal }); assert.equal(second, gate);
  await gate.prepareModel(model()); await second.recordModelReceipt(model().callId, modelReceipt(model(), 'not_sent'));
  await gate.complete(turn.turnId);
  await assert.rejects(second.register({ ...nextTurn(), epoch: 1 }), code('TURN_CONFLICT'));
  await second.register(nextTurn()); await gate.stop(nextTurn().turnId);
  await assert.rejects(second.prepareModel(model(2, nextTurn())), code('TURN_REVOKED'));
  await assert.rejects(createTurnGate({ sessionId: 'wrong', journal }), code('TURN_INVALID_SCOPE'));
});

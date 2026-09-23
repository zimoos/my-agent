import 'openai/shims/web';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { normalizeContext, type Context, type Model } from '@earendil-works/pi-ai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { createProviderRuntime } from '../../src/provider/runtime.js';
import { createModelBridge } from '../../src/runtime/model-bridge.js';
import { openExecutionJournal } from '../../src/runtime/execution-journal.js';
import { createTurnGate } from '../../src/runtime/turn-gate.js';
import { openReceiptStore } from '../../src/runtime/receipt-store.js';
import type { HostControlPort, ModelCapabilitySnapshot } from '../../src/runtime/public-types.js';
import type { ModelCallContext, TurnScope } from '../../src/runtime/contracts.js';

const model: Model<'openai-completions'> = {
  api: 'openai-completions', provider: 'budget-fixture', id: 'budget-model', name: 'Offline budget fixture',
  baseUrl: 'https://provider.invalid/v1', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const capability: ModelCapabilitySnapshot = {
  id: 'cap-fixture', providerProfileId: 'profile-fixture', providerId: 'budget-fixture', modelId: model.id,
  input: ['text'], tools: true, reasoning: false, contextWindow: 131072, maxOutputTokens: 8192, cancellation: 'local',
};
const turn: TurnScope = { sessionId: 'budget-session', turnId: 'budget-turn', epoch: 1,
  operationId: 'budget-operation', stageId: 'budget-stage', budgetRef: 'budget-ref' };
const context: Context = { messages: [{ role: 'system', content: 'Preserve these instructions.', timestamp: 1 },
  { role: 'user', content: 'Please deliver this task.', timestamp: 2 }] };
type Preparation = Parameters<HostControlPort['prepareModel']>[0];

function budgetFailure(call: ModelCallContext, overrides: Record<string, unknown> = {}) {
  const error = { code: 'MA_OPERATION_BUDGET_EXCEEDED', message: 'The task budget requires a smaller request.', retryable: false,
    execution: { callId: call.callId, dispatchState: 'not_sent', providerAcceptance: 'not_sent' },
    requestBudget: { schemaVersion: 1,
      inputBudget: { measurementId: 'provider-json-utf8-plus-framing-v1', unit: 'conservative_input_units', currentUnits: 29658, maxUnits: 29658 },
      maxOutputUnits: 781, availableCredits: 1000000, requiredCredits: 1555850 }, ...overrides };
  // Matches MTEAM ma-secure-acp-entry.ts Host error reconstruction.
  return Object.assign(new Error(error.code), { code: error.code, error, requestBudget: error.requestBudget });
}

async function fixture(t: TestContext, prepare: (input: Preparation, index: number) => void | Promise<void>, failProvider = false) {
  assert.equal(process.version, 'v22.23.2');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ma-budget-recovery-')));
  const journal = await openExecutionJournal({ directory, sessionId: turn.sessionId, ownerId: 'budget-recovery-qa' });
  t.after(async () => { await journal.close(); await rm(directory, { recursive: true, force: true }); });
  const gate = await createTurnGate({ sessionId: turn.sessionId, journal });
  await gate.register(turn);
  const receipts = await openReceiptStore(join(directory, 'receipts'));
  const preparations: Preparation[] = [], dispatched: ChatCompletionCreateParamsStreaming[] = [], failures: unknown[] = [];
  const client = new OpenAI({ baseURL: model.baseUrl, apiKey: 'offline-fixture-only', maxRetries: 0,
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init as RequestInit);
      assert.equal(request.url, 'https://provider.invalid/v1/chat/completions');
      dispatched.push(await request.json() as ChatCompletionCreateParamsStreaming);
      if (failProvider) throw new Error('Controlled transport lost after entering provider boundary.');
      const chunk = { id: 'offline-response', object: 'chat.completion.chunk', created: 1, model: model.id,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Bounded request completed.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const runtime = createProviderRuntime({ provider: 'openai', model: model.id, baseURL: model.baseUrl,
    apiKey: 'offline-fixture-only', maxRetries: 0, requestTimeoutMs: 2000, streamIdleTimeoutMs: 2000 }, client);
  const forbidden = async (): Promise<never> => { throw new Error('Unexpected Host operation'); };
  const host: HostControlPort = {
    registerTurn: forbidden, revokeTurn: forbidden, authorizeTool: forbidden, queryExecution: forbidden, receiptComplete: forbidden,
    prepareModel: async input => {
      preparations.push({ ...input, request: structuredClone(input.request) });
      await prepare(input, preparations.length);
      return { supplierRequestSha256: createHash('sha256').update(JSON.stringify(input.request)).digest('hex'),
        requestRevision: input.requestRevision, modelId: model.id, providerProfileId: capability.providerProfileId, capabilitySnapshotId: capability.id };
    },
  };
  const bridge = createModelBridge({ runtime, host, gate, receipts, capability,
    captureRun: () => ({ turn, purpose: 'answer', signal: new AbortController().signal }),
    onFailure: (_call, error) => { failures.push(error); },
  });
  return { bridge, gate, journal, receipts, preparations, dispatched, failures,
    async run(messages = context, maxTokens?: number) {
      const events = [];
      for await (const event of bridge.streamSimple(model, normalizeContext(messages), maxTokens === undefined ? undefined : { maxTokens })) events.push(event);
      return events;
    },
    async receiptValues() { return Promise.all((await receipts.list()).map(reference => receipts.read(reference))); },
  };
}

test('a default Pi request can rebuild a verified Host budget rejection without an explicit maxTokens option', async t => {
  const h = await fixture(t, (input, index) => { if (index === 1) throw budgetFailure(input.context); });
  const events = await h.run();
  assert.equal(h.preparations.length, 2, `prepared ${h.preparations.length}; first max_tokens=${h.preparations[0]?.request.max_tokens}; provider=${h.dispatched.length}`);
  assert.equal(h.preparations[1].request.max_tokens, 781);
  assert.equal(h.preparations[1].requestRevision, 2);
  assert.notEqual(h.preparations[0].context.callId, h.preparations[1].context.callId);
  assert.equal(h.preparations[0].context.logicalCallId, h.preparations[1].context.logicalCallId);
  assert.equal(h.dispatched.length, 1, h.failures.map(error => String(error)).join('; '));
  assert.equal(events.at(-1)?.type, 'done');
  assert.deepEqual((await h.receiptValues()).map(value => value.status).sort(), ['not_sent', 'succeeded']);
  assert.deepEqual((await h.journal.read()).entries.map(value => value.kind), ['turn.registered', 'model.prepared', 'model.dispatching', 'model.receipt']);
});

for (const [name, invalid] of [
  ['missing retryable', () => ({ retryable: undefined })],
  ['nonboolean retryable', () => ({ retryable: 'true' })],
  ['wrong call identity', () => ({ execution: { callId: 'call_other', dispatchState: 'not_sent', providerAcceptance: 'not_sent' } })],
  ['unknown execution', (call: ModelCallContext) => ({ execution: { callId: call.callId, dispatchState: 'unknown', providerAcceptance: 'unknown' } })],
  ['accepted execution', (call: ModelCallContext) => ({ execution: { callId: call.callId, dispatchState: 'confirmed', providerAcceptance: 'accepted' } })],
  ['invalid input measurement', () => ({ requestBudget: { schemaVersion: 1, inputBudget: { measurementId: 'provider-json-utf8-plus-framing-v1', unit: 'tokens', currentUnits: 5000, maxUnits: 3000 }, maxOutputUnits: 781, availableCredits: 1000000, requiredCredits: 1555850 } })],
  ['unknown error code', () => ({ code: 'MA_PRIVATE_UNKNOWN_ERROR' })],
] as const) {
  test(`budget recovery rejects ${name} without granting a provider request`, async t => {
    const h = await fixture(t, input => { throw budgetFailure(input.context, invalid(input.context)); });
    const events = await h.run();
    assert.equal(h.preparations.length, 1);
    assert.equal(h.dispatched.length, 0);
    assert.equal(events.at(-1)?.type, 'error');
    assert.deepEqual((await h.receiptValues()).map(value => value.status), ['not_sent']);
    assert.deepEqual((await h.journal.read()).entries.map(value => value.kind), ['turn.registered']);
  });
}

function historicalContext(): Context {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (id: string, timestamp: number): Context['messages'][number] => ({
    role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp,
    usage, stopReason: 'toolUse', content: [{ type: 'toolCall', id, name: 'read_file', arguments: { path: `${id}.txt` } }],
  });
  return { messages: [
    ...structuredClone(context.messages),
    assistant('old-tool', 3),
    { role: 'toolResult', toolCallId: 'old-tool', toolName: 'read_file', isError: false, timestamp: 4,
      content: [{ type: 'text', text: 'ORIGINAL_OLD_RESULT_'.repeat(1000) }] },
    assistant('latest-tool', 5),
    { role: 'toolResult', toolCallId: 'latest-tool', toolName: 'read_file', isError: false, timestamp: 6,
      content: [{ type: 'text', text: 'LATEST_EXCHANGE_MUST_REMAIN_INTACT' }] },
    { role: 'user', content: 'Latest user requirement must remain intact.', timestamp: 7 },
  ] };
}

const nativeBytes = (request: ChatCompletionCreateParamsStreaming) => Buffer.byteLength(JSON.stringify(request), 'utf8');

test('a bounded projection omits only older textual tool results and preserves the actual Pi transcript and latest exchange', async t => {
  const history = historicalContext(), original = structuredClone(history);
  let maximum = 0;
  const h = await fixture(t, (input, index) => {
    if (index === 1) {
      maximum = nativeBytes(input.request) - 1000;
      const failure = budgetFailure(input.context);
      failure.error.requestBudget.inputBudget = { ...failure.error.requestBudget.inputBudget, currentUnits: nativeBytes(input.request), maxUnits: maximum };
      throw failure;
    }
    assert.ok(nativeBytes(input.request) <= maximum, 'The controlled Host must remeasure and approve the bounded projection.');
  });
  const events = await h.run(history);
  assert.equal(h.preparations.length, 2);
  assert.equal(h.dispatched.length, 1);
  assert.equal(events.at(-1)?.type, 'done');
  const [before, after] = h.preparations.map(item => item.request);
  const old = (message: ChatCompletionCreateParamsStreaming['messages'][number]) => message.role === 'tool' && message.tool_call_id === 'old-tool';
  assert.deepEqual(after.messages.filter(message => !old(message)), before.messages.filter(message => !old(message)));
  const omitted = after.messages.find(old);
  assert.ok(omitted && typeof omitted.content === 'string');
  assert.match(omitted.content, /content omitted from this request/);
  assert.match(omitted.content, /No unseen content is being summarized/);
  assert.equal(after.max_tokens, 781);
  assert.deepEqual(history, original, 'Budget projection must not mutate Pi history.');
  assert.deepEqual((await h.receiptValues()).map(value => value.status).sort(), ['not_sent', 'succeeded']);
});

test('protected input that still cannot fit is refused after one bounded re-quote with zero provider dispatches', async t => {
  const history: Context = { messages: [
    { role: 'system', content: 'PROTECTED_SYSTEM'.repeat(500), timestamp: 1 },
    { role: 'user', content: 'PROTECTED_USER'.repeat(1000), timestamp: 2 },
  ] };
  const original = structuredClone(history);
  const h = await fixture(t, input => {
    const failure = budgetFailure(input.context);
    failure.error.requestBudget.inputBudget = { ...failure.error.requestBudget.inputBudget,
      currentUnits: nativeBytes(input.request), maxUnits: 512 };
    throw failure;
  });
  const events = await h.run(history);
  assert.equal(h.preparations.length, 2);
  assert.equal(h.dispatched.length, 0);
  assert.equal(events.at(-1)?.type, 'error');
  assert.deepEqual(h.preparations[1].request.messages, h.preparations[0].request.messages);
  assert.deepEqual(history, original);
  assert.deepEqual((await h.receiptValues()).map(value => value.status), ['not_sent', 'not_sent']);
  assert.deepEqual((await h.journal.read()).entries.map(value => value.kind), ['turn.registered']);
});


test('an unresolved dispatched provider request records unknown and never replays', async t => {
  const h = await fixture(t, () => {}, true);
  const events = await h.run();
  assert.equal(h.preparations.length, 1);
  assert.equal(h.dispatched.length, 1);
  assert.equal(events.at(-1)?.type, 'error');
  assert.deepEqual((await h.receiptValues()).map(value => value.status), ['unknown']);
  const entries = (await h.journal.read()).entries;
  assert.equal(entries.filter(value => value.kind === 'model.prepared').length, 1);
  assert.equal(entries.filter(value => value.kind === 'model.dispatching').length, 1);
  const receipt = entries.find(value => value.kind === 'model.receipt');
  assert.equal(receipt?.kind === 'model.receipt' && receipt.receipt.status, 'unknown');
  assert.deepEqual(h.gate.snapshot().inFlightCallIds, [h.preparations[0].context.callId]);
});

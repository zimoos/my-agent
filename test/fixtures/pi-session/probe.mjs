import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { scratch, isolationEvidence } from './isolation.mjs';

// Guards are installed before importing the actual SDK and compiled product.
const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
const { InMemoryCredentialStore, InMemoryModelsStore, createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
const { createPiSessionFacade, PiSessionError } = await import(pathToFileURL(process.env.MA_PI_SESSION_MODULE));
const mode = process.env.MA_PI_SESSION_MODE;
const providerId = process.env.MA_PI_SESSION_PROVIDER;
const cwd = path.join(scratch, 'workspace');
const agentDir = path.join(scratch, 'agent');
const preflight = mode.startsWith('preflight-');
const memory = new InMemoryCredentialStore();
const authEntered = Promise.withResolvers();
const authRelease = Promise.withResolvers();
let authArmed = false;
let heldAuthReads = 0;
const credentials = {
  async read(id, options) {
    if (authArmed && id === providerId) {
      heldAuthReads++;
      authEntered.resolve();
      await authRelease.promise;
    }
    return memory.read(id, options);
  },
  list: (...args) => memory.list(...args),
  modify: (...args) => memory.modify(...args),
  delete: (...args) => memory.delete(...args),
};
if (!preflight) await memory.modify(providerId, async () => ({ type: 'api_key', key: 'offline-protocol-fixture' }));
const runtime = await ModelRuntime.create({
  credentials, modelsStore: new InMemoryModelsStore(), authPath: path.join(agentDir, 'controlled-auth.json'),
  modelsPath: path.join(agentDir, 'controlled-models.json'), allowModelNetwork: false, refreshOnCreate: false,
});
const calls = [];
const callbackErrors = [];
const behaviours = [];
const deltaSeen = Promise.withResolvers();
const abortSeen = Promise.withResolvers();
const pending = [];
let signalAborts = 0;
const usage = { input: 13, output: 17, cacheRead: 2, cacheWrite: 3, totalTokens: 35, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const systemPrompt = 'Explicit MA fixture system prompt. No tools or resources.';
const providerSecret = 'SENSITIVE_PROVIDER_DETAIL_do_not_forward';

async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`F1 timeout: ${label}`)), 4000); })]); }
  finally { clearTimeout(timer); }
}
function textDelta(stream, message, text) {
  const index = message.content.length;
  message.content.push({ type: 'text', text });
  stream.push({ type: 'text_start', contentIndex: index, partial: message });
  stream.push({ type: 'text_delta', contentIndex: index, delta: text, partial: message });
  stream.push({ type: 'text_end', contentIndex: index, content: text, partial: message });
}
function streamSimple(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const behaviour = behaviours.shift() ?? 'text';
  const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(), stopReason: 'pending', usage: structuredClone(usage) };
  calls.push({ provider: model.provider, model: model.id, messages: structuredClone(context.messages), maxRetries: options?.maxRetries, startedAborted: options?.signal?.aborted });
  let ended = false;
  function finish(reason = 'stop') {
    if (ended) return;
    ended = true;
    message.stopReason = reason;
    if (reason === 'error' || reason === 'aborted') {
      message.errorMessage = reason === 'aborted' ? 'fixture request cancelled' : providerSecret;
      stream.push({ type: 'error', reason, error: message });
    } else stream.push({ type: 'done', reason, message });
    stream.end();
  }
  pending.push(() => finish('aborted'));
  queueMicrotask(() => {
    try {
      assert.equal(model.provider, providerId);
      assert.equal(model.id, 'frozen-model');
      assert.equal(options?.maxRetries, 0);
      assert.equal(options?.signal?.aborted, false, 'cancel latch must stop dispatch before provider entry');
      const systems = context.messages.filter((entry) => entry.role === 'system');
      assert.ok(JSON.stringify(systems).includes(systemPrompt));
      assert.deepEqual(systems.flatMap((entry) => entry.toolsAdded ?? []), [], 'facade must expose zero tools');
      assert.ok(!JSON.stringify(context).includes('MA_PI_SENTINEL_'));
      options.signal.addEventListener('abort', () => {
        signalAborts++;
        abortSeen.resolve();
        if (behaviour === 'late') {
          textDelta(stream, message, 'LATE_TEXT_MUST_NOT_BE_FORWARDED');
          finish('stop');
        } else finish('aborted');
      }, { once: true });
      stream.push({ type: 'start', partial: message });
      if (behaviour === 'error') { textDelta(stream, message, 'partial-error'); finish('error'); return; }
      textDelta(stream, message, behaviour === 'hold' || behaviour === 'late' ? 'before-cancel' : `${providerId}: exact text`);
      if (behaviour === 'hold' || behaviour === 'late') return;
      if (behaviour === 'tool') {
        const index = message.content.length;
        const toolCall = { type: 'toolCall', id: 'unexpected-call', name: 'bash', arguments: { command: `touch ${JSON.stringify(path.join(scratch, 'tool-side-effect'))}` } };
        message.content.push(toolCall);
        stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
        stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: message });
        finish('toolUse');
      } else finish('stop');
    } catch (error) {
      callbackErrors.push(String(error));
      finish('error');
    }
  });
  return stream;
}
runtime.registerProvider(providerId, {
  name: 'Deterministic protocol fixture', api: 'ma-facade-fixture-api', baseUrl: 'http://127.0.0.1:1', authHeader: false,
  // For preflight tests auth comes only from the public credential-store input;
  // no static apiKey is allowed to bypass the SDK checkAuth await.
  ...(preflight ? {} : { apiKey: 'offline-protocol-fixture' }), streamSimple,
  models: [{ id: 'frozen-model', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 }],
});
await runtime.refresh({ allowNetwork: false });
const scope = { maSessionId: 'ma-session-fixture', workspaceId: 'workspace-fixture', canonicalCwd: cwd, hostIdentity: 'fixture-host', providerProfileId: 'fixture-profile' };
const originalScope = structuredClone(scope);
const options = { scope, agentDir, modelRuntime: runtime, providerId, modelId: 'frozen-model', systemPrompt };
const turn = (epoch = 1, overrides = {}) => ({ sessionId: originalScope.maSessionId, turnId: `turn-${epoch}`, epoch, operationId: `operation-${epoch}`, stageId: `stage-${epoch}`, budgetRef: `budget-${epoch}`, ...overrides });
const observed = [];
const facades = [];
async function open(custom = options) {
  const facade = await createPiSessionFacade(custom);
  facades.push(facade);
  return facade;
}
function subscribe(facade) {
  return facade.subscribe((event) => {
    observed.push(structuredClone(event));
    if (event.event.type === 'message_update' && event.event.assistantMessageEvent.type === 'text_delta') deltaSeen.resolve();
  });
}
async function code(operation, expected) {
  await assert.rejects(async () => await operation(), (error) => {
    assert.ok(error instanceof PiSessionError);
    assert.equal(error.code, expected);
    assert.ok(!error.message.includes(providerSecret));
    return true;
  });
}
function assertResult(result, status, expectedTurn, facade) {
  assert.equal(result.status, status);
  assert.deepEqual(result.turn, expectedTurn);
  assert.equal(result.engineSessionId, facade.engineSessionId);
}
function deltaText(events = observed) {
  return events.filter((entry) => entry.event.type === 'message_update' && entry.event.assistantMessageEvent.type === 'text_delta').map((entry) => entry.event.assistantMessageEvent.delta).join('');
}
let detail = {};
try {
  if (mode === 'validation') {
    for (const invalid of [
      { ...options, scope: { ...scope, maSessionId: '' } },
      { ...options, scope: { ...scope, hostIdentity: 'x'.repeat(129) } },
      { ...options, scope: { ...scope, canonicalCwd: 'relative/path' } },
      { ...options, providerId: '' },
    ]) await code(() => open(invalid), 'PI_INVALID_CONFIG');
    await code(() => open({ ...options, modelId: 'missing-model' }), 'PI_MODEL_UNAVAILABLE');
    const facade = await open();
    // I clarified the first 13/2 run: malformed shape uses INVALID_CONFIG;
    // structurally valid but mismatched/reused identities use TURN_MISMATCH.
    for (const invalid of [turn(0), turn(1.5), turn(Number.MAX_SAFE_INTEGER + 1), turn(1, { budgetRef: '' }), turn(1, { turnId: 'x'.repeat(129) })]) {
      await code(() => facade.prompt('invalid scope', invalid), 'PI_INVALID_CONFIG');
    }
    await code(() => facade.prompt('wrong session identity', turn(1, { sessionId: 'wrong-session' })), 'PI_TURN_MISMATCH');
    assert.equal(calls.length, 0);
    assertResult(await facade.prompt('valid after invalid', turn()), 'completed', turn(), facade);
  } else {
    const facade = await open();
    assert.equal(typeof facade.engineSessionId, 'string');
    assert.ok(facade.engineSessionId.length > 0);
    subscribe(facade);
    if (mode.startsWith('immediate-') || preflight) {
      if (preflight) {
        assert.equal(runtime.hasConfiguredAuth(providerId), false, 'fixture must enter real SDK auth preflight');
        await memory.modify(providerId, async () => ({ type: 'api_key', key: 'offline-protocol-fixture' }));
        authArmed = true;
      }
      let promptSettled = false;
      const prompt = facade.prompt('cancel before dispatch', turn()).then((result) => { promptSettled = true; return result; });
      if (preflight) await bounded(authEntered.promise, 'actual prompt credential read');
      let actionSettled = false;
      const closing = mode.endsWith('close');
      const action = (closing ? facade.close() : facade.abort('turn-1')).then((result) => { actionSettled = true; return result; });
      if (preflight) {
        await delay(50);
        assert.equal(promptSettled, false);
        assert.equal(actionSettled, false, 'SDK idle in preflight must not settle facade abort/close');
        assert.equal(calls.length, 0);
        if (closing) await code(() => facade.prompt('must reject while closing', turn(2)), 'PI_SESSION_CLOSED');
        authArmed = false;
        authRelease.resolve();
      }
      const [result, cancelled] = await bounded(Promise.all([prompt, action]), 'full preflight and idle drainage');
      assertResult(result, 'cancelled', turn(), facade);
      assert.equal(calls.length, 0, 'immediate cancellation must produce zero real provider callbacks');
      if (!closing) {
        assert.equal(cancelled.localIdle, true);
        assert.deepEqual(cancelled.turn, turn());
        assert.equal(cancelled.engineSessionId, facade.engineSessionId);
        assertResult(await facade.prompt('new task and budget', turn(2)), 'completed', turn(2), facade);
        assert.equal(calls.length, 1);
      } else await code(() => facade.prompt('closed input', turn(2)), 'PI_SESSION_CLOSED');
      detail = { heldAuthReads, promptSettled, actionSettled, preflightCallbacks: 0 };
    } else if (mode === 'text') {
      assertResult(await facade.prompt('/skill:not-expanded literal text', turn()), 'completed', turn(), facade);
      assert.equal(calls.length, 1);
      assert.equal(deltaText(), `${providerId}: exact text`);
      const assistants = observed.filter((entry) => entry.event.type === 'message_end' && entry.event.message.role === 'assistant');
      assert.equal(assistants.length, 1);
      assert.deepEqual(assistants[0].event.message.usage, usage);
      assert.ok(JSON.stringify(calls[0].messages).includes('/skill:not-expanded literal text'));
      await code(() => facade.abort('turn-1'), 'PI_TURN_MISMATCH');
    } else if (mode === 'failure') {
      behaviours.push('error');
      const result = await facade.prompt('one explicit failure', turn());
      assertResult(result, 'failed', turn(), facade);
      assert.equal(result.error.code, 'PI_MODEL_FAILED');
      assert.ok(!JSON.stringify(result).includes(providerSecret));
      assert.equal(calls.length, 1);
    } else if (mode === 'stream-abort' || mode === 'late-delta') {
      behaviours.push(mode === 'late-delta' ? 'late' : 'hold');
      const prompt = facade.prompt('cancel in progress', turn());
      await bounded(deltaSeen.promise, 'real first delta');
      const first = facade.abort('turn-1');
      const second = facade.abort('turn-1');
      const [result, a, b] = await bounded(Promise.all([prompt, first, second]), 'abort settles');
      assertResult(result, 'cancelled', turn(), facade);
      assert.deepEqual(a, b);
      assert.equal(a.localIdle, true);
      assert.equal(signalAborts, 1);
      assert.equal(deltaText(), 'before-cancel', 'ordinary late text is fenced after cancellation');
      assert.deepEqual(await facade.abort('turn-1'), a);
      assert.equal(calls.length, 1);
      assertResult(await facade.prompt('new operation', turn(2)), 'completed', turn(2), facade);
      assert.equal(calls.length, 2);
      await code(() => facade.abort('turn-1'), 'PI_TURN_MISMATCH');
      detail = { signalAborts, cancelLocalIdle: a.localIdle };
    } else if (mode === 'lifecycle') {
      behaviours.push('hold');
      const prompt = facade.prompt('occupy session', turn());
      await code(() => facade.prompt('no implicit queue', turn(2)), 'PI_SESSION_BUSY');
      await bounded(deltaSeen.promise, 'active stream');
      await code(() => facade.abort('wrong-turn'), 'PI_TURN_MISMATCH');
      assert.equal(signalAborts, 0);
      const closed = facade.close();
      const closedAgain = facade.close();
      await code(() => facade.prompt('closed immediately', turn(2)), 'PI_SESSION_CLOSED');
      assertResult(await bounded(prompt, 'close drains original prompt'), 'cancelled', turn(), facade);
      await bounded(Promise.all([closed, closedAgain]), 'repeated close');
      await facade.close();
      assert.equal(signalAborts, 1);
      assert.equal(calls.length, 1);
    } else if (mode === 'inherited-turn') {
      const inheritedTurn = turn();
      delete inheritedTurn.budgetRef;
      assert.equal(Object.hasOwn(Object.prototype, 'budgetRef'), false);
      Object.defineProperty(Object.prototype, 'budgetRef', { value: 'inherited-not-owned-budget', configurable: true });
      try {
        await code(() => facade.prompt('missing own field must not inherit authority context', inheritedTurn), 'PI_INVALID_CONFIG');
        assert.equal(calls.length, 0);
      } finally { delete Object.prototype.budgetRef; }
    } else if (mode === 'listeners') {
      // Both result state and every observer snapshot must be immune to this observer.
      const broken = facade.subscribe((entry) => {
        entry.turn.operationId = 'observer-mutation';
        if (entry.event.type === 'message_end' && entry.event.message.role === 'assistant') entry.event.message.stopReason = 'error';
        throw new Error('observer exception is isolated');
      });
      const asyncBroken = facade.subscribe(async () => {
        await Promise.resolve();
        throw new Error('asynchronous observer rejection is isolated');
      });
      const later = [];
      const removeLater = facade.subscribe((entry) => later.push(structuredClone(entry)));
      const mutableTurn = turn();
      const expectedTurn = structuredClone(mutableTurn);
      const promise = facade.prompt('snapshot boundaries', mutableTurn);
      mutableTurn.turnId = 'caller-mutated'; mutableTurn.budgetRef = 'caller-mutated';
      scope.maSessionId = 'caller-mutated'; scope.canonicalCwd = '/forbidden-caller-path';
      const result = await promise;
      assertResult(result, 'completed', expectedTurn, facade);
      for (const entry of later) { assert.deepEqual(entry.turn, expectedTurn); assert.equal(entry.engineSessionId, facade.engineSessionId); }
      assert.equal(later.find((entry) => entry.event.type === 'message_end' && entry.event.message.role === 'assistant').event.message.stopReason, 'stop');
      broken(); broken(); asyncBroken(); asyncBroken(); removeLater(); removeLater();
      const count = later.length;
      assertResult(await facade.prompt('new budget is permitted', turn(2)), 'completed', turn(2), facade);
      assert.equal(later.length, count);
      await code(() => facade.prompt('replay exact turn', turn(2)), 'PI_TURN_MISMATCH');
      await code(() => facade.prompt('new ID old epoch', turn(1, { turnId: 'not-used' })), 'PI_TURN_MISMATCH');
    } else if (mode === 'unexpected-tool') {
      behaviours.push('tool');
      const result = await facade.prompt('model tries unapproved tool', turn());
      assertResult(result, 'failed', turn(), facade);
      assert.equal(result.error.code, 'PI_UNEXPECTED_TOOL');
      assert.equal(calls.length, 1, 'unexpected tool must not start another model callback');
      await code(() => facade.abort('turn-1'), 'PI_TURN_MISMATCH');
      detail = { observedToolEvents: observed.filter((entry) => entry.event.type.startsWith('tool_execution_')).length };
    } else if (mode === 'borrowed-runtime') {
      const config = runtime.getRegisteredProviderConfig(providerId);
      await facade.close();
      assert.equal(runtime.getRegisteredProviderConfig(providerId).streamSimple, config.streamSimple);
      const other = await open({ ...options, scope: { ...originalScope, maSessionId: 'other-session' } });
      const otherTurn = turn(1, { sessionId: 'other-session' });
      assertResult(await other.prompt('runtime remains borrowed', otherTurn), 'completed', otherTurn, other);
      assert.equal(calls.length, 1);
    } else throw new Error(`Unknown fixture mode ${mode}`);
  }
  assert.deepEqual(callbackErrors, []);
  const after = calls.length;
  await delay(350);
  assert.equal(calls.length, after, 'no SDK retry, warming or hidden post-run callback');
  assert.equal(observed.some((entry) => entry.event.type.startsWith('auto_retry_') || entry.event.type.startsWith('auto_compaction_')), false);
  assert.ok(calls.every((entry) => entry.maxRetries === 0));
  console.log(JSON.stringify({ ok: true, mode, providerId, evidenceLevel: 'protocol_fixture', providerCallbacks: calls.length,
    engineEventCounts: Object.fromEntries(['agent_start', 'agent_end', 'agent_settled'].map((type) => [type, observed.filter((entry) => entry.event.type === type).length])),
    ...detail, ...isolationEvidence() }));
} catch (error) {
  console.error(JSON.stringify({ mode, diagnostic: 'real-facade-failure', providerCallbacks: calls.length, heldAuthReads, signalAborts,
    callbackErrors, events: observed.map((entry) => ({ type: entry.event.type, turn: entry.turn, engineSessionId: entry.engineSessionId })) }));
  throw error;
} finally {
  authArmed = false; authRelease.resolve();
  for (const finish of pending) finish();
  for (const facade of facades) await bounded(facade.close(), 'fixture final close');
}

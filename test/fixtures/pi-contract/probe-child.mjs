import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// This process has no inherited supplier credentials, child-process or personal-file permission.
const scratch = process.env.MA_PI_PROBE_SCRATCH;
const mode = process.env.MA_PI_PROBE_MODE;
assert.ok(scratch && ['success', 'error-before-start', 'error-after-output', 'abort-after-delta', 'abort-during-tool'].includes(mode));
const cwd = path.join(scratch, 'workspace');
const agentDir = path.join(scratch, 'agent');
const deniedCanary = process.env.MA_PI_DENIED_CANARY;
const personalRoot = process.env.MA_PI_PERSONAL_ROOT;
assert.equal(process.version, 'v22.23.2');
assert.equal(process.versions.bun, undefined);
assert.equal(process.permission.has('fs.read', personalRoot), false);
assert.equal(process.permission.has('child'), false);
assert.equal(process.permission.has('worker'), false);
assert.throws(() => fs.readFileSync(deniedCanary), { code: 'ERR_ACCESS_DENIED' });

const networkAttempts = [];
const blockNetwork = (...args) => {
  networkAttempts.push(typeof args[0] === 'string' ? args[0] : typeof args[0]);
  throw Object.assign(new Error('PI_PROBE_NETWORK_DENIED'), { code: 'PI_PROBE_NETWORK_DENIED' });
};
globalThis.fetch = blockNetwork;
net.connect = blockNetwork;
net.createConnection = blockNetwork;
net.Socket.prototype.connect = blockNetwork;
tls.connect = blockNetwork;
http.request = blockNetwork;
http.get = blockNetwork;
https.request = blockNetwork;
https.get = blockNetwork;
dns.lookup = blockNetwork;
dns.resolve = blockNetwork;
dgram.createSocket = blockNetwork;
assert.throws(() => net.connect({ host: '127.0.0.1', port: 1 }), { code: 'PI_PROBE_NETWORK_DENIED' });
networkAttempts.length = 0;

const fileReads = [];
function recordRead(value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (typeof value === 'string') fileReads.push(path.resolve(value));
}
for (const name of ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync', 'accessSync', 'existsSync']) {
  const original = fs[name];
  fs[name] = function (filename, ...args) { recordRead(filename); return original.call(this, filename, ...args); };
}
for (const object of [fs, fsp]) {
  for (const name of ['readFile', 'open', 'readdir', 'stat', 'lstat', 'access']) {
    const original = object[name];
    object[name] = function (filename, ...args) { recordRead(filename); return original.call(this, filename, ...args); };
  }
}
syncBuiltinESMExports();

// Dynamic imports ensure filesystem/network controls already apply to the real SDK.
const {
  ModelRuntime, SettingsManager, SessionManager, createAgentSession,
  createExtensionRuntime, defineTool,
} = await import('@earendil-works/pi-coding-agent');
const {
  InMemoryCredentialStore, InMemoryModelsStore, createAssistantMessageEventStream,
} = await import('@earendil-works/pi-ai');
const { Type } = await import('typebox');

const settings = SettingsManager.inMemory({
  retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 2000 } },
  cacheWarming: 'off', compaction: { enabled: false },
  enableAnalytics: false, enableInstallTelemetry: false,
  packages: [], extensions: [], skills: [], prompts: [], themes: [], defaultTools: [],
  enableSkillCommands: false, images: { autoResize: false, blockImages: false },
}, { projectTrusted: false });
assert.equal(settings.getRetryEnabled(), false);
assert.equal(settings.getProviderRetrySettings().maxRetries, 0);
assert.equal(settings.getCacheWarmingMode(), 'off');
assert.equal(settings.getEnableAnalytics(), false);
assert.equal(settings.getEnableInstallTelemetry(), false);

const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'),
  modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false,
});
const image = {
  type: 'image', mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP8sAAAAASUVORK5CYII=',
};
const longValue = '中文😀\\"\n'.repeat(6000);
assert.ok(Buffer.byteLength(longValue, 'utf8') >= 32 * 1024);
const calls = [];
const toolOrder = [];
const executed = [];
const events = [];
const textDeltas = [];
const callbackErrors = [];
const firstDelta = Promise.withResolvers();
const toolStarted = Promise.withResolvers();
const toolSignalAborted = Promise.withResolvers();
const releaseTool = Promise.withResolvers();
const abortTrace = [];
const providerSignals = [];
let providerAbortEvents = 0;
let providerAbortTerminals = 0;
let toolAbortEvents = 0;
let toolCompletionAfterAbort = false;
let abortEvidence;
let firstCompleted = false;
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`P05 timed out: ${label}`)), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
const usageFor = (second = false) => second
  ? { input: 333, output: 444, cacheRead: 0, cacheWrite: 0, totalTokens: 777, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  : { input: 111, output: 222, cacheRead: 3, cacheWrite: 4, totalTokens: 340, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function messageFor(model, second = false) {
  return {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [], timestamp: Date.now(), stopReason: 'pending', usage: usageFor(second),
  };
}
function emitText(stream, message, text) {
  const contentIndex = message.content.length;
  const block = { type: 'text', text: '' };
  message.content.push(block);
  stream.push({ type: 'text_start', contentIndex, partial: message });
  for (const delta of [text.slice(0, 7), text.slice(7)]) {
    block.text += delta;
    stream.push({ type: 'text_delta', contentIndex, delta, partial: message });
  }
  stream.push({ type: 'text_end', contentIndex, content: block.text, partial: message });
}
function emitTool(stream, message, id, name, value) {
  const contentIndex = message.content.length;
  const toolCall = { type: 'toolCall', id, name, arguments: {} };
  message.content.push(toolCall);
  stream.push({ type: 'toolcall_start', contentIndex, partial: message });
  const args = JSON.stringify({ value });
  for (let offset = 0; offset < args.length; offset += 1024) {
    stream.push({ type: 'toolcall_delta', contentIndex, delta: args.slice(offset, offset + 1024), partial: message });
  }
  toolCall.arguments = JSON.parse(args);
  stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: message });
}
function fixtureStream(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const snapshot = structuredClone(context.messages);
  const callNumber = calls.length + 1;
  calls.push({ messages: snapshot, maxRetries: options?.maxRetries, startedAborted: options?.signal?.aborted });
  providerSignals.push(options?.signal);
  queueMicrotask(() => {
    const message = messageFor(model, calls.length > 1);
    try {
      assert.equal(options?.maxRetries, 0);
      assert.ok(!JSON.stringify(snapshot).includes('MA_PI_SENTINEL_'));
      if (mode === 'abort-after-delta' || (mode === 'abort-during-tool' && options?.signal?.aborted)) {
        assert.ok(options.signal instanceof AbortSignal);
        const completeAborted = () => {
          providerAbortEvents++;
          abortTrace.push(`provider-${callNumber}-signal-abort`);
          assert.equal(options.signal, providerSignals[callNumber - 1]);
          message.stopReason = 'aborted';
          message.errorMessage = 'protocol_fixture observed abort on this request';
          providerAbortTerminals++;
          stream.push({ type: 'error', reason: 'aborted', error: message });
          stream.end();
        };
        if (options.signal.aborted) { completeAborted(); return; }
        options.signal.addEventListener('abort', completeAborted, { once: true });
        stream.push({ type: 'start', partial: message });
        message.content.push({ type: 'text', text: 'partial-before-abort' });
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'partial-before-abort', partial: message });
        return; // Real SDK consumes the stream while the provider awaits its own signal.
      }
      if (mode.startsWith('error-')) {
        if (mode === 'error-after-output') {
          stream.push({ type: 'start', partial: message });
          emitText(stream, message, 'partial-before-error');
        }
        message.stopReason = 'error';
        message.errorMessage = '503 fixture unavailable';
        stream.push({ type: 'error', reason: 'error', error: message });
        stream.end();
        return;
      }
      const results = snapshot.filter((entry) => entry.role === 'toolResult');
      stream.push({ type: 'start', partial: message });
      if (results.length === 0) {
        assert.equal(calls.length, 1);
        const userImages = snapshot.filter((entry) => entry.role === 'user')
          .flatMap((entry) => Array.isArray(entry.content) ? entry.content : [])
          .filter((part) => part.type === 'image');
        assert.deepEqual(userImages, [image]);
        emitText(stream, message, 'fixture-start: ');
        emitTool(stream, message, 'pi-call-first', 'fixture_first', longValue);
        emitTool(stream, message, 'pi-call-second', 'fixture_second', 'second-value');
        message.stopReason = 'toolUse';
      } else {
        assert.equal(calls.length, 2);
        assert.equal(results.length, 2);
        assert.deepEqual(results.map((entry) => [entry.toolCallId, entry.toolName, entry.isError]), [
          ['pi-call-first', 'fixture_first', false], ['pi-call-second', 'fixture_second', false],
        ]);
        assert.deepEqual(results[0].content, [{ type: 'text', text: 'first-result' }, image]);
        assert.deepEqual(results[1].content, [{ type: 'text', text: 'second-result' }]);
        emitText(stream, message, 'fixture-final: two tools observed');
        message.stopReason = 'stop';
      }
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end();
    } catch (error) {
      callbackErrors.push(error);
      message.stopReason = 'error';
      message.errorMessage = String(error);
      stream.push({ type: 'error', reason: 'error', error: message });
      stream.end();
    }
  });
  return stream;
}
runtime.registerProvider('ma-fixture', {
  name: 'MA deterministic protocol fixture', api: 'ma-fixture-api',
  apiKey: 'fixture-only-no-secret', baseUrl: 'http://127.0.0.1:1', authHeader: false,
  models: [{ id: 'fixture-model', name: 'Fixture', reasoning: false, input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 }],
  streamSimple: fixtureStream,
});
const model = runtime.getModel('ma-fixture', 'fixture-model');
assert.ok(model, 'public ModelRuntime.getModel must resolve the registered provider');
const firstTool = defineTool({
  name: 'fixture_first', label: 'First fixture', description: 'Return a fixed text and image result.',
  parameters: Type.Object({ value: Type.String() }), executionMode: 'sequential',
  execute: async (toolCallId, params, signal, onUpdate) => {
    toolOrder.push('first-start');
    assert.equal(toolCallId, 'pi-call-first');
    assert.equal(params.value, longValue);
    assert.equal(signal.aborted, false);
    onUpdate?.({ content: [{ type: 'text', text: 'first-progress' }], details: {} });
    if (mode === 'abort-during-tool') {
      assert.equal(signal, providerSignals[0], 'provider and tool must receive the same active run signal');
      signal.addEventListener('abort', () => {
        toolAbortEvents++;
        abortTrace.push('tool-signal-abort');
        toolSignalAborted.resolve();
      }, { once: true });
      toolStarted.resolve();
      await releaseTool.promise; // Models an entered operation whose completion is independently controlled.
      toolCompletionAfterAbort = signal.aborted;
      abortTrace.push('tool-late-completion');
    } else {
      await delay(25);
    }
    firstCompleted = true;
    toolOrder.push('first-end');
    executed.push({ toolCallId, bytes: Buffer.byteLength(params.value, 'utf8') });
    return { content: [{ type: 'text', text: 'first-result' }, image], details: {} };
  },
});
const secondTool = defineTool({
  name: 'fixture_second', label: 'Second fixture', description: 'Run after the first tool finishes.',
  parameters: Type.Object({ value: Type.String() }), executionMode: 'sequential',
  execute: async (toolCallId, params) => {
    assert.equal(firstCompleted, true, 'SDK ran the second sequential tool before the first completed');
    assert.equal(toolCallId, 'pi-call-second');
    assert.equal(params.value, 'second-value');
    toolOrder.push('second-start', 'second-end');
    executed.push({ toolCallId, bytes: Buffer.byteLength(params.value, 'utf8') });
    return { content: [{ type: 'text', text: 'second-result' }], details: {} };
  },
});
const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
const emptyLoader = {
  getExtensions: () => extensions,
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => 'MA deterministic protocol probe. Use only the registered fixture tools.',
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => { throw new Error('probe allowlist is immutable'); },
  reload: async () => {},
};
const sessionManager = SessionManager.inMemory(cwd);
const { session } = await createAgentSession({
  cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: 'off',
  scopedModels: [{ model, thinkingLevel: 'off' }], settingsManager: settings,
  sessionManager, resourceLoader: emptyLoader, noTools: 'builtin',
  tools: ['fixture_first', 'fixture_second'], customTools: [firstTool, secondTool],
});
const unsubscribe = session.subscribe((event) => {
  events.push(structuredClone(event));
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
    textDeltas.push(event.assistantMessageEvent.delta);
    firstDelta.resolve();
  }
});
let promptRejected = false;
try {
  assert.deepEqual(session.getActiveToolNames().sort(), ['fixture_first', 'fixture_second']);
  if (mode.startsWith('abort-')) {
    const prompt = session.prompt('Exercise the controlled cancellation protocol.', {
      expandPromptTemplates: false, images: mode === 'abort-during-tool' ? [image] : undefined,
    }).catch(() => { promptRejected = true; });
    await bounded(mode === 'abort-after-delta' ? firstDelta.promise : toolStarted.promise, 'real SDK first observable activity');
    abortTrace.push(mode === 'abort-after-delta' ? 'delta-observed' : 'tool-entered');
    assert.equal(session.isIdle, false);
    let abortSettled = false;
    let idleSettled = false;
    abortTrace.push('abort-called');
    const abort = session.abort().then(() => { abortSettled = true; abortTrace.push('abort-resolved'); });
    const idle = session.waitForIdle().then(() => { idleSettled = true; abortTrace.push('idle-resolved'); });
    let blockedUntilToolCompletion;
    if (mode === 'abort-during-tool') {
      await bounded(toolSignalAborted.promise, 'same active tool signal');
      await delay(50);
      blockedUntilToolCompletion = !abortSettled && !idleSettled && !session.isIdle;
      assert.equal(blockedUntilToolCompletion, true, 'abort/idle must not report completion while the entered tool is unresolved');
      assert.equal(firstCompleted, false);
      assert.equal(calls.length, 1);
      assert.deepEqual(toolOrder, ['first-start']);
      abortTrace.push('tool-released');
      releaseTool.resolve();
    }
    await bounded(Promise.all([prompt, abort, idle]), 'prompt + abort + waitForIdle settlement');
    assert.equal(session.isIdle, true);
    await session.abort(); // Repeated idle abort must not synthesize another terminal event.
    await session.waitForIdle();
    abortEvidence = {
      isIdle: session.isIdle, abortSettled, idleSettled, providerAbortEvents, providerAbortTerminals,
      toolAbortEvents, toolCompletionAfterAbort, blockedUntilToolCompletion,
      remoteStopConfirmed: false, // Neither a local signal nor SDK idle is a remote stop receipt.
      abortTrace, callbackStartedAborted: calls.map((call) => call.startedAborted),
    };
  } else {
    try {
      await session.prompt(mode === 'success' ? 'Run both fixture tools in sequence.' : 'Return the fixture failure.', {
        expandPromptTemplates: false, images: mode === 'success' ? [image] : undefined,
      });
    } catch { promptRejected = true; }
  }
  assert.equal(callbackErrors.length, 0, callbackErrors.map(String).join('\n'));
  const beforeIdle = calls.length;
  await delay(350);
  assert.equal(calls.length, beforeIdle, 'SDK added a hidden retry or cache-warming callback');
  assert.equal(events.some((event) => event.type === 'auto_retry_start'), false);
  const assistantMessages = session.messages.filter((entry) => entry.role === 'assistant');
  if (mode.startsWith('abort-')) {
    console.error(JSON.stringify({
      case: mode, diagnostic: 'public-sdk-cancellation-observation', abortEvidence,
      providerCallbacks: calls.length, callbackStartedAborted: calls.map((call) => call.startedAborted),
      assistantMessages: assistantMessages.map((entry) => ({ stopReason: entry.stopReason, errorMessage: entry.errorMessage })),
      toolOrder, toolResults: session.messages.filter((entry) => entry.role === 'toolResult').map((entry) => ({ toolCallId: entry.toolCallId, toolName: entry.toolName, isError: entry.isError })),
      eventTypes: events.map((event) => event.type).filter((type) => type !== 'message_update'),
    }));
  }
  if (mode === 'success') {
    assert.equal(promptRejected, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(toolOrder, ['first-start', 'first-end', 'second-start', 'second-end']);
    assert.deepEqual(assistantMessages.map((entry) => entry.usage), [usageFor(false), usageFor(true)]);
    assert.equal(textDeltas.join(''), 'fixture-start: fixture-final: two tools observed');
    assert.deepEqual(events.filter((event) => event.type === 'tool_execution_start').map((event) => event.toolCallId), ['pi-call-first', 'pi-call-second']);
    assert.deepEqual(events.filter((event) => event.type === 'tool_execution_end').map((event) => event.toolCallId), ['pi-call-first', 'pi-call-second']);
    assert.ok(events.some((event) => event.type === 'tool_execution_update' && event.toolCallId === 'pi-call-first'));
    assert.equal(session.messages.filter((entry) => entry.role === 'toolResult').length, 2);
    assert.ok(sessionManager.getEntries().some((entry) => entry.type === 'message' && entry.message.role === 'toolResult'));
  } else if (mode.startsWith('error-')) {
    assert.equal(calls.length, 1);
    assert.equal(executed.length, 0);
    assert.equal(assistantMessages.at(-1)?.stopReason, 'error');
    assert.equal(assistantMessages.at(-1)?.errorMessage, '503 fixture unavailable');
    assert.equal(textDeltas.join(''), mode === 'error-after-output' ? 'partial-before-error' : '');
  } else {
    assert.equal(events.filter((event) => event.type === 'agent_start').length, 1);
    assert.equal(events.filter((event) => event.type === 'agent_end').length, 1, 'one SDK run must settle once');
    assert.equal(session.messages.filter((entry) => entry.role === 'user').length, 1);
    if (mode === 'abort-after-delta') {
      assert.equal(assistantMessages.at(-1)?.stopReason, 'aborted');
      assert.equal(calls.length, 1);
      assert.equal(providerAbortEvents, 1);
      assert.equal(providerAbortTerminals, 1);
      assert.equal(executed.length, 0);
      assert.equal(textDeltas.join(''), 'partial-before-abort');
      assert.equal(events.filter((event) => event.type === 'message_end' && event.message.role === 'assistant').length, 1);
      assert.equal(events.filter((event) => event.type === 'turn_end').length, 1);
    } else {
      // I adjudication: Pi enters a second internal loop turn, then the public
      // ModelRuntime rejects the already-aborted signal before provider dispatch.
      // Preserve this raw SDK result; MA cancellation must use its recorded Turn
      // cancellation, never this message text as a remote stop receipt.
      assert.equal(assistantMessages.at(-1)?.stopReason, 'error');
      assert.equal(assistantMessages.at(-1)?.errorMessage, 'This operation was aborted');
      assert.equal(toolAbortEvents, 1);
      assert.equal(toolCompletionAfterAbort, true);
      assert.deepEqual(toolOrder, ['first-start', 'first-end']);
      assert.deepEqual(executed.map((entry) => entry.toolCallId), ['pi-call-first']);
      const lateResults = session.messages.filter((entry) => entry.role === 'toolResult');
      assert.equal(lateResults.length, 1);
      assert.equal(lateResults[0].toolCallId, 'pi-call-first');
      assert.equal(events.filter((event) => event.type === 'tool_execution_start').length, 1);
      assert.equal(events.filter((event) => event.type === 'tool_execution_end').length, 1);
    }
    abortEvidence.agentEndEvents = events.filter((event) => event.type === 'agent_end').length;
    abortEvidence.agentSettledEvents = events.filter((event) => event.type === 'agent_settled').length;
    assert.equal(abortEvidence.agentSettledEvents, 1, 'one SDK run must settle once');
    abortEvidence.turnEndEvents = events.filter((event) => event.type === 'turn_end').length;
    abortEvidence.assistantMessageEnds = events.filter((event) => event.type === 'message_end' && event.message.role === 'assistant').length;
  }
  assert.equal(networkAttempts.length, 0, `SDK attempted network access: ${networkAttempts.join(',')}`);
  const sentinelRoots = [
    path.join(cwd, '.pi'), path.join(cwd, '.agents'), path.join(cwd, 'AGENTS.md'),
    path.join(agentDir, 'SYSTEM.md'), path.join(agentDir, 'APPEND_SYSTEM.md'),
    path.join(agentDir, 'extensions'), path.join(agentDir, 'skills'), path.join(agentDir, 'auth.json'),
    path.join(scratch, 'home', '.agents'), path.join(scratch, 'home', '.pi'),
  ];
  const sentinelReads = fileReads.filter((filename) => sentinelRoots.some((root) => filename === root || filename.startsWith(`${root}${path.sep}`)));
  assert.deepEqual(sentinelReads, [], `SDK discovered an unlisted resource: ${sentinelReads.join(',')}`);
  assert.equal(fs.existsSync(path.join(scratch, 'sentinel-executed')), false);
  assert.ok(!JSON.stringify(session.messages).includes('MA_PI_SENTINEL_'));
  console.log(JSON.stringify({
    ok: true, mode, evidenceLevel: 'protocol_fixture', node: process.version, executable: process.execPath,
    calls: calls.length, callbackMaxRetries: calls.map((call) => call.maxRetries),
    toolOrder, executed, text: textDeltas.join(''), assistantUsage: assistantMessages.map((entry) => entry.usage),
    toolResults: session.messages.filter((entry) => entry.role === 'toolResult').length,
    promptRejected, lastStopReason: assistantMessages.at(-1)?.stopReason,
    lastErrorMessage: assistantMessages.at(-1)?.errorMessage,
    networkAttempts: networkAttempts.length, sentinelReads: sentinelReads.length,
    readObservations: fileReads.length, personalReadDenied: true, subprocessesDenied: true,
    idleObservationMs: 350, abortEvidence,
    settings: { retry: false, providerMaxRetries: 0, cacheWarming: 'off', analytics: false, installTelemetry: false },
  }));
} finally {
  releaseTool.resolve();
  unsubscribe();
  await session.abort();
  session.dispose();
}

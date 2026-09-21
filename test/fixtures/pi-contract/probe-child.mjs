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
assert.ok(scratch && ['success', 'error-before-start', 'error-after-output'].includes(mode));
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
let firstCompleted = false;
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
  calls.push({ messages: snapshot, maxRetries: options?.maxRetries });
  queueMicrotask(() => {
    const message = messageFor(model, calls.length > 1);
    try {
      assert.equal(options?.maxRetries, 0);
      assert.ok(!JSON.stringify(snapshot).includes('MA_PI_SENTINEL_'));
      if (mode !== 'success') {
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
    await delay(25);
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
  }
});
let promptRejected = false;
try {
  assert.deepEqual(session.getActiveToolNames().sort(), ['fixture_first', 'fixture_second']);
  try {
    await session.prompt(mode === 'success' ? 'Run both fixture tools in sequence.' : 'Return the fixture failure.', {
      expandPromptTemplates: false, images: mode === 'success' ? [image] : undefined,
    });
  } catch { promptRejected = true; }
  assert.equal(callbackErrors.length, 0, callbackErrors.map(String).join('\n'));
  const beforeIdle = calls.length;
  await delay(350);
  assert.equal(calls.length, beforeIdle, 'SDK added a hidden retry or cache-warming callback');
  assert.equal(events.some((event) => event.type === 'auto_retry_start'), false);
  const assistantMessages = session.messages.filter((entry) => entry.role === 'assistant');
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
  } else {
    assert.equal(calls.length, 1);
    assert.equal(executed.length, 0);
    assert.equal(assistantMessages.at(-1)?.stopReason, 'error');
    assert.equal(assistantMessages.at(-1)?.errorMessage, '503 fixture unavailable');
    assert.equal(textDeltas.join(''), mode === 'error-after-output' ? 'partial-before-error' : '');
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
    networkAttempts: networkAttempts.length, sentinelReads: sentinelReads.length,
    readObservations: fileReads.length, personalReadDenied: true, subprocessesDenied: true,
    idleObservationMs: 350, settings: { retry: false, providerMaxRetries: 0, cacheWarming: 'off', analytics: false, installTelemetry: false },
  }));
} finally {
  unsubscribe();
  await session.abort();
  session.dispose();
}

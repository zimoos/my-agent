import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openMaSession } from 'my-agent/host';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const root = process.env.MA_HISTORY_SCRATCH;
const mode = process.env.MA_HISTORY_MODE;
let modelCalls = 0, toolCalls = 0, networkCalls = 0, getterCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('NETWORK_FORBIDDEN'); };
const bootstrap = {
  schemaVersion: 2, kind: 'ma.runtime.bootstrap',
  scope: { maSessionId: 'session-one', workspaceId: 'workspace-one', canonicalCwd: root, hostIdentity: 'host-one', providerProfileId: 'profile-one' },
  sessionDirectory: join(root, 'session'), agentDirectory: join(root, 'agent'),
  config: { model: { provider: 'openai', model: 'fixture-model', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'unused-fixture-secret' },
    mcpServers: { workspace: { command: 'never-launched' } } },
  capability: { id: 'cap-one', providerProfileId: 'profile-one', providerId: 'fixture-provider', modelId: 'fixture-model',
    input: ['text'], tools: true, reasoning: false, contextWindow: 8192, maxOutputTokens: 1024, cancellation: 'local' },
  resources: { skillDirectories: [], instructionFiles: [], extensions: ['ma-model-purpose', 'ma-resources', 'ma-tools'] },
  hostControl: { transport: 'local', protocolVersion: 2 },
};
const host = {
  async registerTurn() {}, async revokeTurn() {}, async receiptComplete() {},
  async prepareModel({request, requestRevision}) { return { supplierRequestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    requestRevision, providerProfileId: 'profile-one', modelId: 'fixture-model', capabilitySnapshotId: 'cap-one' }; },
  async authorizeTool() { return { executionId: 'exec-one', decision: 'allow', permissionScopeHash: 'a'.repeat(64) }; },
  async queryExecution() { throw new Error('RECOVERY_QUERY_FORBIDDEN'); },
};
const runtime = { client: {}, policy: { requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000, maxRetries: 0 },
  async createChatCompletion() { throw new Error('NON_STREAM_FORBIDDEN'); },
  async createStreamingChatCompletion(request) {
    modelCalls++; assert.ok(modelCalls <= 2);
    const first = modelCalls === 1;
    const base = { id: 'response-one', object: 'chat.completion.chunk', created: 1, model: 'fixture-model' };
    return (async function* () {
      yield { ...base, choices: [{ index: 0, delta: first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'tool-one',
        type: 'function', function: { name: request.tools[0].function.name, arguments: '{}' } }] } : { role: 'assistant', content: 'Read completed.' }, finish_reason: null }] };
      yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] };
      yield { ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } };
    })();
  },
};
const connections = [{ name: 'workspace', tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }],
  async call() { toolCalls++; return { content: 'FULL_ORIGINAL_TOOL_RESULT', isError: false, structuredContent: { status: 'succeeded', stopConfirmed: true } }; },
  async close() { throw new Error('BORROWED_CONNECTION_CLOSE_FORBIDDEN'); } }];
let session;
const savedBranch = SessionManager.prototype.getBranch, savedEntries = SessionManager.prototype.getEntries;
try {
  session = await openMaSession({ bootstrap, host, providerRuntime: runtime, connections });
  const outcome = await session.prompt({ content: [{ type: 'text', text: 'Read the file and report.' }] },
    { sessionId: 'session-one', turnId: 'turn-one', epoch: 1, operationId: 'operation-one', stageId: 'stage-one', budgetRef: 'budget-one' });
  assert.equal(outcome.status, 'completed'); assert.equal(modelCalls, 2); assert.equal(toolCalls, 1);
  if (mode === 'valid') {
    // No SDK instrumentation on the positive path: actual Pi tool results contain optional usage: undefined.
    for (const all of [false, true]) {
      const history = session.inspectHistory({ all });
      const tool = history.find(entry => entry.type === 'message' && entry.message.role === 'toolResult');
      assert.ok(tool); assert.equal(Object.hasOwn(tool.message, 'usage'), false);
      assert.equal(tool.message.content[0].text, 'FULL_ORIGINAL_TOOL_RESULT');
      assert.equal(tool.message.toolCallId, 'tool-one');
      const assistant = history.find(entry => entry.type === 'message' && entry.message.role === 'assistant');
      assert.ok(assistant.message.usage); // Required assistant usage is retained.
      tool.message.content[0].text = 'MUTATED_READ_VIEW';
      assert.equal(JSON.stringify(session.inspectHistory({ all })).includes('MUTATED_READ_VIEW'), false);
    }
    await session.close(); session = await openMaSession({ bootstrap: { ...bootstrap, resumeSessionId: 'session-one' }, host, providerRuntime: runtime, connections });
    assert.equal((await session.recover()).status, 'ready');
    assert.ok(JSON.stringify(session.inspectHistory()).includes('FULL_ORIGINAL_TOOL_RESULT'));
  } else {
    // Fault injection only at Pi's PUBLIC read interface. The MA facade and validators remain real.
    const alter = entries => {
      const copy = structuredClone(entries);
      const target = copy.find(entry => entry.type === 'message' && entry.message.role === 'toolResult');
      const message = target.message;
      const malicious = {
        'required-undefined': () => { message.toolCallId = undefined; },
        'unknown-undefined': () => { message.unrecognized = undefined; },
        'array-undefined': () => { message.content.push(undefined); },
        'array-hole': () => { message.content.length++; },
        'function': () => { message.details = { sensitive: () => 'PRIVATE_HISTORY_SECRET' }; },
        'bigint': () => { message.details = { sensitive: 1n }; },
        'prototype': () => { message.details = Object.create({ sensitive: 'PRIVATE_HISTORY_SECRET' }); },
        'accessor': () => { Object.defineProperty(message, 'usage', { enumerable: true, configurable: true, get() { getterCalls++; throw new Error('PRIVATE_HISTORY_SECRET'); } }); },
        'toJSON': () => { message.details = { toJSON() { getterCalls++; return 'PRIVATE_HISTORY_SECRET'; } }; },
        'symbol': () => { message.details = { [Symbol('PRIVATE_HISTORY_SECRET')]: true }; },
        'nonfinite': () => { message.details = { sensitive: Infinity }; },
        'cycle': () => { message.details = {}; message.details.self = message.details; },
        'assistant-required-usage': () => { copy.find(entry => entry.type === 'message' && entry.message.role === 'assistant').message.usage = undefined; },
      };
      assert.ok(malicious[mode]); malicious[mode](); return copy;
    };
    SessionManager.prototype.getBranch = function (...args) { return alter(savedBranch.apply(this, args)); };
    SessionManager.prototype.getEntries = function (...args) { return alter(savedEntries.apply(this, args)); };
    for (const all of [false, true]) assert.throws(() => session.inspectHistory({ all }), { message: 'MA_INVALID_JSON' });
    assert.equal(getterCalls, 0);
  }
  assert.equal(modelCalls, 2); assert.equal(toolCalls, 1); assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ ok: true, mode, publicApi: 'my-agent/host', modelCalls, toolCalls, networkCalls, getterCalls }));
} finally {
  SessionManager.prototype.getBranch = savedBranch; SessionManager.prototype.getEntries = savedEntries;
  await session?.close();
}

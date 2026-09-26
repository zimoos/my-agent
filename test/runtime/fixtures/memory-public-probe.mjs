import assert from 'node:assert/strict';
import { readFile, writeFile, chmod, lstat, rename, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openMaSession } from 'my-agent/host';

const root = process.env.MA_MEMORY_SCRATCH;
const mode = process.env.MA_MEMORY_MODE;
const directory = join(root, 'session');
const filename = join(directory, 'memory-control.json');
let modelCalls = 0;
let networkCalls = 0;
let mutations = 0;
let providerReadyCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('NETWORK_FORBIDDEN'); };
const privateBody = 'PRIVATE_CONVERSATION_BODY_7a933b_DO_NOT_PERSIST';
const state = { memory: { profile_id: 'memory-profile', patchset_revision: 1,
  last_verified_at: '2026-08-06T08:00:00.000Z', active_memory_patch_ids: ['patch-one'],
  requested_memory_patch_ids: null, status: 'mounted' } };
const memories = [1, 2].map(n => ({ id: `memory-${n}`, name: `Memory ${n}`, head_patch_id: n === 1 ? 'patch-one' : 'patch-two', base_model_id: 'fixture-model' }));
const patches = memories.map(m => ({ id: m.head_patch_id, memory_id: m.id, version: '1', mountable: true, base_model_id: 'fixture-model' }));
const controller = {
  getCapabilities: () => ({ memoryV2: true }),
  listMemories: async () => memories,
  listPatches: async () => patches,
  listProfiles: async () => [{ id: 'memory-profile' }],
  mountMemories: async () => { mutations++; state.memory.requested_memory_patch_ids = ['patch-one-v2']; state.memory.status = 'pending'; },
  startBatchIntake: async () => { mutations++; return { batch_id: 'batch-one', targets: [
    { status: 'completed', memory_id: 'memory-1', output_patch_id: 'patch-one-v2' },
    { status: 'failed', memory_id: 'memory-2', error: { message: privateBody } },
  ] }; },
  applyCompletedBatch: async () => { mutations++; state.memory.requested_memory_patch_ids = ['patch-one-v2']; state.memory.status = 'pending'; },
};
const providerRuntime = {
  client: {}, policy: { requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000, maxRetries: 0 },
  ready: async () => { providerReadyCalls++; }, getProviderState: () => state, getMemoryController: () => controller,
  createChatCompletion: async () => { modelCalls++; throw new Error('MODEL_FORBIDDEN'); },
  createStreamingChatCompletion: async () => { modelCalls++; throw new Error('MODEL_FORBIDDEN'); },
};
const host = Object.fromEntries(['registerTurn', 'revokeTurn', 'prepareModel', 'authorizeTool', 'queryExecution', 'receiptComplete']
  .map(method => [method, async () => { throw new Error('HOST_DISPATCH_FORBIDDEN'); }]));
const bootstrap = {
  schemaVersion: 2, kind: 'ma.runtime.bootstrap',
  scope: { maSessionId: 'session-one', workspaceId: 'workspace-one', canonicalCwd: root, hostIdentity: 'host-one', providerProfileId: 'profile-one' },
  sessionDirectory: directory, agentDirectory: join(root, 'agent'),
  config: { model: { provider: 'agora', model: 'fixture-model', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture-not-a-secret',
    agoraMemory: { memoryProfile: 'memory-profile' }, agoraRuntime: { dataRoot: join(root, 'agora-data') } }, mcpServers: {} },
  capability: { id: 'cap-one', providerProfileId: 'profile-one', providerId: 'fixture-provider', modelId: 'fixture-model',
    input: ['text'], tools: false, reasoning: false, contextWindow: 8192, maxOutputTokens: 1024, cancellation: 'local' },
  resources: { skillDirectories: [], instructionFiles: [], extensions: ['ma-model-purpose', 'ma-resources'] },
  hostControl: { transport: 'acp', protocolVersion: 2 },
};
const open = (resume = false) => openMaSession({ bootstrap: { ...bootstrap, ...(resume ? { resumeSessionId: 'session-one' } : {}) }, host, providerRuntime, connections: [] });
let session;
try {
  session = await open();
  const live = await session.memory(mode === 'private-report'
    ? { action: 'internalize', sessionId: 'session-one', moduleIds: ['memory-1', 'memory-2'], scope: 'project' }
    : { action: 'mount', sessionId: 'session-one', ids: ['memory-1'] });
  assert.equal(live.state, 'pending-verification');
  if (mode === 'private-report') assert.equal(live.operationReport.failures[0].message, privateBody);
  await session.close(); session = undefined;
  const original = await readFile(filename, 'utf8');
  const record = JSON.parse(original);
  assert.equal((await lstat(filename)).mode & 0o7777, 0o600);
  assert.equal(record.pending.report, null);
  assert.equal(record.schemaVersion, 2);
  assert.match(record.providerIdentitySha256, /^[a-f0-9]{64}$/);
  assert.equal(original.includes(privateBody), false);
  assert.equal(original.includes(bootstrap.config.model.agoraRuntime.dataRoot), false);
  assert.equal(original.includes(bootstrap.config.model.apiKey), false);
  assert.equal(original.includes(bootstrap.config.model.model), false);
  const beforeMutations = mutations;
  const beforeReadyCalls = providerReadyCalls;
  if (mode === 'equivalent-path') bootstrap.config.model.agoraRuntime.dataRoot = `${root}/unused/../agora-data/.`;
  if (mode === 'equivalent-symlink') {
    await mkdir(join(root, 'agora-data'));
    await symlink(join(root, 'agora-data'), join(root, 'data-alias'));
    bootstrap.config.model.agoraRuntime.dataRoot = join(root, 'data-alias');
  }
  if (mode === 'created-data-root') await mkdir(join(root, 'agora-data'));
  if (mode === 'credential-rotation') bootstrap.config.model.apiKey = 'rotated-fixture-secret';
  if (['valid', 'private-report', 'equivalent-path', 'equivalent-symlink', 'created-data-root', 'credential-rotation'].includes(mode)) {
    session = await open(true);
    const recovered = await session.memory({ action: 'state', sessionId: 'session-one' });
    assert.equal(recovered.state, 'pending-verification');
    assert.equal(recovered.operationReport, null);
    assert.equal(recovered.pendingOperation, mode === 'private-report' ? 'internalize' : 'mount');
    assert.equal(mutations, beforeMutations);
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).providerIdentitySha256, record.providerIdentitySha256);
    state.memory.patchset_revision = 2;
    state.memory.last_verified_at = '2026-08-06T08:00:01.000Z';
    state.memory.active_memory_patch_ids = ['patch-one-v2'];
    state.memory.requested_memory_patch_ids = null;
    state.memory.status = 'mounted';
    memories[0].head_patch_id = 'patch-one-v2';
    patches.push({ ...patches[0], id: 'patch-one-v2', version: '2' });
    assert.equal((await session.memory({ action: 'state', sessionId: 'session-one' })).state, 'mounted');
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).pending, null);
  } else {
    const edits = {
      'schema-version': () => { record.schemaVersion = 999; },
      'extra-record-field': () => { record.message = privateBody; },
      'missing-record-field': () => { delete record.uncertain; },
      'extra-pending-field': () => { record.pending.message = privateBody; },
      'missing-pending-field': () => { delete record.pending.expectedActivePatchIds; },
      'invalid-pending': () => { record.pending = []; },
      'invalid-operation': () => { record.pending.operation = ['mount']; },
      'invalid-boolean': () => { record.pending.requiresVerification = 'true'; },
      'invalid-revision': () => { record.pending.baselineRevision = -1; },
      'invalid-timestamp': () => { record.pending.baselineVerifiedAt = privateBody; },
      'invalid-patch-ids': () => { record.pending.expectedActivePatchIds = ['patch-one', 'patch-one']; },
      'non-null-report': () => { record.pending.report = { message: privateBody }; },
      'wrong-session': () => { record.sessionId = 'session-other'; },
      'wrong-profile': () => { record.profileId = 'profile-other'; },
      'legacy-unbound': () => { record.schemaVersion = 1; delete record.providerIdentitySha256; },
      'invalid-provider-digest': () => { record.providerIdentitySha256 = 'not-a-digest'; },
    };
    if (edits[mode]) { edits[mode](); await writeFile(filename, JSON.stringify(record)); }
    if (mode === 'permissions') await chmod(filename, 0o644);
    if (mode === 'special-permissions') await chmod(filename, 0o4600);
    if (mode === 'malformed-json') await writeFile(filename, '{');
    if (mode === 'symlink') { await rename(filename, `${filename}.original`); await symlink(`${filename}.original`, filename); }
    if (mode === 'directory') { await rename(filename, `${filename}.original`); await mkdir(filename, { mode: 0o700 }); }
    if (mode === 'fifo') { await rename(filename, `${filename}.original`); await rename(join(root, 'fixture.fifo'), filename); }
    if (mode === 'model-drift') { bootstrap.config.model.model = 'another-model'; bootstrap.capability.modelId = 'another-model'; }
    if (mode === 'data-root-drift') bootstrap.config.model.agoraRuntime.dataRoot = join(root, 'another-data-root');
    if (mode === 'uncertain') {
      record.uncertain = true;
      await writeFile(filename, JSON.stringify(record));
      session = await open(true);
      assert.equal((await session.memory({ action: 'state', sessionId: 'session-one' })).state, 'failed');
      assert.equal((await session.memory({ action: 'mount', sessionId: 'session-one', ids: ['memory-1'] })).state, 'failed');
    } else {
      let accepted = false;
      await assert.rejects(async () => { session = await open(true); accepted = true; },
        { message: ['wrong-session', 'wrong-profile'].includes(mode) ? 'MA_MEMORY_IDENTITY_MISMATCH'
          : ['model-drift', 'data-root-drift'].includes(mode) ? 'MA_MEMORY_PROVIDER_IDENTITY_MISMATCH' : 'MA_MEMORY_STATE_INVALID' });
      assert.equal(accepted, false);
      assert.equal(providerReadyCalls, beforeReadyCalls);
      if (['model-drift', 'data-root-drift'].includes(mode)) assert.equal(await readFile(filename, 'utf8'), original);
    }
    assert.equal(mutations, beforeMutations);
  }
  assert.equal(modelCalls, 0);
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ mode, publicApi: 'my-agent/host', modelCalls, networkCalls, ok: true }));
} finally { await session?.close(); }

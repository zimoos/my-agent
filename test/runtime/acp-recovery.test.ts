import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { createMaAcpAgent } from '../../src/runtime/acp-agent.js';
import { openMaSession } from '../../src/runtime/ma-session.js';
import { openExecutionJournal } from '../../src/runtime/execution-journal.js';
import { createTurnGate } from '../../src/runtime/turn-gate.js';
import type { ModelCallBinding, TurnScope } from '../../src/runtime/contracts.js';
import type { HostControlPort, MaBootstrapV2 } from '../../src/runtime/public-types.js';
import type { ProviderRuntime } from '../../src/provider/runtime.js';

const sessionId = 'acp-recovery-session';

async function fixture(t: TestContext) {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ma-acp-recovery-')));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const sessionDirectory = path.join(cwd, 'session');
  const bootstrap: MaBootstrapV2 = {
    schemaVersion: 2,
    kind: 'ma.runtime.bootstrap',
    scope: {
      maSessionId: sessionId,
      workspaceId: 'workspace-recovery',
      canonicalCwd: cwd,
      hostIdentity: 'host-recovery',
      providerProfileId: 'profile-recovery',
    },
    sessionDirectory,
    agentDirectory: path.join(cwd, 'agent'),
    config: {
      model: {
        provider: 'openai',
        model: 'offline-recovery-model',
        baseURL: 'http://127.0.0.1:1/v1',
        apiKey: 'unused-test-secret',
      },
      mcpServers: {},
    },
    capability: {
      id: 'capability-recovery',
      providerProfileId: 'profile-recovery',
      providerId: 'fixture-provider',
      modelId: 'offline-recovery-model',
      input: ['text'],
      tools: false,
      reasoning: false,
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      cancellation: 'local',
    },
    resources: {
      skillDirectories: [],
      instructionFiles: [],
      extensions: ['ma-model-purpose', 'ma-resources'],
    },
    hostControl: { transport: 'acp', protocolVersion: 2 },
  };
  const host: HostControlPort = {
    async registerTurn() {},
    async revokeTurn() {},
    async prepareModel({ request, requestRevision }) {
      return {
        supplierRequestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
        requestRevision,
        providerProfileId: bootstrap.scope.providerProfileId,
        modelId: bootstrap.capability.modelId,
        capabilitySnapshotId: bootstrap.capability.id,
      };
    },
    async authorizeTool() {
      return { executionId: 'unused-execution', decision: 'deny', permissionScopeHash: 'a'.repeat(64) };
    },
    async queryExecution(invocation) {
      return { receipt: { executionId: invocation.executionId, source: invocation.source, status: 'unknown', stopConfirmed: false } };
    },
    async receiptComplete() {},
  };
  const providerRuntime = {
    client: {},
    policy: { requestTimeoutMs: 1_000, streamIdleTimeoutMs: 1_000, maxRetries: 0 },
    async createChatCompletion() { throw new Error('MODEL_CALL_FORBIDDEN'); },
    async createStreamingChatCompletion() { throw new Error('MODEL_CALL_FORBIDDEN'); },
  } as unknown as ProviderRuntime;

  const created = await openMaSession({ bootstrap, host, providerRuntime, connections: [] });
  await created.close();

  const turn: TurnScope = {
    sessionId,
    turnId: 'interrupted-turn',
    epoch: 1,
    operationId: 'operation-recovery',
    stageId: 'stage-recovery',
    budgetRef: 'budget-recovery',
  };
  const call: ModelCallBinding = {
    sessionId: turn.sessionId,
    operationId: turn.operationId,
    turnId: turn.turnId,
    epoch: turn.epoch,
    stageId: turn.stageId,
    logicalCallId: 'logical-recovery',
    callId: `call_${'a'.repeat(32)}`,
    providerProfileId: bootstrap.scope.providerProfileId,
    modelId: bootstrap.capability.modelId,
    modelPurpose: 'answer',
    capabilitySnapshotId: bootstrap.capability.id,
    requestRevision: 1,
    requestSha256: 'b'.repeat(64),
  };
  const journal = await openExecutionJournal({
    directory: sessionDirectory,
    sessionId,
    ownerId: 'qa-unresolved-model',
    hostIdentity: bootstrap.scope.hostIdentity,
  });
  const gate = await createTurnGate({ sessionId, journal });
  await gate.register(turn);
  await gate.prepareModel(call);
  await gate.markModelDispatching(call.callId);
  await journal.close();

  return {
    cwd,
    call,
    host,
    providerRuntime,
    bootstrap: { ...bootstrap, resumeSessionId: sessionId },
    nextTurn: { ...turn, turnId: 'turn-after-load', epoch: 2, stageId: 'stage-after-load' },
  };
}

test('ACP keeps a paused recovered session controllable while fencing ordinary prompts', async (t) => {
  const setup = await fixture(t);
  const notifications: Array<{ method: string; params: unknown }> = [];
  const connection = {
    async sessionUpdate() {},
    async extNotification(method: string, params: unknown) { notifications.push({ method, params }); },
  } as acp.AgentSideConnection;
  let resolvedTurns = 0;
  const agent = createMaAcpAgent(connection, {
    bootstrap: setup.bootstrap,
    host: setup.host,
    providerRuntime: setup.providerRuntime,
    connections: [],
    async resolveTurn() { resolvedTurns += 1; return setup.nextTurn; },
  });
  t.after(() => agent.shutdown());

  assert.deepEqual(await agent.loadSession({
    cwd: setup.cwd,
    sessionId,
    mcpServers: [],
  }), {
    _meta: {
      ma: {
        recovery: {
          status: 'paused',
          sessionId,
          unresolvedExecutionIds: [],
          unresolvedCallIds: [setup.call.callId],
          reason: 'MA_RECOVERY_EXECUTION_UNRESOLVED',
        },
      },
    },
  });

  await assert.rejects(
    agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'continue' }] }),
    (error: unknown) => {
      const request = error as { code?: number; data?: { ma?: { code?: string } } };
      assert.equal(request.code, -32602);
      assert.equal(request.data?.ma?.code, 'MA_RECOVERY_REQUIRED');
      return true;
    },
  );
  assert.equal(resolvedTurns, 1);

  const recovered = await agent.extMethod('zimoos.com/ma-runtime/v2', {
    sessionId,
    action: 'recover',
  }) as { status?: string; reason?: string; unresolvedCallIds?: string[] };
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.reason, 'MA_RECOVERY_EXECUTION_UNRESOLVED');
  assert.deepEqual(recovered.unresolvedCallIds, [setup.call.callId]);
  assert.ok(notifications.some(notification => notification.method === 'zimoos.com/ma-runtime/v2'));
});

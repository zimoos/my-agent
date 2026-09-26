/** Fixed contract data. No production helper computes these expected values. */
export const sessionScopeVector = {
  maSessionId: 'ma-session-a',
  workspaceId: 'workspace-a',
  canonicalCwd: '/ma-next-fixture/workspace-a',
  hostIdentity: 'host-a',
  providerProfileId: 'profile-a',
};

export const turnScopeVector = {
  sessionId: 'ma-session-a',
  turnId: 'turn-a',
  epoch: 7,
  operationId: `op_${'a'.repeat(32)}`,
  stageId: `stage_${'b'.repeat(32)}`,
  budgetRef: 'budget-a',
};

export const modelContextVector = {
  operationId: turnScopeVector.operationId,
  stageId: turnScopeVector.stageId,
  logicalCallId: 'logical-a',
  callId: `call_${'c'.repeat(32)}`,
  missionId: 'mission-a',
  turnId: 'turn-a',
  epoch: 7,
  sessionId: 'ma-session-a',
  providerProfileId: 'profile-a',
  modelId: 'fixture-model-a',
  modelPurpose: 'answer' as const,
  capabilitySnapshotId: 'capability-a',
  signal: new AbortController().signal,
};

export const invocationVector = {
  executionId: 'execution-a',
  toolCallId: 'pi-tool-a',
  sessionId: 'ma-session-a',
  operationId: turnScopeVector.operationId,
  turnId: 'turn-a',
  epoch: 7,
  source: { serverId: 'server-a', toolName: 'tool-a' },
  argsSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  permissionScopeHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
};

export const receiptVector = {
  executionId: 'execution-a',
  source: { serverId: 'server-a', toolName: 'tool-a' },
  status: 'unknown' as const,
  stopConfirmed: false,
};

/** Journal expectations are fixed independently of the writer implementation. */
export function journalTurnVector(index = 1) {
  return {
    schemaVersion: 1 as const,
    eventId: `event-${index}`,
    sessionId: 'ma-session-a',
    operationId: turnScopeVector.operationId,
    turnId: 'turn-a',
    epoch: 7,
    at: '2026-09-21T00:00:00.000Z',
    kind: 'turn.registered' as const,
    turn: { ...turnScopeVector },
  };
}

export function journalExecutionVector(index = 1) {
  const { turn: _turn, ...base } = journalTurnVector(index);
  return {
    ...base,
    kind: 'execution.receipt' as const,
    invocation: { ...invocationVector, source: { ...invocationVector.source } },
    receipt: { ...receiptVector, source: { ...receiptVector.source } },
  };
}

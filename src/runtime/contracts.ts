/** Data contracts only; these types do not validate or authorize their values. */
export interface SessionScope {
  maSessionId: string;
  workspaceId: string;
  canonicalCwd: string;
  hostIdentity: string;
  providerProfileId: string;
}

export interface TurnScope {
  sessionId: string;
  turnId: string;
  epoch: number;
  operationId: string;
  stageId: string;
  budgetRef: string;
}

export interface ModelCallContext {
  operationId: string;
  stageId: string;
  logicalCallId: string;
  callId: string;
  missionId?: string;
  turnId: string;
  epoch: number;
  sessionId: string;
  providerProfileId: string;
  modelId: string;
  modelPurpose: 'answer' | 'tool_loop' | 'compaction' | 'branch_summary';
  capabilitySnapshotId: string;
  signal: AbortSignal;
}

export interface Invocation {
  executionId: string;
  toolCallId: string;
  sessionId: string;
  operationId: string;
  turnId: string;
  epoch: number;
  source: { serverId: string; toolName: string };
  argsSha256: string;
  permissionScopeHash: string;
}

export type ToolReceiptStatus =
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled_not_sent'
  | 'unknown';

export interface ToolReceipt {
  executionId: string;
  source: { serverId: string; toolName: string };
  status: ToolReceiptStatus;
  resultRef?: string;
  stopConfirmed: boolean;
  evidenceRef?: string;
}

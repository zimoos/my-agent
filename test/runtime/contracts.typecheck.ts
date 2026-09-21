import type {
  SessionScope,
  TurnScope,
  ModelCallContext,
  Invocation,
  ToolReceiptStatus,
  ToolReceipt,
  ModelCallBinding,
  ModelCallReceipt,
  InvocationOrigin,
  TurnCompletion,
} from '../../src/runtime/contracts.js';
import {
  sessionScopeVector,
  turnScopeVector,
  modelContextVector,
  invocationVector,
  receiptVector,
} from './fixtures/batch1-vectors.js';

// Compile-only contract gate. It does not claim runtime validation or authority.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type ExpectedSessionScope = {
  maSessionId: string; workspaceId: string; canonicalCwd: string;
  hostIdentity: string; providerProfileId: string;
};
type ExpectedTurnScope = {
  sessionId: string; turnId: string; epoch: number;
  operationId: string; stageId: string; budgetRef: string;
};
type ExpectedModelCallContext = {
  operationId: string; stageId: string; logicalCallId: string; callId: string;
  missionId?: string; turnId: string; epoch: number; sessionId: string;
  providerProfileId: string; modelId: string;
  modelPurpose: 'answer' | 'tool_loop' | 'compaction' | 'branch_summary';
  capabilitySnapshotId: string; signal: AbortSignal;
};
type ExpectedInvocation = {
  executionId: string; toolCallId: string; sessionId: string;
  operationId: string; turnId: string; epoch: number;
  source: { serverId: string; toolName: string };
  argsSha256: string; permissionScopeHash: string;
};
type ExpectedReceiptStatus = 'succeeded' | 'failed' | 'denied'
  | 'cancelled_not_sent' | 'unknown';
type ExpectedReceipt = {
  executionId: string; source: { serverId: string; toolName: string };
  status: ExpectedReceiptStatus; resultRef?: string;
  stopConfirmed: boolean; evidenceRef?: string;
};

export type SessionShape = Expect<Equal<SessionScope, ExpectedSessionScope>>;
export type TurnShape = Expect<Equal<TurnScope, ExpectedTurnScope>>;
export type ModelShape = Expect<Equal<ModelCallContext, ExpectedModelCallContext>>;
export type InvocationShape = Expect<Equal<Invocation, ExpectedInvocation>>;
export type ReceiptStatusShape = Expect<Equal<ToolReceiptStatus, ExpectedReceiptStatus>>;
export type ReceiptShape = Expect<Equal<ToolReceipt, ExpectedReceipt>>;

sessionScopeVector satisfies SessionScope;
turnScopeVector satisfies TurnScope;
modelContextVector satisfies ModelCallContext;
invocationVector satisfies Invocation;
receiptVector satisfies ToolReceipt;

for (const modelPurpose of ['answer', 'tool_loop', 'compaction', 'branch_summary'] as const) {
  ({ ...modelContextVector, modelPurpose }) satisfies ModelCallContext;
}
for (const status of ['succeeded', 'failed', 'denied', 'cancelled_not_sent', 'unknown'] as const) {
  ({ ...receiptVector, status }) satisfies ToolReceipt;
}
const { missionId: _missionId, ...withoutMission } = modelContextVector;
withoutMission satisfies ModelCallContext;
({ ...receiptVector, resultRef: 'result-a', evidenceRef: 'evidence-a' }) satisfies ToolReceipt;

const { operationId: _operationId, ...withoutOperation } = turnScopeVector;
// @ts-expect-error A Turn must retain its operation; creating another Turn is not a budget reset.
withoutOperation satisfies TurnScope;
const { signal: _signal, ...withoutSignal } = modelContextVector;
// @ts-expect-error Every model request receives a real cancellation signal.
withoutSignal satisfies ModelCallContext;
// @ts-expect-error An engine-invented purpose cannot bypass the four fixed paths.
({ ...modelContextVector, modelPurpose: 'background_warmup' }) satisfies ModelCallContext;
// @ts-expect-error Model credentials do not belong to the model call context.
({ ...modelContextVector, apiKey: 'DO_NOT_PERSIST_SECRET_A' }) satisfies ModelCallContext;
// @ts-expect-error A Pi tool ID and model call ID do not substitute for durable execution identity.
({ toolCallId: 'pi-tool-a', callId: 'call-a' }) satisfies Invocation;
// @ts-expect-error Raw arguments are not part of the durable invocation contract.
({ ...invocationVector, arguments: { secret: 'DO_NOT_PERSIST_SECRET_A' } }) satisfies Invocation;
// @ts-expect-error A result does not certify a Mission as accepted.
({ ...receiptVector, status: 'accepted' }) satisfies ToolReceipt;
// @ts-expect-error Missing remote-stop evidence cannot be erased from the receipt shape.
({ executionId: 'execution-a', source: invocationVector.source, status: 'unknown' }) satisfies ToolReceipt;
// @ts-expect-error Host identity remains in SessionScope, not model-owned fields on TurnScope.
({ ...turnScopeVector, hostIdentity: 'host-b' }) satisfies TurnScope;
// @ts-expect-error Runtime contract uses a numeric epoch, not an arbitrary string.
({ ...turnScopeVector, epoch: '7' }) satisfies TurnScope;

// R2a only adds serializable bindings; runtime value checks belong to the journal.
type ExpectedModelCallBinding = Omit<ExpectedModelCallContext, 'signal'> & {
  requestRevision: number; requestSha256: string;
};
type ExpectedModelCallReceipt = {
  callId: string; status: 'succeeded' | 'failed' | 'not_sent' | 'unknown'; evidenceRef?: string;
};
export type R2BindingShape = Expect<Equal<ModelCallBinding, ExpectedModelCallBinding>>;
export type R2ReceiptShape = Expect<Equal<ModelCallReceipt, ExpectedModelCallReceipt>>;
export type R2OriginShape = Expect<Equal<InvocationOrigin, { callId: string; logicalCallId: string }>>;
export type R2CompletionShape = Expect<Equal<TurnCompletion, { sessionId: string; turnId: string; epoch: number; journalSeq: number }>>;
const binding = { ...withoutSignal, requestRevision: 1, requestSha256: 'a'.repeat(64) } satisfies ModelCallBinding;
const { requestRevision: _revision, ...missingRevision } = binding;
// @ts-expect-error Rebuilt final requests retain their revision.
missingRevision satisfies ModelCallBinding;
// @ts-expect-error AbortSignal is not persisted in a model binding.
({ ...binding, signal: modelContextVector.signal }) satisfies ModelCallBinding;
// @ts-expect-error A model result never means Mission acceptance.
({ callId: binding.callId, status: 'accepted' }) satisfies ModelCallReceipt;
// @ts-expect-error Tool and model identities remain separate contracts.
({ executionId: 'execution-a', logicalCallId: 'logical-a' }) satisfies InvocationOrigin;
// @ts-expect-error Completion must identify its durable journal entry.
({ sessionId: 'session-a', turnId: 'turn-a', epoch: 1 }) satisfies TurnCompletion;
for (const status of ['succeeded', 'failed', 'not_sent', 'unknown'] as const) {
  ({ callId: binding.callId, status, evidenceRef: 'fixture-evidence' }) satisfies ModelCallReceipt;
}

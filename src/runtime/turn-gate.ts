import { randomUUID } from 'node:crypto';
import type {
  Invocation, InvocationOrigin, ModelCallBinding, ModelCallReceipt, ToolReceipt,
  TurnCompletion, TurnScope,
} from './contracts.js';
import type {
  ExecutionJournal,
  ExecutionJournalEntry,
  ExecutionJournalInput,
} from './execution-journal.js';

export interface DispatchPermit {
  sessionId: string;
  turnId: string;
  epoch: number;
  executionId: string;
  journalSeq: number;
}

export interface TurnGateSnapshot {
  sessionId: string;
  state: 'ready' | 'active' | 'paused';
  currentTurn: TurnScope | null;
  lastEpoch: number;
  inFlightExecutionIds: string[];
  inFlightCallIds: string[];
}

export interface TurnGate {
  register(turn: TurnScope): Promise<void>;
  markDispatching(invocation: Invocation): Promise<DispatchPermit>;
  prepareModel(call: ModelCallBinding): Promise<void>;
  markModelDispatching(callId: string): Promise<{ callId: string; journalSeq: number }>;
  recordModelReceipt(callId: string, receipt: ModelCallReceipt): Promise<void>;
  bindInvocation(invocation: Invocation, origin: InvocationOrigin): Promise<void>;
  recordReceipt(invocation: Invocation, receipt: ToolReceipt): Promise<void>;
  complete(turnId: string): Promise<TurnCompletion>;
  stop(turnId: string): Promise<{ revokedEpoch: number; inFlightExecutionIds: string[] }>;
  snapshot(): TurnGateSnapshot;
}

type TurnErrorCode =
  | 'TURN_INVALID_SCOPE'
  | 'TURN_CONFLICT'
  | 'TURN_REVOKED'
  | 'TURN_NOT_FOUND'
  | 'TURN_DUPLICATE_EXECUTION'
  | 'TURN_PAUSED'
  | 'TURN_JOURNAL_FAILED'
  | 'TURN_RECOVERY_REQUIRED'
  | 'TURN_UNKNOWN_CALL'
  | 'TURN_DUPLICATE_CALL'
  | 'TURN_MODEL_UNRESOLVED'
  | 'TURN_ORIGIN_MISMATCH'
  | 'TURN_RECEIPT_CONFLICT'
  | 'TURN_UNRESOLVED'
  | 'TURN_COMPLETED';

type ExecutionScope = Pick<Invocation, 'sessionId' | 'operationId' | 'turnId' | 'epoch'>;
interface PendingReceipt<T> {
  value: T;
  promise: Promise<void>;
}
interface ModelAttemptState {
  call: ModelCallBinding;
  prepared: boolean;
  dispatchRequested: boolean;
  dispatching: boolean;
  unknownPending: boolean;
  receipt?: ModelCallReceipt;
  pendingReceipt?: PendingReceipt<ModelCallReceipt>;
}
interface BoundExecutionState {
  invocation: Invocation;
  origin: InvocationOrigin;
  bound: boolean;
  binding: Promise<void>;
  receipt?: ToolReceipt;
  pendingReceipt?: PendingReceipt<ToolReceipt>;
}

export class TurnGateError extends Error {
  constructor(public readonly code: TurnErrorCode) {
    super(code);
    this.name = 'TurnGateError';
  }
}

function invalid(): never {
  throw new TurnGateError('TURN_INVALID_SCOPE');
}

function object(
  value: unknown, allowed: readonly string[], optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (allowed.some(key => !optional.includes(key) && !Object.hasOwn(value, key))) invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
  }
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) invalid();
  return value;
}

function epoch(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}

function copyTurn(value: unknown): TurnScope {
  const data = object(value, ['sessionId', 'turnId', 'epoch', 'operationId', 'stageId', 'budgetRef']);
  return {
    sessionId: id(data.sessionId), turnId: id(data.turnId), epoch: epoch(data.epoch),
    operationId: id(data.operationId), stageId: id(data.stageId), budgetRef: id(data.budgetRef),
  };
}

function copyInvocation(value: unknown): Invocation {
  const data = object(value, ['executionId', 'toolCallId', 'sessionId', 'operationId', 'turnId',
    'epoch', 'source', 'argsSha256', 'permissionScopeHash']);
  const source = object(data.source, ['serverId', 'toolName']);
  return {
    executionId: id(data.executionId), toolCallId: id(data.toolCallId),
    sessionId: id(data.sessionId), operationId: id(data.operationId), turnId: id(data.turnId),
    epoch: epoch(data.epoch), source: { serverId: id(source.serverId), toolName: id(source.toolName) },
    argsSha256: hash(data.argsSha256), permissionScopeHash: hash(data.permissionScopeHash),
  };
}

function copyModel(value: unknown): ModelCallBinding {
  const data = object(value, ['operationId', 'stageId', 'logicalCallId', 'callId', 'missionId',
    'turnId', 'epoch', 'sessionId', 'providerProfileId', 'modelId', 'modelPurpose',
    'capabilitySnapshotId', 'requestRevision', 'requestSha256'], ['missionId']);
  const purposes = ['answer', 'tool_loop', 'compaction', 'branch_summary'];
  if (typeof data.modelPurpose !== 'string' || !purposes.includes(data.modelPurpose)) invalid();
  return {
    operationId: id(data.operationId), stageId: id(data.stageId),
    logicalCallId: id(data.logicalCallId), callId: id(data.callId),
    ...(Object.hasOwn(data, 'missionId') ? { missionId: id(data.missionId) } : {}),
    turnId: id(data.turnId), epoch: epoch(data.epoch), sessionId: id(data.sessionId),
    providerProfileId: id(data.providerProfileId), modelId: id(data.modelId),
    modelPurpose: data.modelPurpose as ModelCallBinding['modelPurpose'],
    capabilitySnapshotId: id(data.capabilitySnapshotId),
    requestRevision: epoch(data.requestRevision), requestSha256: hash(data.requestSha256),
  };
}

function copyModelReceipt(value: unknown): ModelCallReceipt {
  const data = object(value, ['callId', 'status', 'evidenceRef'], ['evidenceRef']);
  const statuses = ['succeeded', 'failed', 'not_sent', 'unknown'];
  if (typeof data.status !== 'string' || !statuses.includes(data.status)) invalid();
  return {
    callId: id(data.callId), status: data.status as ModelCallReceipt['status'],
    ...(Object.hasOwn(data, 'evidenceRef') ? { evidenceRef: id(data.evidenceRef) } : {}),
  };
}

function copyOrigin(value: unknown): InvocationOrigin {
  const data = object(value, ['callId', 'logicalCallId']);
  return { callId: id(data.callId), logicalCallId: id(data.logicalCallId) };
}

function copyReceipt(value: unknown): ToolReceipt {
  const data = object(value, ['executionId', 'source', 'status', 'resultRef', 'stopConfirmed',
    'evidenceRef'], ['resultRef', 'evidenceRef']);
  const source = object(data.source, ['serverId', 'toolName']);
  const statuses = ['succeeded', 'failed', 'denied', 'cancelled_not_sent', 'unknown'];
  if (typeof data.status !== 'string' || !statuses.includes(data.status)
    || typeof data.stopConfirmed !== 'boolean') invalid();
  return {
    executionId: id(data.executionId),
    source: { serverId: id(source.serverId), toolName: id(source.toolName) },
    status: data.status as ToolReceipt['status'], stopConfirmed: data.stopConfirmed,
    ...(Object.hasOwn(data, 'resultRef') ? { resultRef: id(data.resultRef) } : {}),
    ...(Object.hasOwn(data, 'evidenceRef') ? { evidenceRef: id(data.evidenceRef) } : {}),
  };
}

function sameScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return left.sessionId === right.sessionId && left.operationId === right.operationId
    && left.turnId === right.turnId && left.epoch === right.epoch;
}

function sameReceipt(left: ModelCallReceipt | ToolReceipt, right: ModelCallReceipt | ToolReceipt): boolean {
  // Both inputs have been rebuilt in the same explicit field order.
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertReceiptTransition<T extends ModelCallReceipt | ToolReceipt>(
  previous: T | undefined, next: T,
): void {
  if (!previous || sameReceipt(previous, next)) return;
  if (previous.status !== 'unknown' || next.status === 'unknown' || !next.evidenceRef) {
    throw new TurnGateError('TURN_RECEIPT_CONFLICT');
  }
}

function sameTurn(left: TurnScope, right: TurnScope): boolean {
  return left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.epoch === right.epoch && left.operationId === right.operationId
    && left.stageId === right.stageId && left.budgetRef === right.budgetRef;
}

function sameInvocation(left: Invocation, right: Invocation): boolean {
  return left.executionId === right.executionId && left.toolCallId === right.toolCallId
    && left.sessionId === right.sessionId && left.operationId === right.operationId
    && left.turnId === right.turnId && left.epoch === right.epoch
    && left.source.serverId === right.source.serverId && left.source.toolName === right.source.toolName
    && left.argsSha256 === right.argsSha256 && left.permissionScopeHash === right.permissionScopeHash;
}

function scopeError(error: unknown): TurnGateError {
  return error instanceof TurnGateError ? error : new TurnGateError('TURN_INVALID_SCOPE');
}

const journalGateOwners = new WeakMap<ExecutionJournal, {
  sessionId: string;
  gate: Promise<TurnGate>;
}>();

export function createTurnGate(options: {
  sessionId: string;
  journal: ExecutionJournal;
}): Promise<TurnGate> {
  try {
    const data = object(options, ['sessionId', 'journal']);
    const sessionId = id(data.sessionId);
    const journal = data.journal as ExecutionJournal;
    if (journal === null || typeof journal !== 'object') invalid();
    const owner = journalGateOwners.get(journal);
    if (owner) {
      if (owner.sessionId !== sessionId) invalid();
      return owner.gate;
    }
    // Defer initialization until ownership is registered, before journal.read can run.
    const gate = Promise.resolve().then(() => initializeTurnGate({ sessionId, journal }));
    journalGateOwners.set(journal, { sessionId, gate });
    return gate;
  } catch (error) {
    return Promise.reject(scopeError(error));
  }
}

async function initializeTurnGate(options: {
  sessionId: string;
  journal: ExecutionJournal;
}): Promise<TurnGate> {
  const sessionId = id(options.sessionId);
  const journal = options.journal;
  let state: TurnGateSnapshot['state'] = 'ready';
  let currentTurn: TurnScope | null = null;
  let lastEpoch = 0;
  let boundOperation: string | undefined;
  let boundBudget: string | undefined;
  let pauseCode: TurnErrorCode | undefined;
  const inFlight = new Map<string, Invocation>();
  const inFlightModels = new Map<string, ModelCallBinding>();
  const models = new Map<string, ModelAttemptState>();
  const bindings = new Map<string, BoundExecutionState>();
  const toolIdentities = new Map<string, string>();
  const executions = new Set<string>();
  const revoked = new Set<string>();
  const completions = new Map<string, Promise<TurnCompletion>>();
  const stopping = new Map<string, Promise<{ revokedEpoch: number; inFlightExecutionIds: string[] }>>();
  let registration: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();

  function pause(code: TurnErrorCode): void {
    state = 'paused';
    pauseCode = code;
  }

  try {
    const previous = await journal.read();
    if (previous.entries.length > 0 || previous.incompleteTail) {
      pause('TURN_RECOVERY_REQUIRED');
      const ambiguous = new Set<string>();
      const unknownExecutions = new Set<string>();
      const ambiguousModels = new Set<string>();
      const unknownModels = new Set<string>();
      const seenModels = new Set<string>();
      for (const entry of previous.entries) {
        lastEpoch = Math.max(lastEpoch, entry.epoch);
        if (entry.kind === 'execution.dispatching') {
          const executionId = entry.invocation.executionId;
          if (inFlight.has(executionId) || executions.has(executionId)) ambiguous.add(executionId);
          executions.add(executionId);
          if (!inFlight.has(executionId)) inFlight.set(executionId, copyInvocation(entry.invocation));
        } else if (entry.kind === 'execution.receipt') {
          const executionId = entry.invocation.executionId;
          const pending = inFlight.get(executionId);
          if (pending && !ambiguous.has(executionId)
            && sameInvocation(pending, entry.invocation)
            && entry.receipt.executionId === pending.executionId
            && entry.receipt.source.serverId === pending.source.serverId
            && entry.receipt.source.toolName === pending.source.toolName) {
            if (entry.receipt.status === 'unknown') unknownExecutions.add(executionId);
            else if (!unknownExecutions.has(executionId) || entry.receipt.evidenceRef) {
              inFlight.delete(executionId);
            }
          }
        } else if (entry.kind === 'model.dispatching') {
          const callId = entry.call.callId;
          if (seenModels.has(callId)) ambiguousModels.add(callId);
          seenModels.add(callId);
          if (!inFlightModels.has(callId)) inFlightModels.set(callId, copyModel(entry.call));
        } else if (entry.kind === 'model.receipt') {
          const callId = entry.call.callId;
          const pending = inFlightModels.get(callId);
          if (pending && !ambiguousModels.has(callId)
            && entry.receipt.callId === callId
            && JSON.stringify(pending) === JSON.stringify(copyModel(entry.call))) {
            if (entry.receipt.status === 'unknown') unknownModels.add(callId);
            else if ((!unknownModels.has(callId) && entry.receipt.status !== 'not_sent')
              || entry.receipt.evidenceRef) {
              inFlightModels.delete(callId);
            }
          }
        }
      }
    }
  } catch {
    pause('TURN_JOURNAL_FAILED');
  }

  function usable(): void {
    if (pauseCode) throw new TurnGateError(pauseCode);
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  function eventFields(scope: ExecutionScope) {
    return {
      schemaVersion: 1 as const,
      eventId: randomUUID(), sessionId, operationId: scope.operationId,
      turnId: scope.turnId, epoch: scope.epoch, at: new Date().toISOString(),
    };
  }

  async function append(event: ExecutionJournalInput): Promise<ExecutionJournalEntry> {
    try {
      return await journal.append(event);
    } catch {
      pause('TURN_JOURNAL_FAILED');
      throw new TurnGateError('TURN_JOURNAL_FAILED');
    }
  }

  function assertCurrent(call: ExecutionScope): void {
    usable();
    if (revoked.has(call.turnId)) throw new TurnGateError('TURN_REVOKED');
    if (completions.has(call.turnId)) throw new TurnGateError('TURN_COMPLETED');
    if (!currentTurn || call.sessionId !== sessionId || call.sessionId !== currentTurn.sessionId
      || call.operationId !== currentTurn.operationId || call.turnId !== currentTurn.turnId
      || call.epoch !== currentTurn.epoch) invalid();
  }

  function modelDispatchBlocked(): boolean {
    for (const [callId, call] of inFlightModels) {
      const model = models.get(callId);
      if (model?.receipt?.status === 'unknown' || model?.unknownPending
        || revoked.has(call.turnId) || !currentTurn || !sameScope(call, currentTurn)) return true;
    }
    return false;
  }

  function assertModelReceiptAllowed(model: ModelAttemptState, receipt: ModelCallReceipt): void {
    if ((!model.dispatching && receipt.status !== 'not_sent')
      || (model.dispatching && receipt.status === 'not_sent' && !receipt.evidenceRef)) {
      throw new TurnGateError('TURN_RECEIPT_CONFLICT');
    }
  }

  function unresolved(): boolean {
    return inFlight.size > 0 || inFlightModels.size > 0
      || [...models.values()].some(model => !model.receipt || model.receipt.status === 'unknown')
      || [...bindings.values()].some(binding => !binding.receipt || binding.receipt.status === 'unknown');
  }

  return {
    register(value) {
      try {
        usable();
        const turn = copyTurn(value);
        if (turn.sessionId !== sessionId || (boundOperation !== undefined && turn.operationId !== boundOperation)
          || (boundBudget !== undefined && turn.budgetRef !== boundBudget)) invalid();
        if (revoked.has(turn.turnId)) throw new TurnGateError('TURN_REVOKED');
        if (completions.has(turn.turnId)) throw new TurnGateError('TURN_COMPLETED');
        if (currentTurn) {
          if (sameTurn(currentTurn, turn)) return registration ?? Promise.resolve();
          throw new TurnGateError('TURN_CONFLICT');
        }
        if (lastEpoch === Number.MAX_SAFE_INTEGER) {
          pause('TURN_PAUSED');
          throw new TurnGateError('TURN_PAUSED');
        }
        if (turn.epoch <= lastEpoch) throw new TurnGateError('TURN_CONFLICT');
        // Publish the pending identity synchronously so stop cannot miss it while fsync waits.
        currentTurn = turn;
        lastEpoch = turn.epoch;
        boundOperation ??= turn.operationId;
        boundBudget ??= turn.budgetRef;
        state = 'active';
        registration = enqueue(async () => {
          usable();
          await append({ ...eventFields(turn), kind: 'turn.registered', turn });
          usable();
          if (revoked.has(turn.turnId)) throw new TurnGateError('TURN_REVOKED');
        });
        return registration;
      } catch (error) {
        return Promise.reject(scopeError(error));
      }
    },
    markDispatching(value) {
      try {
        usable();
        const call = copyInvocation(value);
        assertCurrent(call);
        const binding = bindings.get(call.executionId);
        if (!binding || !binding.bound || !sameInvocation(binding.invocation, call)
          || models.get(binding.origin.callId)?.receipt?.status !== 'succeeded') {
          throw new TurnGateError('TURN_ORIGIN_MISMATCH');
        }
        if (executions.has(call.executionId)) throw new TurnGateError('TURN_DUPLICATE_EXECUTION');
        if (binding.receipt || binding.pendingReceipt) throw new TurnGateError('TURN_RECEIPT_CONFLICT');
        executions.add(call.executionId);
        return enqueue(async () => {
          assertCurrent(call);
          if (binding.receipt || binding.pendingReceipt) throw new TurnGateError('TURN_RECEIPT_CONFLICT');
          // An attempted durable dispatch remains unresolved even if sync or cancellation wins.
          inFlight.set(call.executionId, call);
          const entry = await append({ ...eventFields(call), kind: 'execution.dispatching', invocation: call });
          assertCurrent(call);
          return {
            sessionId, turnId: call.turnId, epoch: call.epoch,
            executionId: call.executionId, journalSeq: entry.seq,
          };
        });
      } catch (error) {
        return Promise.reject(scopeError(error));
      }
    },
    prepareModel(value) {
      try {
        usable();
        const call = copyModel(value);
        assertCurrent(call);
        if (call.stageId !== currentTurn!.stageId) invalid();
        if (models.has(call.callId)) throw new TurnGateError('TURN_DUPLICATE_CALL');
        const model: ModelAttemptState = {
          call, prepared: false, dispatchRequested: false, dispatching: false, unknownPending: false,
        };
        // Reserve identity before queueing, so concurrent calls cannot reuse it.
        models.set(call.callId, model);
        return enqueue(async () => {
          usable();
          await append({ ...eventFields(call), kind: 'model.prepared', call });
          model.prepared = true;
          assertCurrent(call);
        });
      } catch (error) {
        return Promise.reject(scopeError(error));
      }
    },
    markModelDispatching(value) {
      try {
        usable();
        const callId = id(value);
        const model = models.get(callId);
        if (!model) throw new TurnGateError('TURN_UNKNOWN_CALL');
        assertCurrent(model.call);
        if (modelDispatchBlocked()) throw new TurnGateError('TURN_MODEL_UNRESOLVED');
        if (model.dispatchRequested) throw new TurnGateError('TURN_DUPLICATE_CALL');
        if (model.receipt || model.pendingReceipt) throw new TurnGateError('TURN_RECEIPT_CONFLICT');
        model.dispatchRequested = true;
        return enqueue(async () => {
          assertCurrent(model.call);
          if (modelDispatchBlocked()) throw new TurnGateError('TURN_MODEL_UNRESOLVED');
          if (!model.prepared || model.receipt || model.pendingReceipt) {
            throw new TurnGateError('TURN_RECEIPT_CONFLICT');
          }
          model.dispatching = true;
          inFlightModels.set(callId, model.call);
          const entry = await append({ ...eventFields(model.call), kind: 'model.dispatching', call: model.call });
          assertCurrent(model.call);
          if (modelDispatchBlocked()) throw new TurnGateError('TURN_MODEL_UNRESOLVED');
          return { callId, journalSeq: entry.seq };
        });
      } catch (error) {
        return Promise.reject(scopeError(error));
      }
    },
    recordModelReceipt(value, receiptValue) {
      try {
        usable();
        const callId = id(value);
        const receipt = copyModelReceipt(receiptValue);
        const model = models.get(callId);
        if (!model) throw new TurnGateError('TURN_UNKNOWN_CALL');
        if (receipt.callId !== callId) throw new TurnGateError('TURN_RECEIPT_CONFLICT');
        if (model.pendingReceipt) {
          if (!sameReceipt(model.pendingReceipt.value, receipt)) throw new TurnGateError('TURN_RECEIPT_CONFLICT');
          return model.pendingReceipt.promise;
        }
        assertModelReceiptAllowed(model, receipt);
        const previous = model.receipt;
        assertReceiptTransition(previous, receipt);
        if (previous && sameReceipt(previous, receipt)) {
          return Promise.resolve();
        }
        const pending: PendingReceipt<ModelCallReceipt> = { value: receipt, promise: Promise.resolve() };
        if (receipt.status === 'unknown') model.unknownPending = true;
        model.pendingReceipt = pending;
        pending.promise = enqueue(async () => {
          usable();
          assertModelReceiptAllowed(model, receipt);
          assertReceiptTransition(model.receipt, receipt);
          await append({ ...eventFields(model.call), kind: 'model.receipt', call: model.call, receipt });
          model.receipt = receipt;
          if (receipt.status !== 'unknown') {
            model.unknownPending = false;
            inFlightModels.delete(callId);
          }
        }).finally(() => {
          if (model.pendingReceipt === pending) model.pendingReceipt = undefined;
        });
        return pending.promise;
      } catch (error) {
        return Promise.reject(scopeError(error));
      }
    },
    bindInvocation(value, originValue) {
      try {
        usable();
        const invocation = copyInvocation(value);
        const origin = copyOrigin(originValue);
        assertCurrent(invocation);
        const model = models.get(origin.callId);
        if (!model || model.receipt?.status !== 'succeeded'
          || model.call.logicalCallId !== origin.logicalCallId || !sameScope(model.call, invocation)) {
          throw new TurnGateError('TURN_ORIGIN_MISMATCH');
        }
        const existing = bindings.get(invocation.executionId);
        if (existing) {
          if (!sameInvocation(existing.invocation, invocation) || existing.origin.callId !== origin.callId
            || existing.origin.logicalCallId !== origin.logicalCallId) {
            throw new TurnGateError('TURN_ORIGIN_MISMATCH');
          }
          return existing.binding;
        }
        const identity = JSON.stringify([sessionId, invocation.epoch, origin.callId, invocation.toolCallId]);
        if (toolIdentities.has(identity)) throw new TurnGateError('TURN_ORIGIN_MISMATCH');
        const binding: BoundExecutionState = {
          invocation, origin, bound: false, binding: Promise.resolve(),
        };
        bindings.set(invocation.executionId, binding);
        toolIdentities.set(identity, invocation.executionId);
        binding.binding = enqueue(async () => {
          usable();
          await append({ ...eventFields(invocation), kind: 'execution.model-bound', invocation, origin });
          binding.bound = true;
          assertCurrent(invocation);
        });
        return binding.binding;
      } catch (error) {
        return Promise.reject(scopeError(error));
      }
    },
    recordReceipt(value, receiptValue) {
      try {
        usable();
        const invocation = copyInvocation(value);
        const receipt = copyReceipt(receiptValue);
        const binding = bindings.get(invocation.executionId);
        if (!binding || !sameInvocation(binding.invocation, invocation)) {
          throw new TurnGateError('TURN_ORIGIN_MISMATCH');
        }
        if (receipt.executionId !== invocation.executionId
          || receipt.source.serverId !== invocation.source.serverId
          || receipt.source.toolName !== invocation.source.toolName) {
          throw new TurnGateError('TURN_RECEIPT_CONFLICT');
        }
        if (binding.pendingReceipt) {
          if (!sameReceipt(binding.pendingReceipt.value, receipt)) throw new TurnGateError('TURN_RECEIPT_CONFLICT');
          return binding.pendingReceipt.promise;
        }
        const previous = binding.receipt;
        assertReceiptTransition(previous, receipt);
        if (previous && sameReceipt(previous, receipt)) {
          return Promise.resolve();
        }
        const pending: PendingReceipt<ToolReceipt> = { value: receipt, promise: Promise.resolve() };
        binding.pendingReceipt = pending;
        pending.promise = enqueue(async () => {
          usable();
          if (!binding.bound) throw new TurnGateError('TURN_ORIGIN_MISMATCH');
          assertReceiptTransition(binding.receipt, receipt);
          await append({ ...eventFields(invocation), kind: 'execution.receipt', invocation, receipt });
          binding.receipt = receipt;
          if (receipt.status === 'unknown') inFlight.set(invocation.executionId, invocation);
          else inFlight.delete(invocation.executionId);
        }).finally(() => {
          if (binding.pendingReceipt === pending) binding.pendingReceipt = undefined;
        });
        return pending.promise;
      } catch (error) {
        return Promise.reject(scopeError(error));
      }
    },
    complete(value) {
      try {
        const turnId = id(value);
        const existing = completions.get(turnId);
        if (existing) return existing.then(result => ({ ...result }));
        usable();
        if (revoked.has(turnId)) throw new TurnGateError('TURN_REVOKED');
        if (!currentTurn || currentTurn.turnId !== turnId) throw new TurnGateError('TURN_NOT_FOUND');
        if (unresolved()) throw new TurnGateError('TURN_UNRESOLVED');
        const turn = { ...currentTurn };
        // Claim normal completion synchronously; stop and new work cannot race past it.
        const completion = enqueue(async () => {
          usable();
          const entry = await append({ ...eventFields(turn), kind: 'turn.completed', turn });
          currentTurn = null;
          registration = undefined;
          // Only normal durable completion releases this local binding for a new Host task.
          boundOperation = undefined;
          boundBudget = undefined;
          if (lastEpoch === Number.MAX_SAFE_INTEGER) pause('TURN_PAUSED');
          else state = 'ready';
          return { sessionId, turnId, epoch: turn.epoch, journalSeq: entry.seq };
        });
        completions.set(turnId, completion);
        return completion.then(result => ({ ...result }));
      } catch (error) {
        return Promise.reject(scopeError(error));
      }
    },
    stop(value) {
      try {
        const turnId = id(value);
        const existing = stopping.get(turnId);
        if (existing) return existing.then(result => ({ ...result, inFlightExecutionIds: [...result.inFlightExecutionIds] }));
        usable();
        if (completions.has(turnId)) throw new TurnGateError('TURN_CONFLICT');
        if (!currentTurn || currentTurn.turnId !== turnId) throw new TurnGateError('TURN_NOT_FOUND');
        const turn = { ...currentTurn };
        // This fence must run in the call stack, before waiting for register/dispatch/fsync.
        revoked.add(turnId);
        state = 'paused';
        const result = enqueue(async () => {
          usable();
          await append({ ...eventFields(turn), kind: 'turn.revoked' });
          currentTurn = null;
          registration = undefined;
          if (lastEpoch === Number.MAX_SAFE_INTEGER) pause('TURN_PAUSED');
          else state = 'ready';
          return {
            revokedEpoch: turn.epoch,
            inFlightExecutionIds: [...inFlight.values()]
              .filter(call => call.turnId === turnId).map(call => call.executionId),
          };
        });
        stopping.set(turnId, result);
        return result.then(receipt => ({ ...receipt, inFlightExecutionIds: [...receipt.inFlightExecutionIds] }));
      } catch (error) {
        return Promise.reject(scopeError(error));
      }
    },
    snapshot() {
      return {
        sessionId, state, currentTurn: currentTurn ? { ...currentTurn } : null,
        lastEpoch, inFlightExecutionIds: [...inFlight.keys()],
        inFlightCallIds: [...inFlightModels.keys()],
      };
    },
  };
}

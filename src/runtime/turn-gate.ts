import { randomUUID } from 'node:crypto';
import type { Invocation, TurnScope } from './contracts.js';
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
}

export interface TurnGate {
  register(turn: TurnScope): Promise<void>;
  markDispatching(invocation: Invocation): Promise<DispatchPermit>;
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
  | 'TURN_RECOVERY_REQUIRED';

export class TurnGateError extends Error {
  constructor(public readonly code: TurnErrorCode) {
    super(code);
    this.name = 'TurnGateError';
  }
}

function invalid(): never {
  throw new TurnGateError('TURN_INVALID_SCOPE');
}

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
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
    const sessionId = id(options.sessionId);
    const journal = options.journal;
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
  const executions = new Set<string>();
  const revoked = new Set<string>();
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
          if (pending && !ambiguous.has(executionId) && entry.receipt.status !== 'unknown'
            && sameInvocation(pending, entry.invocation)
            && entry.receipt.executionId === pending.executionId
            && entry.receipt.source.serverId === pending.source.serverId
            && entry.receipt.source.toolName === pending.source.toolName) {
            inFlight.delete(executionId);
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

  function eventFields(scope: TurnScope | Invocation) {
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

  function assertCurrent(call: Invocation): void {
    usable();
    if (revoked.has(call.turnId)) throw new TurnGateError('TURN_REVOKED');
    if (!currentTurn || call.sessionId !== sessionId || call.sessionId !== currentTurn.sessionId
      || call.operationId !== currentTurn.operationId || call.turnId !== currentTurn.turnId
      || call.epoch !== currentTurn.epoch) invalid();
  }

  return {
    register(value) {
      try {
        usable();
        const turn = copyTurn(value);
        if (turn.sessionId !== sessionId || (boundOperation !== undefined && turn.operationId !== boundOperation)
          || (boundBudget !== undefined && turn.budgetRef !== boundBudget)) invalid();
        if (revoked.has(turn.turnId)) throw new TurnGateError('TURN_REVOKED');
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
        if (executions.has(call.executionId)) throw new TurnGateError('TURN_DUPLICATE_EXECUTION');
        executions.add(call.executionId);
        return enqueue(async () => {
          assertCurrent(call);
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
    stop(value) {
      try {
        const turnId = id(value);
        const existing = stopping.get(turnId);
        if (existing) return existing.then(result => ({ ...result, inFlightExecutionIds: [...result.inFlightExecutionIds] }));
        usable();
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
      };
    },
  };
}

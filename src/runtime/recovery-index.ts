import type { ExecutionJournalEntry } from './execution-journal.js';
import { isDeepStrictEqual } from 'node:util';
import type { Invocation, InvocationOrigin, ModelCallBinding, ModelCallReceipt, ToolReceipt, TurnScope } from './contracts.js';

export interface RecoveredModel { call: ModelCallBinding; dispatched: boolean; receipt?: ModelCallReceipt }
export interface RecoveredTool { invocation: Invocation; origin: InvocationOrigin; dispatched: boolean; receipt?: ToolReceipt }
export interface RecoveryIndex {
  models: Map<string, RecoveredModel>; tools: Map<string, RecoveredTool>; turns: Map<string, TurnScope>;
  revoked: Set<string>; completed: Map<string, number>; current: TurnScope | null;
  lastEpoch: number; boundOperation?: string; boundBudget?: string;
}
const same = isDeepStrictEqual;
function check(condition: unknown): asserts condition { if (!condition) throw new Error('MA_RECOVERY_JOURNAL_CONFLICT'); }
function scope(a: { sessionId: string; turnId: string; operationId: string; epoch: number }, b: typeof a): boolean {
  return a.sessionId === b.sessionId && a.turnId === b.turnId && a.operationId === b.operationId && a.epoch === b.epoch;
}
function transition<T extends { status: string; evidenceRef?: string }>(old: T | undefined, next: T): void {
  check(!old || same(old, next) || (old.status === 'unknown' && next.status !== 'unknown' && next.evidenceRef));
}

/** Deterministic validation of the existing journal. This never dispatches or grants authority. */
export function indexExecutionHistory(entries: readonly ExecutionJournalEntry[]): RecoveryIndex {
  const result: RecoveryIndex = { models: new Map(), tools: new Map(), turns: new Map(), revoked: new Set(),
    completed: new Map(), current: null, lastEpoch: 0 };
  const toolIds = new Set<string>();
  const active = (entry: ExecutionJournalEntry) => check(result.current && scope(entry, result.current));
  for (const entry of entries) {
    switch (entry.kind) {
      case 'turn.registered':
        check(!result.current && !result.turns.has(entry.turnId) && entry.epoch > result.lastEpoch);
        check(!result.boundOperation || (entry.turn.operationId === result.boundOperation && entry.turn.budgetRef === result.boundBudget));
        result.current = entry.turn; result.turns.set(entry.turnId, entry.turn); result.lastEpoch = entry.epoch;
        result.boundOperation = entry.turn.operationId; result.boundBudget = entry.turn.budgetRef;
        break;
      case 'turn.revoked':
        active(entry); result.revoked.add(entry.turnId); result.current = null; break;
      case 'turn.completed':
        active(entry);
        check([...result.models.values()].every(model => model.receipt && model.receipt.status !== 'unknown'));
        check([...result.tools.values()].every(tool => tool.receipt && tool.receipt.status !== 'unknown'));
        result.completed.set(entry.turnId, entry.seq); result.current = null;
        result.boundOperation = undefined; result.boundBudget = undefined; break;
      case 'model.prepared':
        active(entry); check(!result.models.has(entry.call.callId));
        check(result.current?.stageId === entry.call.stageId);
        result.models.set(entry.call.callId, { call: entry.call, dispatched: false }); break;
      case 'model.dispatching': {
        active(entry);
        const model = result.models.get(entry.call.callId);
        check(model && same(model.call, entry.call) && !model.dispatched && !model.receipt);
        model.dispatched = true; break;
      }
      case 'model.receipt': {
        const model = result.models.get(entry.call.callId);
        check(model && same(model.call, entry.call) && entry.receipt.callId === model.call.callId);
        check(model.dispatched ? entry.receipt.status !== 'not_sent' || entry.receipt.evidenceRef : entry.receipt.status === 'not_sent');
        transition(model.receipt, entry.receipt); model.receipt = entry.receipt; break;
      }
      case 'execution.model-bound': {
        active(entry);
        const model = result.models.get(entry.origin.callId);
        check(model?.receipt?.status === 'succeeded' && scope(model.call, entry.invocation)
          && model.call.logicalCallId === entry.origin.logicalCallId && !result.tools.has(entry.invocation.executionId));
        const identity = JSON.stringify([entry.sessionId, entry.epoch, entry.origin.callId, entry.invocation.toolCallId]);
        check(!toolIds.has(identity)); toolIds.add(identity);
        result.tools.set(entry.invocation.executionId, { invocation: entry.invocation, origin: entry.origin, dispatched: false }); break;
      }
      case 'execution.dispatching': {
        active(entry);
        const tool = result.tools.get(entry.invocation.executionId);
        check(tool && same(tool.invocation, entry.invocation) && !tool.dispatched && !tool.receipt);
        tool.dispatched = true; break;
      }
      case 'execution.receipt': {
        const tool = result.tools.get(entry.invocation.executionId);
        check(tool && same(tool.invocation, entry.invocation));
        check(entry.receipt.executionId === tool.invocation.executionId
          && same(entry.receipt.source, tool.invocation.source));
        transition(tool.receipt, entry.receipt); tool.receipt = entry.receipt; break;
      }
      case 'execution.prepared':
      case 'execution.authorized':
        // Old records have no durable originating model binding. Never invent one.
        throw new Error('MA_RECOVERY_LEGACY_ORIGIN_REQUIRED');
    }
  }
  return result;
}

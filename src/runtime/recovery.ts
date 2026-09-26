import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { ExecutionJournal, ExecutionJournalInput } from './execution-journal.js';
import type { HostControlPort } from './public-types.js';
import type { Invocation, ModelCallBinding, ModelCallReceipt, ToolReceipt } from './contracts.js';
import type { ReceiptStore } from './receipt-store.js';
import { indexExecutionHistory } from './recovery-index.js';
import { cloneRuntimeJson, ownData } from './data.js';
import { controlledToolName } from './tool-bridge.js';

function fields(scope: Invocation | ModelCallBinding) {
  return { schemaVersion: 1 as const, eventId: randomUUID(), sessionId: scope.sessionId,
    operationId: scope.operationId, turnId: scope.turnId, epoch: scope.epoch, at: new Date().toISOString() };
}
/** Caller holds the session writer lock and has no live Pi session. No execution is replayed. */
export async function reconcileSavedExecution(input: {
  journal: ExecutionJournal; receipts: ReceiptStore; manager: SessionManager; host: HostControlPort;
}): Promise<void> {
  const history = await input.journal.read();
  if (history.incompleteTail) throw new Error('MA_RECOVERY_INCOMPLETE_JOURNAL');
  let index = indexExecutionHistory(history.entries);
  const stored = await Promise.all((await input.receipts.list()).map(async reference => ({ reference, value: await input.receipts.read(reference) })));
  const append = (event: ExecutionJournalInput) => input.journal.append(event);
  for (const model of index.models.values()) {
    if (model.receipt && model.receipt.status !== 'unknown') continue;
    let receipt: ModelCallReceipt | undefined;
    const original = stored.filter(item => item.value.kind === 'model.receipt'
      && isDeepStrictEqual(item.value.binding, model.call) && ['succeeded', 'failed', 'not_sent'].includes(String(item.value.status)));
    if (original.length > 1 && original.some(item => item.value.status !== original[0].value.status)) throw new Error('MA_RECOVERY_RECEIPT_CONFLICT');
    if (original[0]) receipt = { callId: model.call.callId, status: original[0].value.status as ModelCallReceipt['status'], evidenceRef: original[0].reference };
    else if (!model.dispatched) {
      const reference = await input.receipts.write({ kind: 'model.receipt', binding: model.call, status: 'not_sent', reason: 'durable_journal_has_no_dispatch' });
      receipt = { callId: model.call.callId, status: 'not_sent', evidenceRef: reference };
    } else if (input.host.queryModelRecovery) {
      const found = await input.host.queryModelRecovery(cloneRuntimeJson(model.call)).catch(() => null);
      if (found && isDeepStrictEqual(found.context, model.call) && found.supplierRequestSha256 === model.call.requestSha256
        && found.receipt.evidenceRef && found.receipt.status !== 'unknown'
        && (found.receipt.status === 'not_sent'
          ? found.providerAcceptance === 'not_sent' || found.providerAcceptance === 'not_accepted'
          : found.dispatchState === 'confirmed' && found.providerAcceptance === 'accepted')) {
        const reference = await input.receipts.write({ kind: 'model.recovery', binding: model.call, evidence: cloneRuntimeJson(found) });
        receipt = { callId: model.call.callId, status: found.receipt.status, evidenceRef: reference };
      }
    }
    if (receipt) await append({ ...fields(model.call), kind: 'model.receipt', call: model.call, receipt });
  }
  for (const tool of index.tools.values()) {
    if (tool.receipt && tool.receipt.status !== 'unknown') continue;
    let receipt: ToolReceipt | undefined;
    const originals = stored.filter(item => item.value.kind === 'tool.receipt'
      && isDeepStrictEqual(item.value.invocation, tool.invocation) && isDeepStrictEqual(item.value.origin, tool.origin)
      && item.value.status !== 'unknown');
    if (originals.length > 1 && originals.some(item => !isDeepStrictEqual(item.value, originals[0].value))) throw new Error('MA_RECOVERY_RECEIPT_CONFLICT');
    if (originals[0]) {
      receipt = { executionId: tool.invocation.executionId, source: tool.invocation.source,
        status: originals[0].value.status as ToolReceipt['status'], stopConfirmed: originals[0].value.stopConfirmed === true,
        resultRef: originals[0].reference, evidenceRef: originals[0].reference };
    } else if (!tool.dispatched) {
      const result = { content: [{ type: 'text', text: 'This tool was not dispatched before the session stopped.' }], details: { executionId: tool.invocation.executionId } };
      const reference = await input.receipts.write({ kind: 'tool.receipt', invocation: tool.invocation, origin: tool.origin,
        status: 'cancelled_not_sent', stopConfirmed: true, result, isError: true });
      receipt = { executionId: tool.invocation.executionId, source: tool.invocation.source,
        status: 'cancelled_not_sent', stopConfirmed: true, resultRef: reference, evidenceRef: reference };
    } else {
      const found = await input.host.queryExecution(cloneRuntimeJson(tool.invocation)).catch(() => null);
      if (found && found.receipt.executionId === tool.invocation.executionId
        && isDeepStrictEqual(found.receipt.source, tool.invocation.source) && found.receipt.evidenceRef
        && found.receipt.status !== 'unknown' && found.result) {
        const reference = await input.receipts.write({ kind: 'tool.receipt', invocation: tool.invocation, origin: tool.origin,
          status: found.receipt.status, stopConfirmed: found.receipt.stopConfirmed, result: cloneRuntimeJson(found.result),
          isError: found.receipt.status !== 'succeeded', externalEvidenceRef: found.receipt.evidenceRef });
        receipt = { ...cloneRuntimeJson(found.receipt), resultRef: reference, evidenceRef: reference };
      }
    }
    if (receipt) await append({ ...fields(tool.invocation), kind: 'execution.receipt', invocation: tool.invocation, receipt });
  }
  index = indexExecutionHistory((await input.journal.read()).entries);
  const branch = input.manager.getBranch();
  const allMessages = input.manager.getEntries().flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  const messages = branch.flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  for (const tool of index.tools.values()) {
    if (!tool.receipt || tool.receipt.status === 'unknown' || !tool.receipt.resultRef) continue;
    const existing = allMessages.filter(message => message.role === 'toolResult' && message.toolCallId === tool.invocation.toolCallId
      && ownData(message.details, 'executionId') === tool.invocation.executionId);
    if (existing.length) {
      if (existing.length !== 1 || ownData(existing[0].role === 'toolResult' ? existing[0].details : undefined, 'executionId') !== tool.invocation.executionId) {
        throw new Error('MA_RECOVERY_HISTORY_CONFLICT');
      }
      continue;
    }
    const storedResult = await input.receipts.read(tool.receipt.resultRef);
    const name = controlledToolName(tool.invocation.source);
    const origins = messages.filter(message => message.role === 'assistant'
      && (typeof storedResult.assistantTimestamp !== 'number' || message.timestamp === storedResult.assistantTimestamp)
      && message.content.some(block =>
      block.type === 'toolCall' && block.id === tool.invocation.toolCallId && block.name === name));
    // A receipt without its original assistant tool call cannot be attached to a newer conversation.
    if (origins.length !== 1) throw new Error('MA_RECOVERY_TOOL_ORIGIN_MISSING');
    if (!isDeepStrictEqual(storedResult.invocation, tool.invocation) || !isDeepStrictEqual(storedResult.origin, tool.origin)) {
      throw new Error('MA_RECOVERY_RECEIPT_CONFLICT');
    }
    const result = storedResult.result as ToolResultMessage;
    if (!result || !Array.isArray(result.content)) throw new Error('MA_RECOVERY_RESULT_MISSING');
    const details = result.details && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details : {};
    const message: ToolResultMessage = { role: 'toolResult', toolCallId: tool.invocation.toolCallId, toolName: name,
      content: cloneRuntimeJson(result.content), details: { ...cloneRuntimeJson(details), executionId: tool.invocation.executionId,
        resultRef: tool.receipt.resultRef }, isError: storedResult.isError === true, timestamp: Date.now() };
    input.manager.appendMessage(message); messages.push(message); allMessages.push(message);
  }
  const path = input.manager.getSessionFile();
  if (path) {
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); await handle.sync(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    finally { await handle?.close(); }
  }
}

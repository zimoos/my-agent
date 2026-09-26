import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import type { ProviderRuntime } from '../provider/runtime.js';
import type { InvocationOrigin, ModelCallBinding, ModelCallContext, ModelCallReceipt, TurnScope } from './contracts.js';
import type { HostControlPort, ModelCapabilitySnapshot, ModelExecutionEvidence, PreparedModelRequest } from './public-types.js';
import type { TurnGate } from './turn-gate.js';
import type { ReceiptStore } from './receipt-store.js';
import { createPiOpenAiCodec } from './pi-openai-codec.js';
import { cloneRuntimeJson, ownData, requireOwnData } from './data.js';
import { parseRequestBudget } from './errors.js';

type CodecStream = ReturnType<typeof createPiOpenAiCodec>;
export interface ModelRunScope {
  turn: TurnScope;
  purpose: ModelCallContext['modelPurpose'];
  signal: AbortSignal;
  missionId?: string;
  deadline?: number;
  protectedCompletion?: boolean;
}
export interface BoundToolOrigin {
  turn: TurnScope;
  origin: InvocationOrigin;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  assistantTimestamp: number;
}
export interface ModelBridge {
  streamSimple: CodecStream;
  claimToolOrigin(turn: TurnScope, toolCallId: string, name: string): BoundToolOrigin;
  forgetTurn(turn: TurnScope): void;
}
interface BridgeOptions {
  runtime: ProviderRuntime;
  host: HostControlPort;
  gate: TurnGate;
  receipts: ReceiptStore;
  capability: ModelCapabilitySnapshot;
  captureRun(): ModelRunScope;
  beforeRequest?(): Promise<void>;
  onUsage?(context: ModelCallContext, usage: ChatCompletionChunk['usage'] | null): void;
  onPaused?(context: ModelCallContext, code: string): void;
  onFailure?(context: ModelCallContext, error: unknown): void;
}

function protocolError(code: string): Error { return new Error(code); }
function observe(callback: (() => unknown) | undefined): void {
  if (!callback) return;
  try { void Promise.resolve(callback()).catch(() => {}); } catch { /* Observer only. */ }
}
function callId(): string { return `call_${randomUUID().replaceAll('-', '')}`; }
function scopeKey(turn: TurnScope): string { return `${turn.sessionId}\0${turn.epoch}\0${turn.turnId}`; }
function originKey(turn: TurnScope, toolCallId: string): string { return `${scopeKey(turn)}\0${toolCallId}`; }

/** Only structured evidence from the provider's error envelope can authorize a retry. */
export function modelExecutionEvidence(error: unknown, expectedCallId: string): ModelExecutionEvidence | null {
  const outer = ownData(error, 'error');
  const body = ownData(outer, 'error') ?? outer ?? error;
  const execution = ownData(body, 'execution');
  const id = ownData(execution, 'callId');
  const dispatchState = ownData(execution, 'dispatchState');
  const providerAcceptance = ownData(execution, 'providerAcceptance');
  const retryable = ownData(body, 'retryable');
  if (id !== expectedCallId || typeof retryable !== 'boolean'
    || typeof dispatchState !== 'string' || typeof providerAcceptance !== 'string'
    || !['not_sent', 'dispatching', 'confirmed', 'unknown'].includes(dispatchState)
    || !['not_sent', 'not_accepted', 'accepted', 'unknown'].includes(providerAcceptance)) return null;
  const evidence: ModelExecutionEvidence = {
    callId: id as string, dispatchState: dispatchState as ModelExecutionEvidence['dispatchState'],
    providerAcceptance: providerAcceptance as ModelExecutionEvidence['providerAcceptance'], retryable,
  };
  const nativeHash = ownData(execution, 'supplierRequestSha256');
  if (nativeHash !== undefined) {
    if (typeof nativeHash !== 'string' || !/^[a-f0-9]{64}$/.test(nativeHash)) return null;
    evidence.supplierRequestSha256 = nativeHash;
  }
  const retryAfterMs = ownData(body, 'retryAfterMs');
  if (typeof retryAfterMs === 'number' && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) {
    evidence.retryAfterMs = retryAfterMs;
  }
  return evidence;
}

/** One request projection; Cloud remeasures the result. It never converts native units to tokens. */
function rebuildForBudget(error: unknown, request: ChatCompletionCreateParamsStreaming, call: ModelCallContext): ChatCompletionCreateParamsStreaming | null {
  const outer = ownData(error, 'error'); const body = ownData(outer, 'error') ?? outer ?? error;
  const code = ownData(body, 'code');
  if (typeof code !== 'string' || !['MA_OPERATION_BUDGET_EXCEEDED', 'MA_OPERATION_PRICE_SNAPSHOT_UNAVAILABLE'].includes(code)) return null;
  const execution = modelExecutionEvidence(error, call.callId);
  if (!execution || execution.dispatchState !== 'not_sent' || execution.providerAcceptance !== 'not_sent') return null;
  const hint = parseRequestBudget(ownData(body, 'requestBudget'));
  if (!hint || hint.maxOutputUnits < 512 || typeof request.max_tokens !== 'number') return null;
  const { currentUnits: current, maxUnits: maximum } = hint.inputBudget;
  const output = hint.maxOutputUnits;
  const rebuilt = cloneRuntimeJson(request);
  let changed = false;
  if (output < request.max_tokens) { rebuilt.max_tokens = output; changed = true; }
  if (maximum < current) {
    let latestToolExchange = -1;
    for (let i = rebuilt.messages.length - 1; i >= 0; i--) {
      const message = rebuilt.messages[i];
      if (message.role === 'assistant' && message.tool_calls?.length) { latestToolExchange = i; break; }
    }
    // Keep every user/system message, tool call and latest complete exchange intact.
    // Only older textual tool bodies have a truthful request-only omission marker.
    for (let i = 0; i < latestToolExchange; i++) {
      const message = rebuilt.messages[i];
      if (message.role !== 'tool' || typeof message.content !== 'string') continue;
      const summary = `[Older tool result ${message.tool_call_id}: content omitted from this request to fit the task budget. The original result remains in saved MA history. No unseen content is being summarized.]`;
      if (Buffer.byteLength(message.content, 'utf8') > Buffer.byteLength(summary, 'utf8')) {
        rebuilt.messages[i] = { ...message, content: summary }; changed = true;
      }
    }
  }
  return changed ? rebuilt : null;
}

export const PROTECTED_COMPLETION_PROMPT = 'Summarize the existing task results only: completed work, verified evidence, remaining issues, and how to use the delivered artifacts. Do not perform new work or call tools. Explicitly distinguish unverified claims. Keep the response concise.';

/** The same protected projection is used for earmark quotes and explicit closing Turns. */
function protectedCompletionRequest(request: ChatCompletionCreateParamsStreaming): ChatCompletionCreateParamsStreaming {
  const projected = cloneRuntimeJson(request);
  const keep = new Set<number>();
  for (let i = 0; i < projected.messages.length; i++) {
    if (['system', 'developer', 'user'].includes(projected.messages[i].role)) keep.add(i);
  }
  for (let i = projected.messages.length - 1; i >= 0; i--) {
    const message = projected.messages[i];
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const ids = new Set(message.tool_calls.map(call => call.id));
    if (ids.size !== message.tool_calls.length) throw protocolError('MA_COMPLETION_CONTEXT_INVALID');
    const replies: number[] = [];
    const found = new Set<string>();
    for (let j = i + 1; j < projected.messages.length; j++) {
      const response = projected.messages[j];
      if (response.role !== 'tool') break;
      if (!ids.has(response.tool_call_id) || found.has(response.tool_call_id)) throw protocolError('MA_COMPLETION_CONTEXT_INVALID');
      found.add(response.tool_call_id); replies.push(j);
    }
    if (found.size !== ids.size) continue;
    keep.add(i); for (const index of replies) keep.add(index);
    break;
  }
  projected.messages = projected.messages.filter((_message, index) => keep.has(index));
  const last = projected.messages.at(-1);
  if (last?.role !== 'user' || last.content !== PROTECTED_COMPLETION_PROMPT) {
    projected.messages.push({ role: 'user', content: PROTECTED_COMPLETION_PROMPT });
  }
  projected.max_tokens = 512; projected.tool_choice = 'none';
  delete projected.tools; delete projected.parallel_tool_calls;
  return projected;
}

function validatePrepared(value: PreparedModelRequest, context: ModelCallContext, revision: number): PreparedModelRequest {
  const prepared = cloneRuntimeJson(value);
  requireOwnData(prepared, ['supplierRequestSha256', 'requestRevision', 'modelId', 'providerProfileId', 'capabilitySnapshotId']);
  if (!/^[a-f0-9]{64}$/.test(prepared.supplierRequestSha256)
    || prepared.requestRevision !== revision || prepared.modelId !== context.modelId
    || prepared.providerProfileId !== context.providerProfileId
    || prepared.capabilitySnapshotId !== context.capabilitySnapshotId) throw protocolError('MA_MODEL_PREPARATION_MISMATCH');
  if (prepared.preparedQuote) {
    const quote = prepared.preparedQuote;
    requireOwnData(quote, ['quoteId', 'quoteSha256', 'supplierRequestSha256', 'requestRevision', 'budgetRevision']);
    if (quote.supplierRequestSha256 !== prepared.supplierRequestSha256 || quote.requestRevision !== revision
      || typeof quote.quoteId !== 'string' || !quote.quoteId
      || !/^[a-f0-9]{64}$/.test(quote.quoteSha256)
      || !Number.isSafeInteger(quote.budgetRevision) || quote.budgetRevision < 1) {
      throw protocolError('MA_MODEL_PREPARATION_MISMATCH');
    }
  }
  if (prepared.headers && Object.values(prepared.headers).some(value => typeof value !== 'string')) {
    throw protocolError('MA_MODEL_PREPARATION_MISMATCH');
  }
  return prepared;
}

/** Pi owns its loop. This bridge owns only one logical model call and its bounded attempts. */
export function createModelBridge(options: BridgeOptions): ModelBridge {
  if (options.runtime.policy.maxRetries !== 0) throw protocolError('MA_PROVIDER_RETRY_MUST_BE_DISABLED');
  const origins = new Map<string, BoundToolOrigin>();
  const capability = cloneRuntimeJson(options.capability);
  const streamSimple: CodecStream = (model, context, streamOptions) => {
    // Capture before any asynchronous preflight; late callbacks never read a newer Turn.
    const run = options.captureRun();
    const turn = cloneRuntimeJson(run.turn);
    const logicalCallId = `logical_${randomUUID().replaceAll('-', '')}`;
    const controllerSignal = streamOptions?.signal
      ? AbortSignal.any([run.signal, streamOptions.signal]) : run.signal;
    let completedContext: ModelCallContext | undefined;
    let lastContext: ModelCallContext | undefined;
    const codec = createPiOpenAiCodec({
      execute: async (request, { signal }) => {
        let requestSnapshot = run.protectedCompletion ? protectedCompletionRequest(request) : cloneRuntimeJson(request);
        let requestRevision = 1;
        let repairedBudget = false;
        return {
          async *[Symbol.asyncIterator]() {
            for (let attempt = 0; attempt < (run.protectedCompletion ? 1 : 3); attempt++) {
              const attemptSignal = AbortSignal.any([controllerSignal, signal]);
              const call: ModelCallContext = {
                operationId: turn.operationId, stageId: turn.stageId, sessionId: turn.sessionId,
                turnId: turn.turnId, epoch: turn.epoch, logicalCallId, callId: callId(), providerProfileId: capability.providerProfileId,
                modelId: capability.modelId, modelPurpose: run.purpose,
                capabilitySnapshotId: capability.id, signal: attemptSignal,
                ...(run.missionId ? { missionId: run.missionId } : {}),
              };
              lastContext = call;
              let prepared = false;
              let persistedBinding: ModelCallBinding | undefined;
              let enteredProvider = false;
              let terminal = false;
              let yielded = false;
              let ended = false;
              let usage: ChatCompletionChunk['usage'] | null = null;
              const evidenceContext = () => {
                const { signal: _signal, ...safe } = call;
                return safe;
              };
              const record = async (status: ModelCallReceipt['status'], reason: string,
                execution?: ModelExecutionEvidence): Promise<void> => {
                if (status === 'unknown') void options.gate.stop(turn.turnId).catch(() => {});
                const reference = await options.receipts.write({
                  schemaVersion: 1, kind: 'model.receipt', context: evidenceContext(), status, reason,
                  ...(persistedBinding ? { binding: persistedBinding } : {}),
                  ...(execution ? { execution } : {}), ...(usage ? { usage: cloneRuntimeJson(usage) } : {}),
                });
                if (prepared) await options.gate.recordModelReceipt(call.callId, {
                  callId: call.callId, status, evidenceRef: reference,
                });
                terminal = true;
                if (persistedBinding) await options.host.recordModelReceipt?.({ call: cloneRuntimeJson(persistedBinding),
                  receipt: { callId: call.callId, status, evidenceRef: reference }, usage: usage ? cloneRuntimeJson(usage) : null });
              };
              try {
                attemptSignal.throwIfAborted();
                await options.beforeRequest?.();
                attemptSignal.throwIfAborted();
                if (run.deadline !== undefined && Date.now() >= run.deadline) throw protocolError('MA_TURN_DEADLINE');
                const approval = validatePrepared(await options.host.prepareModel({
                  context: call, requestRevision, request: cloneRuntimeJson(requestSnapshot),
                  ...(!run.protectedCompletion && run.purpose === 'tool_loop' ? { completionRequest: protectedCompletionRequest(requestSnapshot) } : {}),
                }), call, requestRevision);
                const { signal: _signal, ...binding } = call;
                persistedBinding = { ...binding, requestRevision, requestSha256: approval.supplierRequestSha256 };
                await options.gate.prepareModel(persistedBinding);
                prepared = true;
                attemptSignal.throwIfAborted();
                await options.gate.markModelDispatching(call.callId);
                attemptSignal.throwIfAborted();
                enteredProvider = true;
                const chunks = await options.runtime.createStreamingChatCompletion(cloneRuntimeJson(requestSnapshot), {
                  signal: attemptSignal, modelContext: call,
                  ...(approval.headers ? { headers: { ...approval.headers } } : {}),
                });
                for await (const chunk of chunks) {
                  attemptSignal.throwIfAborted();
                  if (chunk.usage) usage = chunk.usage;
                  if (chunk.choices.some(choice => choice.finish_reason !== null && choice.finish_reason !== undefined)) ended = true;
                  yielded = true;
                  yield chunk;
                }
                if (!ended) throw protocolError('MA_MODEL_MISSING_FINISH');
                await record('succeeded', 'provider_stream_completed');
                completedContext = call;
                observe(() => options.onUsage?.(call, usage));
                return;
              } catch (error) {
                observe(() => options.onFailure?.(call, error));
                let evidence = enteredProvider ? modelExecutionEvidence(error, call.callId) : null;
                if (evidence?.supplierRequestSha256 && evidence.supplierRequestSha256 !== persistedBinding?.requestSha256) evidence = null;
                const provenNotSent = !enteredProvider || (!yielded && evidence !== null
                  && (evidence.providerAcceptance === 'not_sent' || evidence.providerAcceptance === 'not_accepted')
                  && evidence.dispatchState !== 'unknown');
                if (!terminal) await record(provenNotSent ? 'not_sent' : 'unknown',
                  provenNotSent ? 'confirmed_not_accepted' : 'provider_outcome_unresolved', evidence ?? undefined);
                if (!provenNotSent) {
                  observe(() => options.onPaused?.(call, 'MA_MODEL_OUTCOME_UNKNOWN'));
                }
                const repaired = !run.protectedCompletion && !repairedBudget && provenNotSent && !yielded && !attemptSignal.aborted
                  ? rebuildForBudget(error, requestSnapshot, call) : null;
                if (repaired && attempt < 2) {
                  requestSnapshot = repaired; requestRevision += 1; repairedBudget = true;
                  continue; // Re-quote once with a new call identity; the hint is never an execution grant.
                }
                const retry = !run.protectedCompletion && provenNotSent && evidence?.retryable === true && attempt < 2 && !attemptSignal.aborted;
                if (!retry) throw error;
                const outerError = ownData(error, 'error');
                const errorBody = ownData(outerError, 'error') ?? outerError ?? error;
                if (ownData(errorBody, 'code') === 'MA_OPERATION_QUOTE_EXPIRED') requestRevision += 1;
                const wait = evidence?.retryAfterMs ?? 0;
                if (run.deadline !== undefined && Date.now() + wait >= run.deadline) throw error;
                if (wait > 0) await delay(wait, undefined, { signal: attemptSignal });
              } finally {
                options.runtime.discardPreparedModelRequest?.(call.callId);
                // Early iterator return is cancellation, not proof the remote request stopped.
                if (prepared && !terminal) {
                  await record(enteredProvider ? 'unknown' : 'not_sent', 'iterator_closed_before_receipt');
                  if (enteredProvider) {
                    observe(() => options.onPaused?.(call, 'MA_MODEL_OUTCOME_UNKNOWN'));
                  }
                }
              }
            }
          },
        };
      },
    });
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        for await (const event of codec(model, context, { ...streamOptions, signal: controllerSignal })) {
          if (event.type === 'done') {
            if (!completedContext) throw protocolError('MA_MODEL_RECEIPT_MISSING');
            const tools = event.message.content.filter(block => block.type === 'toolCall');
            if (run.protectedCompletion && tools.length) throw protocolError('MA_COMPLETION_TOOL_FORBIDDEN');
            const pending: Array<[string, BoundToolOrigin]> = [];
            const seen = new Set<string>();
            for (const tool of tools) {
              const key = originKey(turn, tool.id);
              if (seen.has(key) || origins.has(key)) throw protocolError('MA_DUPLICATE_TOOL_CALL_ID');
              seen.add(key);
              pending.push([key, {
                turn, origin: { callId: completedContext.callId, logicalCallId },
                toolCallId: tool.id, name: tool.name, arguments: cloneRuntimeJson(tool.arguments),
                assistantTimestamp: event.message.timestamp,
              }]);
            }
            for (const [key, value] of pending) origins.set(key, value);
          }
          output.push(event);
        }
        output.end();
      } catch {
        if (lastContext && options.gate.snapshot().inFlightCallIds.includes(lastContext.callId)) {
          const failedContext = lastContext;
          observe(() => options.onPaused?.(failedContext, 'MA_MODEL_BRIDGE_FAILED'));
        }
        const reason = controllerSignal.aborted ? 'aborted' : 'error';
        const message: AssistantMessage = {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: reason, errorMessage: 'The controlled model request could not complete.', timestamp: Date.now(),
        };
        // Pi requires numeric usage on an error object. It is never emitted as accounting evidence.
        output.push({ type: 'error', reason, error: message });
        output.end();
      }
    })();
    return output;
  };
  return {
    streamSimple,
    claimToolOrigin(turn, toolCallId, name) {
      const origin = origins.get(originKey(turn, toolCallId));
      if (!origin || origin.name !== name) throw protocolError('MA_TOOL_ORIGIN_MISSING');
      origins.delete(originKey(turn, toolCallId));
      return cloneRuntimeJson(origin);
    },
    forgetTurn(turn) {
      const prefix = `${scopeKey(turn)}\0`;
      for (const key of origins.keys()) if (key.startsWith(prefix)) origins.delete(key);
    },
  };
}

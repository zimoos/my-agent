import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import type { RequestOptions } from 'openai/core';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';
import pRetry, { AbortError as PRetryAbortError } from 'p-retry';
import type { ModelConfig, ProviderSessionState } from '../mcp/types.js';
import { createAgoraProviderRuntime, type AgoraProviderContext, type AgoraMemoryController } from './agora.js';
import type { ModelCallContext } from '../runtime/contracts.js';
import { resolveProviderCodec } from './detect.js';

export const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 180_000;
export const DEFAULT_PROVIDER_MAX_RETRIES = 5;

export interface ProviderPolicy {
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxRetries: number;
}

export type ProviderAttemptEvent =
  | {
      type: 'attempt';
      attempt: number;
      maxAttempts: number;
      timeoutMs: number;
      stream: boolean;
    }
  | {
      type: 'retry';
      attempt: number;
      nextAttempt: number;
      retriesLeft: number;
      maxRetries: number;
      delayMs: number;
      error: string;
      stream: boolean;
    };

export interface ProviderProgressEvent {
  type: 'progress';
  provider: string;
  phase?: string;
  message: string;
  progress?: number;
  total?: number;
  operation?: string;
  details?: Record<string, unknown>;
}

export type ProviderRuntimeEvent = ProviderAttemptEvent | ProviderProgressEvent;

export interface ProviderRunOptions {
  signal?: AbortSignal;
  onEvent?: (event: ProviderRuntimeEvent) => void;
  /** Trusted per-attempt control-plane metadata; never copied into model messages. */
  modelContext?: ModelCallContext;
  headers?: Record<string, string>;
}

export class ProviderStreamIdleTimeoutError extends Error {
  readonly code = 'provider_stream_idle_timeout';
  readonly retryable: boolean;

  constructor(timeoutMs: number, retryable: boolean) {
    super(
      retryable
        ? `provider stream produced no chunk within ${timeoutMs}ms`
        : `provider stream stopped for more than ${timeoutMs}ms after output started`
    );
    this.name = 'ProviderStreamIdleTimeoutError';
    this.retryable = retryable;
  }
}

export class ProviderRequestTimeoutError extends Error {
  readonly code = 'provider_request_timeout';

  constructor(timeoutMs: number) {
    super(`provider request timed out after ${timeoutMs}ms`);
    this.name = 'ProviderRequestTimeoutError';
  }
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

export function resolveProviderPolicy(model: ModelConfig): ProviderPolicy {
  const requestTimeoutMs = positiveInt(
    model.requestTimeoutMs,
    DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS
  );
  return {
    requestTimeoutMs,
    streamIdleTimeoutMs: positiveInt(model.streamIdleTimeoutMs, requestTimeoutMs),
    maxRetries: nonNegativeInt(
      model.maxRetries,
      DEFAULT_PROVIDER_MAX_RETRIES
    ),
  };
}

export function createProviderClient(model: ModelConfig, policy = resolveProviderPolicy(model)): OpenAI {
  return new OpenAI({
    baseURL: model.baseURL,
    apiKey: model.apiKey,
    timeout: policy.requestTimeoutMs,
    maxRetries: 0,
  });
}

export interface ProviderRuntime {
  readonly client: OpenAI;
  readonly policy: ProviderPolicy;
  ready?(): Promise<void>;
  createChatCompletion(
    request: ChatCompletionCreateParamsNonStreaming,
    options?: ProviderRunOptions
  ): Promise<ChatCompletion>;
  createStreamingChatCompletion(
    request: ChatCompletionCreateParamsStreaming,
    options?: ProviderRunOptions
  ): Promise<AsyncIterable<ChatCompletionChunk>>;
  getProviderState?(): ProviderSessionState | null;
  getMemoryController?(): AgoraMemoryController | null;
  /** Local/direct service only: freeze the actual adapter-native payload for this call. */
  prepareModelRequest?(context: ModelCallContext, request: ChatCompletionCreateParamsStreaming): Promise<string>;
  discardPreparedModelRequest?(callId: string): void;
  close?(): Promise<void>;
}

function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as any;
  return anyErr.name === 'AbortError' || anyErr.name === 'APIUserAbortError';
}

function isTimeoutLike(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as any;
  return (
    anyErr.name === 'APIConnectionTimeoutError' ||
    anyErr.code === 'ETIMEDOUT' ||
    anyErr.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    anyErr.code === 'provider_request_timeout'
  );
}

function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof ProviderStreamIdleTimeoutError) return err.retryable;
  if (err instanceof ProviderRequestTimeoutError) return true;
  if (isAbortLike(err)) return false;

  const status = (err as any)?.status;
  if (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500)
  ) {
    return true;
  }
  if (isTimeoutLike(err)) return true;
  const name = (err as any)?.name;
  return name === 'APIConnectionError';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown provider error';
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      timeout = setTimeout(() => {
        reject(new ProviderRequestTimeoutError(timeoutMs));
      }, timeoutMs);
      onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject);
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

interface StreamStart<T> {
  iterator: AsyncIterator<T>;
  first: IteratorResult<T>;
}

async function openStreamAndReadFirstChunk<T>(
  open: () => Promise<AsyncIterable<T>>,
  policy: ProviderPolicy,
  signal?: AbortSignal
): Promise<StreamStart<T>> {
  const stream = await raceWithTimeout(
    open(),
    policy.requestTimeoutMs,
    signal
  );
  const iterator = stream[Symbol.asyncIterator]();
  try {
    const first = await raceWithTimeout(
      iterator.next(),
      policy.streamIdleTimeoutMs,
      signal
    );
    return { iterator, first };
  } catch (err) {
    await iterator.return?.();
    if (err instanceof ProviderRequestTimeoutError) {
      throw new ProviderStreamIdleTimeoutError(
        policy.streamIdleTimeoutMs,
        true
      );
    }
    throw err;
  }
}

function continueStreamAfterFirstChunk<T>(
  start: StreamStart<T>,
  timeoutMs: number,
  signal?: AbortSignal
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      let emitted = false;
      try {
        if (!start.first.done) {
          emitted = true;
          yield start.first.value;
        }

        while (!start.first.done) {
          if (signal?.aborted) {
            throw signal.reason ?? new DOMException('Aborted', 'AbortError');
          }
          try {
            const result = await raceWithTimeout(
              start.iterator.next(),
              timeoutMs,
              signal
            );
            if (result.done) return;
            emitted = true;
            yield result.value;
          } catch (err) {
            if (err instanceof ProviderRequestTimeoutError) {
              throw new ProviderStreamIdleTimeoutError(timeoutMs, !emitted);
            }
            throw err;
          }
        }
      } finally {
        await start.iterator.return?.();
      }
    },
  };
}

function pRetryAbort(err: unknown): never {
  throw new PRetryAbortError(
    err instanceof Error ? err : new Error(errorMessage(err))
  );
}

export function createProviderRuntime(
  model: ModelConfig,
  overrideClient?: OpenAI,
  context?: AgoraProviderContext & { standalone?: boolean }
): ProviderRuntime {
  const policy = resolveProviderPolicy(model);
  if (model.provider?.toLowerCase() === 'agora') {
    return createAgoraProviderRuntime(model, policy, context) as unknown as ProviderRuntime;
  }
  const client = overrideClient ?? createProviderClient(model, policy);
  const maxAttempts = policy.maxRetries + 1;

  async function runWithRetry<T>(
    stream: boolean,
    fn: (attempt: number) => Promise<T>,
    options: ProviderRunOptions = {}
  ): Promise<T> {
    return pRetry(
      async (attempt) => {
        if (options.signal?.aborted) {
          pRetryAbort(options.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        }
        options.onEvent?.({
          type: 'attempt',
          attempt,
          maxAttempts,
          timeoutMs: stream ? policy.streamIdleTimeoutMs : policy.requestTimeoutMs,
          stream,
        });
        try {
          return await fn(attempt);
        } catch (err) {
          if (!isRetryableProviderError(err)) pRetryAbort(err);
          throw err;
        }
      },
      {
        retries: policy.maxRetries,
        factor: 2,
        minTimeout: 1000,
        maxTimeout: 8000,
        randomize: true,
        signal: options.signal,
        onFailedAttempt: ({ error, attemptNumber, retriesLeft, retryDelay }) => {
          if (retriesLeft <= 0) return;
          options.onEvent?.({
            type: 'retry',
            attempt: attemptNumber,
            nextAttempt: attemptNumber + 1,
            retriesLeft,
            maxRetries: policy.maxRetries,
            delayMs: retryDelay,
            error: errorMessage(error),
            stream,
          });
        },
        shouldRetry: ({ error }) => isRetryableProviderError(error),
      }
    );
  }

  const codec = resolveProviderCodec(model);
  const buildNativeRequest = (request: ChatCompletionCreateParamsStreaming): ChatCompletionCreateParamsStreaming => {
    const extras = { ...(model.extraParams ?? {}) };
    for (const key of ['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'mteam_operation', 'preparedQuote']) {
      if (Object.hasOwn(extras, key)) throw new Error('MA_MODEL_CONFIG_OVERRIDE_FORBIDDEN');
    }
    return {
      ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
      ...(model.topP !== undefined ? { top_p: model.topP } : {}),
      ...(model.presencePenalty !== undefined ? { presence_penalty: model.presencePenalty } : {}),
      ...(model.frequencyPenalty !== undefined ? { frequency_penalty: model.frequencyPenalty } : {}),
      ...(model.topK !== undefined ? { top_k: model.topK } : {}),
      ...(model.minP !== undefined ? { min_p: model.minP } : {}),
      ...(model.repeatPenalty !== undefined ? { repeat_penalty: model.repeatPenalty } : {}),
      ...extras, ...request, messages: codec.encodeMessages(request.messages), stream: true,
    } as ChatCompletionCreateParamsStreaming;
  };
  const directRejection = (error: unknown, options: ProviderRunOptions | undefined, bytes: string): unknown => {
    const body = error instanceof OpenAI.APIError ? error.error : undefined;
    const embedded = body && typeof body === 'object' ? body as Record<string, unknown> : undefined;
    const nested = embedded?.error && typeof embedded.error === 'object' ? embedded.error as Record<string, unknown> : undefined;
    if (!context?.standalone || !options?.modelContext || !(error instanceof OpenAI.APIError)
      || ![400, 401, 403, 404, 422].includes(error.status ?? 0) || !embedded || Array.isArray(embedded)
      || Object.hasOwn(embedded, 'execution') || (nested && Object.hasOwn(nested, 'execution'))
      || Object.keys(options.headers ?? {}).some(name => name.toLowerCase().startsWith('x-mteam-ma-'))) return error;
    const code = error.status === 401 ? 'UNAUTHORIZED' : error.status === 403 ? 'FORBIDDEN'
      : error.status === 404 ? 'MODEL_UNAVAILABLE' : 'MA_MODEL_REQUEST_REJECTED';
    return Object.assign(new Error(code), { code, cause: error, error: { code, retryable: false,
      execution: { callId: options.modelContext.callId, dispatchState: 'confirmed', providerAcceptance: 'not_accepted',
        supplierRequestSha256: createHash('sha256').update(bytes, 'utf8').digest('hex') } } });
  };
  const preparedRequests = new Map<string, string>();
  const nativeRequest = (request: ChatCompletionCreateParamsStreaming, options?: ProviderRunOptions): { params: ChatCompletionCreateParamsStreaming; bytes: string } => {
    // OpenAI 4.x serializes JSON bodies with a two-space indent in its public client.
    const bytes = JSON.stringify(options?.modelContext ? buildNativeRequest(request) : { ...request, stream: true }, null, 2);
    const prepared = options?.modelContext ? preparedRequests.get(options.modelContext.callId) : undefined;
    if (prepared !== undefined) {
      preparedRequests.delete(options!.modelContext!.callId);
      if (prepared !== bytes) throw new Error('MA_MODEL_PREPARATION_MISMATCH');
    }
    return { params: JSON.parse(prepared ?? bytes) as ChatCompletionCreateParamsStreaming, bytes: prepared ?? bytes };
  };
  return {
    client,
    policy,
    discardPreparedModelRequest(callId) { preparedRequests.delete(callId); },
    async prepareModelRequest(context, request) {
      const bytes = JSON.stringify(buildNativeRequest(request), null, 2);
      if (preparedRequests.size >= 256 || preparedRequests.has(context.callId)) throw new Error('MA_MODEL_PREPARATION_CONFLICT');
      preparedRequests.set(context.callId, bytes);
      return createHash('sha256').update(bytes, 'utf8').digest('hex');
    },
    createChatCompletion(request, options) {
      return runWithRetry(
        false,
        () =>
          raceWithTimeout(
            client.chat.completions.create(
              { ...request, stream: false },
              { signal: options?.signal, headers: options?.headers } as RequestOptions
            ) as unknown as Promise<ChatCompletion>,
            policy.requestTimeoutMs,
            options?.signal
          ),
        options
      );
    },
    createStreamingChatCompletion(request, options) {
      const frozen = nativeRequest(request, options);
      const bytes = Buffer.from(frozen.bytes, 'utf8');
      // OpenAI 4.x preserves DataView ranges, but widens other ArrayBuffer views
      // to their entire backing buffer. A small Node Buffer may share a pool.
      const body = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return runWithRetry(
        true,
        async () => {
          const start = await openStreamAndReadFirstChunk(
            () =>
              client.chat.completions.create(
              frozen.params,
              // This public override sends exactly the bytes approved by the native hash.
              { body, signal: options?.signal, headers: options?.headers } as RequestOptions
              ) as unknown as Promise<AsyncIterable<ChatCompletionChunk>>,
            policy,
            options?.signal
          );
          return continueStreamAfterFirstChunk(
            start,
            policy.streamIdleTimeoutMs,
            options?.signal
          );
        },
        options
      ).catch(error => { throw directRejection(error, options, frozen.bytes); });
    },
  };
}

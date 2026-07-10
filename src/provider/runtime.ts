import OpenAI from 'openai';
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
      timeout.unref?.();
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
  context?: AgoraProviderContext
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

  return {
    client,
    policy,
    createChatCompletion(request, options) {
      return runWithRetry(
        false,
        () =>
          raceWithTimeout(
            client.chat.completions.create(
              { ...request, stream: false },
              { signal: options?.signal } as RequestOptions
            ) as unknown as Promise<ChatCompletion>,
            policy.requestTimeoutMs,
            options?.signal
          ),
        options
      );
    },
    createStreamingChatCompletion(request, options) {
      return runWithRetry(
        true,
        async () => {
          const start = await openStreamAndReadFirstChunk(
            () =>
              client.chat.completions.create(
              { ...request, stream: true },
              { signal: options?.signal } as RequestOptions
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
      );
    },
  };
}

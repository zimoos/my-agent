import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type FetchFunction,
  type Model,
  type OpenAICompletionsCompat,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';

// ProviderConfigInput is not a root export; derive it from the public registration API.
type ProviderConfigInput = Parameters<ModelRuntime['registerProvider']>[1];
type CodecStream = NonNullable<ProviderConfigInput['streamSimple']>;
interface CodecOptions {
  execute(
    params: ChatCompletionCreateParamsStreaming,
    options: { signal: AbortSignal },
  ): Promise<AsyncIterable<ChatCompletionChunk>>;
}

const CODEC_BASE_URL = 'https://ma-codec.invalid/v1';
const CODEC_COMPLETIONS_URL = `${CODEC_BASE_URL}/chat/completions`;
const ERROR_MESSAGE = 'MA model request could not be completed.';
const ABORT_MESSAGE = 'MA model request was cancelled.';
const encoder = new TextEncoder();
const COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
  maxTokensField: 'max_tokens',
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: 'openai',
  zaiToolStream: false,
  supportsThinkingTokenBudget: false,
  supportsStrictMode: false,
  supportsOpenAIGrammarTools: false,
  supportsMidConvoSystemMessages: false,
  supportsMidConvoToolAdditions: false,
  sendSessionAffinityHeaders: false,
  sessionAffinityFormat: 'openai',
  supportsLongCacheRetention: false,
};

function failure(): Error {
  return new Error(ERROR_MESSAGE);
}

function aborted(): Error {
  return new DOMException(ABORT_MESSAGE, 'AbortError');
}

function errorMessage(model: Model<any>, cancelled: boolean): AssistantMessage {
  return {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: cancelled ? 'aborted' : 'error',
    errorMessage: cancelled ? ABORT_MESSAGE : ERROR_MESSAGE,
    timestamp: Date.now(),
  };
}

function sampling(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
  // Sampling extensions cannot replace the selected identity, transcript or tool contract.
  const reserved = ['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options'];
  if (reserved.some(key => Object.hasOwn(value, key))) throw failure();
  return structuredClone(value);
}

function requestParams(body: string, modelId: string): ChatCompletionCreateParamsStreaming {
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
  const data = value as Record<string, unknown>;
  const streamOptions = data.stream_options;
  if (data.model !== modelId || data.stream !== true || !Array.isArray(data.messages)
    || !streamOptions || typeof streamOptions !== 'object'
    || (streamOptions as Record<string, unknown>).include_usage !== true) throw failure();
  if (data.tools !== undefined && (!Array.isArray(data.tools) || data.tools.some(tool =>
    !tool || typeof tool !== 'object' || tool.type !== 'function'))) throw failure();
  return data as unknown as ChatCompletionCreateParamsStreaming;
}

/** Reject promptly on cancellation while still observing a late execution/iterator result. */
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      // Observe even a rejected promise when the signal was already aborted.
      promise.then(resolve, reject);
      if (signal.aborted) { reject(aborted()); return; }
      listener = () => reject(aborted());
      signal.addEventListener('abort', listener, { once: true });
    });
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}

/**
 * Pi owns both codecs. execute is the sole actual model-service execution boundary.
 * This adapter issues no identity, permission, budget, retry or supplier-success receipt.
 */
export function createPiOpenAiCodec(options: CodecOptions): CodecStream {
  const descriptor = options && Object.getOwnPropertyDescriptor(options, 'execute');
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    throw new TypeError('Invalid MA codec execution configuration.');
  }
  const execute: CodecOptions['execute'] = descriptor.value;

  return (model, context, options) => {
    const selectedId = model.id;
    const output = createAssistantMessageEventStream();
    const controller = new AbortController();
    const signals = new Map<AbortSignal, () => void>();
    let iterator: AsyncIterator<ChatCompletionChunk> | undefined;
    let iteratorClosed = false;
    let closed = false;
    let fetchUsed = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let sourceClose: Promise<void> | undefined;
    let userCancelled = false;

    function closeSource(): Promise<void> {
      closed = true;
      if (iterator && !iteratorClosed) {
        iteratorClosed = true;
        // A late iterator is closed even if cancellation happened before execute resolved.
        sourceClose = Promise.resolve().then(() => iterator!.return?.()).then(() => undefined, () => undefined);
      }
      return sourceClose ?? Promise.resolve();
    }

    function cancel(): void {
      if (!controller.signal.aborted) controller.abort(aborted());
      try { bodyController?.error(aborted()); } catch { /* The body may already be terminal. */ }
      void closeSource();
    }

    function link(signal: AbortSignal | undefined, fromUser = false): void {
      if (!signal || signals.has(signal)) return;
      const listener = () => {
        if (fromUser) userCancelled = true;
        cancel();
      };
      signals.set(signal, listener);
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    }

    const fetch: FetchFunction = async (input, init) => {
      try {
        if (fetchUsed || controller.signal.aborted || closed) throw failure();
        fetchUsed = true;
        const request = input instanceof Request ? input : undefined;
        const url = request?.url ?? String(input);
        const method = init?.method ?? request?.method ?? 'GET';
        if (url !== CODEC_COMPLETIONS_URL || method !== 'POST') throw failure();
        link(init?.signal ?? request?.signal);
        if (controller.signal.aborted) throw aborted();
        const body = typeof init?.body === 'string' ? init.body
          : request && init?.body === undefined ? await request.text() : undefined;
        if (typeof body !== 'string') throw failure();
        const params = requestParams(body, selectedId);
        if (controller.signal.aborted) throw aborted();
        const opening = Promise.resolve().then(async () => {
          if (controller.signal.aborted || closed) throw aborted();
          const result = await execute(params, { signal: controller.signal });
          iterator = result[Symbol.asyncIterator]();
          if (!iterator || typeof iterator.next !== 'function') throw failure();
          if (closed || controller.signal.aborted) {
            await closeSource();
            throw aborted();
          }
          return iterator;
        });
        await withAbort(opening, controller.signal);
        if (controller.signal.aborted || closed) throw aborted();

        const bodyStream = new ReadableStream<Uint8Array>({
          start(streamController) { bodyController = streamController; },
          async pull(streamController) {
            try {
              if (closed || controller.signal.aborted || !iterator) throw aborted();
              const chunk = await withAbort(Promise.resolve().then(() => iterator!.next()), controller.signal);
              if (closed || controller.signal.aborted) throw aborted();
              if (chunk.done) {
                streamController.enqueue(encoder.encode('data: [DONE]\n\n'));
                streamController.close();
                await closeSource();
              } else {
                streamController.enqueue(encoder.encode(`data: ${JSON.stringify(chunk.value)}\n\n`));
              }
            } catch {
              try { streamController.error(controller.signal.aborted ? aborted() : failure()); } catch { /* Already closed. */ }
              await closeSource();
            }
          },
          async cancel() {
            cancel();
            await closeSource();
          },
        }, { highWaterMark: 0 });
        // This response exists only to feed Pi's public codec, not to attest supplier success.
        return new Response(bodyStream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      } catch {
        void closeSource();
        throw controller.signal.aborted ? aborted() : failure();
      }
    };

    void (async () => {
      try {
        link(options?.signal, true);
        if (controller.signal.aborted) throw aborted();
        if (model.api !== 'openai-completions'
          || (options?.toolChoice !== undefined && options.toolChoice !== 'auto' && options.toolChoice !== 'none')
          || (options?.deferred !== undefined && options.deferred !== false)) throw failure();
        const selected = structuredClone(model) as Model<'openai-completions'>;
        selected.baseUrl = CODEC_BASE_URL;
        delete selected.headers;
        selected.compat = { ...COMPAT };
        selected.samplingParams = sampling(selected.samplingParams);
        const codecOptions: SimpleStreamOptions = {
          temperature: options?.temperature, maxTokens: options?.maxTokens,
          reasoning: options?.reasoning, toolChoice: options?.toolChoice,
          thinkingBudgets: options?.thinkingBudgets ? structuredClone(options.thinkingBudgets) : undefined,
          samplingParams: sampling(options?.samplingParams), timeoutMs: options?.timeoutMs,
          signal: options?.signal, fetch, apiKey: 'ma-codec-non-secret',
          maxRetries: 0, cacheRetention: 'none', transport: 'sse',
        };
        const transcript = normalizeContext({ messages: structuredClone(context.messages) });
        const stream = streamSimple(selected, transcript, codecOptions);
        for await (const event of stream) {
          if (event.type === 'done' || event.type === 'error') await closeSource();
          if (event.type === 'error') {
            const reason = userCancelled ? 'aborted' : 'error';
            const { diagnostics: _diagnostics, rawStopReason: _rawStopReason, ...message } = event.error;
            output.push({
              type: 'error', reason,
              error: { ...message, stopReason: reason, errorMessage: userCancelled ? ABORT_MESSAGE : ERROR_MESSAGE },
            });
          } else output.push(event);
        }
        output.end();
      } catch {
        await closeSource();
        const message = errorMessage(model, userCancelled);
        output.push({ type: 'error', reason: userCancelled ? 'aborted' : 'error', error: message });
        output.end();
      } finally {
        await closeSource();
        for (const [signal, listener] of signals) signal.removeEventListener('abort', listener);
        signals.clear();
      }
    })();
    return output;
  };
}

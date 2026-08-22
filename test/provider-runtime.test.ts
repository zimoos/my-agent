import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderRuntime,
  DEFAULT_PROVIDER_MAX_RETRIES,
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  ProviderStreamIdleTimeoutError,
  resolveProviderPolicy,
} from '../src/provider/runtime.js';
import { summarizeContextItems } from '../src/agent/summarize.js';

function fakeClient(create: (...args: any[]) => any): any {
  return {
    chat: {
      completions: {
        create,
      },
    },
  };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function chunks(values: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield value;
    },
  };
}

function firstThenStall(value: any): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        async next() {
          if (!sent) {
            sent = true;
            return { done: false, value };
          }
          return never<IteratorResult<any>>();
        },
        async return() {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function stallBeforeFirst(): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return never<IteratorResult<any>>();
        },
        async return() {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

async function collect(iterable: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('provider runtime: default policy is 3 minutes and 5 retries', () => {
  const policy = resolveProviderPolicy({
    baseURL: 'http://example.test/v1',
    model: 'stub',
    apiKey: 'key',
  });
  assert.equal(policy.requestTimeoutMs, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
  assert.equal(policy.streamIdleTimeoutMs, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
  assert.equal(policy.maxRetries, DEFAULT_PROVIDER_MAX_RETRIES);
});

test('provider runtime: invalid policy values fall back to defaults', () => {
  const policy = resolveProviderPolicy({
    baseURL: 'http://example.test/v1',
    model: 'stub',
    apiKey: 'key',
    requestTimeoutMs: -1,
    streamIdleTimeoutMs: 0,
    maxRetries: -1,
  });
  assert.equal(policy.requestTimeoutMs, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
  assert.equal(policy.streamIdleTimeoutMs, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
  assert.equal(policy.maxRetries, DEFAULT_PROVIDER_MAX_RETRIES);
});

test('provider runtime: request timeout is retried', async () => {
  let calls = 0;
  const runtime = createProviderRuntime(
    {
      baseURL: 'http://example.test/v1',
      model: 'stub',
      apiKey: 'key',
      requestTimeoutMs: 5,
      maxRetries: 1,
    },
    fakeClient(() => {
      calls++;
      if (calls === 1) return never();
      return Promise.resolve({
        choices: [{ message: { content: 'ok' } }],
      });
    })
  );

  const events: any[] = [];
  const resp = await runtime.createChatCompletion(
    { model: 'stub', messages: [], stream: false },
    { onEvent: (event) => events.push(event) }
  );

  assert.equal(calls, 2);
  assert.equal((resp as any).choices[0].message.content, 'ok');
  assert.ok(events.some((event) => event.type === 'retry'));
});

test('provider runtime: reuses one logical call id across retries and rotates it for the next call', async () => {
  const requestOptions: any[] = [];
  let attempts = 0;
  const runtime = createProviderRuntime(
    {
      baseURL: 'http://example.test/v1',
      model: 'stub',
      apiKey: 'key',
      callIdHeader: 'X-MTEAM-MA-Call-ID',
      requestTimeoutMs: 50,
      maxRetries: 1,
    },
    fakeClient((_request, options) => {
      requestOptions.push(options);
      attempts++;
      if (attempts === 1) {
        const error = new Error('temporary failure') as Error & { status: number };
        error.status = 503;
        return Promise.reject(error);
      }
      return Promise.resolve({ choices: [{ message: { content: 'ok' } }] });
    })
  );

  await runtime.createChatCompletion({ model: 'stub', messages: [], stream: false });
  await runtime.createChatCompletion({ model: 'stub', messages: [], stream: false });

  const ids = requestOptions.map((options) => options.headers['x-mteam-ma-call-id']);
  assert.match(ids[0], /^ma_call_[0-9a-f-]{36}$/);
  assert.equal(ids[1], ids[0]);
  assert.notEqual(ids[2], ids[0]);
});

test('provider runtime: does not emit a call id header without an explicit provider opt-in', async () => {
  let captured: any;
  const runtime = createProviderRuntime(
    {
      baseURL: 'http://example.test/v1',
      model: 'stub',
      apiKey: 'key',
      maxRetries: 0,
    },
    fakeClient((_request, options) => {
      captured = options;
      return Promise.resolve({ choices: [] });
    })
  );

  await runtime.createChatCompletion({ model: 'stub', messages: [], stream: false });
  assert.equal(captured.headers, undefined);
});

test('provider runtime: honors an explicit non-retryable provider error', async () => {
  let calls = 0;
  const runtime = createProviderRuntime(
    {
      baseURL: 'http://example.test/v1',
      model: 'stub',
      apiKey: 'key',
      maxRetries: 3,
    },
    fakeClient(() => {
      calls++;
      const error = new Error('authority unavailable') as Error & {
        status: number;
        error: { retryable: boolean };
      };
      error.status = 503;
      error.error = { retryable: false };
      return Promise.reject(error);
    })
  );

  await assert.rejects(
    () => runtime.createChatCompletion({ model: 'stub', messages: [], stream: false }),
    /authority unavailable/
  );
  assert.equal(calls, 1);
});

test('provider runtime: stream idle before first chunk is retried', async () => {
  let calls = 0;
  const requestOptions: any[] = [];
  const runtime = createProviderRuntime(
    {
      baseURL: 'http://example.test/v1',
      model: 'stub',
      apiKey: 'key',
      requestTimeoutMs: 20,
      streamIdleTimeoutMs: 5,
      maxRetries: 1,
      callIdHeader: 'x-mteam-ma-call-id',
    },
    fakeClient((_request, options) => {
      requestOptions.push(options);
      calls++;
      if (calls === 1) return Promise.resolve(stallBeforeFirst());
      return Promise.resolve(chunks([
        { choices: [{ delta: { content: 'ok' } }] },
      ]));
    })
  );

  const events: any[] = [];
  const stream = await runtime.createStreamingChatCompletion(
    { model: 'stub', messages: [], stream: true },
    { onEvent: (event) => events.push(event) }
  );
  const out = await collect(stream);

  assert.equal(calls, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].choices[0].delta.content, 'ok');
  assert.equal(
    requestOptions[0].headers['x-mteam-ma-call-id'],
    requestOptions[1].headers['x-mteam-ma-call-id'],
  );
  assert.ok(events.some((event) => event.type === 'retry'));
});

test('provider runtime: stream idle after first chunk is not retried', async () => {
  let calls = 0;
  const runtime = createProviderRuntime(
    {
      baseURL: 'http://example.test/v1',
      model: 'stub',
      apiKey: 'key',
      requestTimeoutMs: 20,
      streamIdleTimeoutMs: 5,
      maxRetries: 3,
    },
    fakeClient(() => {
      calls++;
      return Promise.resolve(firstThenStall({
        choices: [{ delta: { content: 'partial' } }],
      }));
    })
  );

  const stream = await runtime.createStreamingChatCompletion({
    model: 'stub',
    messages: [],
    stream: true,
  });

  await assert.rejects(
    async () => collect(stream),
    (err: any) => {
      assert.ok(err instanceof ProviderStreamIdleTimeoutError);
      assert.equal(err.retryable, false);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test('provider runtime: user abort is not retried', async () => {
  let calls = 0;
  const runtime = createProviderRuntime(
    {
      baseURL: 'http://example.test/v1',
      model: 'stub',
      apiKey: 'key',
      requestTimeoutMs: 20,
      maxRetries: 3,
    },
    fakeClient(() => {
      calls++;
      return Promise.resolve({ choices: [] });
    })
  );
  const controller = new AbortController();
  controller.abort(new Error('user aborted'));

  await assert.rejects(
    () =>
      runtime.createChatCompletion(
        { model: 'stub', messages: [], stream: false },
        { signal: controller.signal }
      ),
    /user aborted/
  );
  assert.equal(calls, 0);
});

test('summarizeContextItems: uses provider runtime completion path', async () => {
  let captured: any;
  const runtime = {
    createChatCompletion: async (request: any, options: any) => {
      captured = { request, options };
      return {
        choices: [
          {
            message: {
              content: '{"items":[{"i":7,"summary":"保留路径 src/a.ts 和错误原因"}]}',
            },
          },
        ],
      };
    },
  } as any;
  const controller = new AbortController();

  const out = await summarizeContextItems(
    runtime,
    'stub-model',
    [{ i: 7, role: 'assistant', content: 'long content' }],
    controller.signal
  );

  assert.equal(captured.request.model, 'stub-model');
  assert.equal(captured.request.stream, false);
  assert.equal(captured.options.signal, controller.signal);
  assert.deepEqual(out, [
    { i: 7, summary: '保留路径 src/a.ts 和错误原因' },
  ]);
});

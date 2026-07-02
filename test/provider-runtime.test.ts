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

test('provider runtime: stream idle before first chunk is retried', async () => {
  let calls = 0;
  const runtime = createProviderRuntime(
    {
      baseURL: 'http://example.test/v1',
      model: 'stub',
      apiKey: 'key',
      requestTimeoutMs: 20,
      streamIdleTimeoutMs: 5,
      maxRetries: 1,
    },
    fakeClient(() => {
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

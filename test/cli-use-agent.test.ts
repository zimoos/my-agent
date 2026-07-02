import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAgentEvent } from '../src/cli/hooks/useAgent.js';
import { createUiStore } from '../src/cli/state/store.js';

test('applyAgentEvent: renders plan content and hides successful enter_plan_mode result', () => {
  const store = createUiStore();
  store.startThinking();

  applyAgentEvent(
    store,
    { type: 'tool:call', name: 'enter_plan_mode', args: { plan: 'hidden' } },
    {}
  );
  applyAgentEvent(
    store,
    { type: 'plan', content: '## 技术方案\n\n1. 先读代码\n2. 再实现' },
    {}
  );
  applyAgentEvent(
    store,
    {
      type: 'tool:result',
      ok: true,
      content: '[plan]\n## 技术方案\n[/plan]\n\n等待用户确认...',
    },
    {}
  );

  const state = store.getState();
  const assistant = state.messages.filter((m) => m.kind === 'assistant');
  const tools = state.messages.filter((m) => m.kind === 'tool');

  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].markdown, '## 技术方案\n\n1. 先读代码\n2. 再实现');
  assert.equal(tools.length, 0);
  assert.equal(state.thinking?.event, '等待方案确认');
});

test('applyAgentEvent: provider attempt and retry update visible status', () => {
  const store = createUiStore();
  store.startThinking();

  applyAgentEvent(
    store,
    {
      type: 'provider:attempt',
      attempt: 1,
      maxAttempts: 6,
      timeoutMs: 180_000,
      stream: true,
    },
    {}
  );
  assert.equal(store.getState().thinking?.event, '等待模型响应 · 180s 超时');

  applyAgentEvent(
    store,
    {
      type: 'provider:retry',
      attempt: 1,
      nextAttempt: 2,
      retriesLeft: 5,
      maxRetries: 5,
      delayMs: 1000,
      error: 'provider request timed out',
      stream: true,
    },
    {}
  );

  const state = store.getState();
  assert.equal(state.thinking?.event, '准备重试 1/5');
  const system = state.messages.filter((m) => m.kind === 'system');
  assert.equal(system.length, 1);
  assert.match(system[0].text, /第 1\/5 次重试/);
  assert.match(system[0].text, /provider request timed out/);
});

test('applyAgentEvent: retry attempts keep n/5 semantics after the first wait', () => {
  const store = createUiStore();
  store.startThinking();

  applyAgentEvent(
    store,
    {
      type: 'provider:attempt',
      attempt: 3,
      maxAttempts: 6,
      timeoutMs: 180_000,
      stream: true,
    },
    {}
  );

  assert.equal(store.getState().thinking?.event, '等待模型响应（重试 2/5）· 180s 超时');
});

test('applyAgentEvent: progress is rendered as visible system message', () => {
  const store = createUiStore();
  store.startThinking();
  store.appendToken('前置回答');

  applyAgentEvent(
    store,
    {
      type: 'progress',
      message: '已执行 4 个工具调用，最近：read_file src/a.ts 完成。继续基于这些结果推进。',
    },
    {}
  );

  const state = store.getState();
  const assistant = state.messages.filter((m) => m.kind === 'assistant');
  const system = state.messages.filter((m) => m.kind === 'system');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].markdown, '前置回答');
  assert.equal(system.length, 1);
  assert.match(system[0].text, /\[progress\]/);
  assert.match(system[0].text, /read_file src\/a\.ts/);
  assert.equal(state.thinking?.event, '继续执行中');
});

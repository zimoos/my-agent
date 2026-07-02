import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageStore } from '../src/agent/message-store.js';
import { createUiStore } from '../src/cli/state/store.js';

test('message store: revertLastTurn drops latest user turn only from context', () => {
  const store = new MessageStore();
  store.init('sys');
  store.appendUser('first');
  store.appendAssistant('answer 1');
  store.appendUser('second');
  store.appendAssistant('answer 2');

  const removed = store.revertLastTurn();
  const snapshot = store.snapshot();

  assert.equal(removed, 2);
  assert.deepEqual(
    snapshot.map((m) => m.role),
    ['system', 'user', 'assistant']
  );
  assert.equal(snapshot[1].content, 'first');
  assert.equal(snapshot[2].content, 'answer 1');
});

test('message store: revertLastRootTurn ignores internal user nudges', () => {
  const store = new MessageStore();
  store.init('sys');
  store.appendUser('real request', { rootTurn: true });
  store.appendAssistant('tool result summary');
  store.appendUser('Please provide your answer based on the tool results above.');
  store.appendAssistant('final answer');

  const removed = store.revertLastRootTurn();

  assert.equal(removed, 4);
  assert.deepEqual(
    store.snapshot().map((m) => m.role),
    ['system']
  );
});

test('message store: revertLastRootTurn preserves earlier root turns', () => {
  const store = new MessageStore();
  store.init('sys');
  store.appendUser('first', { rootTurn: true });
  store.appendAssistant('answer 1');
  store.appendUser('second', { rootTurn: true });
  store.appendAssistant('answer 2');

  const removed = store.revertLastRootTurn();
  const snapshot = store.snapshot();

  assert.equal(removed, 2);
  assert.deepEqual(
    snapshot.map((m) => m.role),
    ['system', 'user', 'assistant']
  );
  assert.equal(snapshot[1].content, 'first');
  assert.equal(snapshot[2].content, 'answer 1');
});

test('message store: revertLastTurn returns 0 when there is no user turn', () => {
  const store = new MessageStore();
  store.init('sys');

  assert.equal(store.revertLastTurn(), 0);
  assert.deepEqual(
    store.snapshot().map((m) => m.role),
    ['system']
  );
});

test('message store: request builder keeps full transcript and suffix', () => {
  const store = new MessageStore();
  store.init('sys');
  store.appendUser('original task');
  for (let i = 0; i < 8; i++) {
    store.appendAssistant(`old answer ${i}`);
  }
  store.appendAssistant('recent answer 1');
  store.appendAssistant('recent answer 2');

  const request = store.buildRequestMessages('[active context]');

  assert.equal(request[0].role, 'system');
  assert.equal(request[0].content, 'sys');
  assert.equal(request.at(-1)?.role, 'system');
  assert.match(String(request.at(-1)?.content), /\[active context\]/);
  assert.ok(
    request.some((m) => m.role === 'user' && m.content === 'original task'),
    'request must retain the original user message'
  );
  assert.ok(
    request.some((m) => m.role === 'assistant' && m.content === 'old answer 0'),
    'request must not silently tail-slice old transcript messages'
  );
});

test('ui store: revertLastTurn removes visible messages after latest user', () => {
  const store = createUiStore();
  store.pushMessage({ kind: 'banner', id: 'banner', data: { model: 'm', baseURL: 'u', mcp: [] } });
  store.pushMessage({ kind: 'user', id: 'u1', text: 'first' });
  store.pushMessage({ kind: 'assistant', id: 'a1', markdown: 'answer 1', elapsedMs: 0 });
  store.pushMessage({ kind: 'user', id: 'u2', text: 'second' });
  store.pushMessage({ kind: 'tool', id: 't1', name: 'tool', ok: true, preview: 'ok' });
  store.pushMessage({ kind: 'assistant', id: 'a2', markdown: 'answer 2', elapsedMs: 0 });

  assert.equal(store.revertLastTurn(), true);

  assert.deepEqual(
    store.getState().messages.map((m) => m.id),
    ['banner', 'u1', 'a1']
  );
});

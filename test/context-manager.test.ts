import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createContextManager } from '../src/agent/context-manager.js';

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('context manager: persists pins, pool entries, search, and recall', () => {
  const dir = mktmp('ma-context-');
  const ctx = createContextManager('s_test_0000', dir);

  assert.match(ctx.pin('Use TypeScript strict mode'), /Pinned/);
  const entry = ctx.archive({
    role: 'summary',
    text: 'The user decided that recall results must be filtered before entering active context.',
    summary: 'Recall results need filtering before active context admission.',
    archivedReason: 'completed',
  });
  assert.ok(entry);

  const results = ctx.search('recall filtering');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, entry.id);

  assert.match(ctx.recall(entry.id), /Recalled/);
  const prompt = ctx.formatForPrompt();
  assert.match(prompt, /Use TypeScript strict mode/);
  assert.match(prompt, /Recall results need filtering/);
});

test('context manager: applies hidden next-context patch safely', () => {
  const dir = mktmp('ma-context-');
  const ctx = createContextManager('s_test_0001', dir);

  ctx.applyPatch(JSON.stringify({
    activeTask: {
      id: 'task-1',
      title: 'Implement context hygiene',
      state: 'coding',
    },
    pin: ['Do not show hidden patches to users'],
    hygiene: [
      {
        target: 'Old assumption: recall is a second LLM pass',
        action: 'supersede',
        reason: 'User clarified patch is same-turn output',
      },
      {
        target: 'Tool-call pairing rules',
        action: 'protect',
        reason: 'Safety invariant',
      },
    ],
    archiveToPool: [
      {
        reason: 'completed',
        summary: 'Issue #19 scope was corrected to exclude Mnemo for MVP.',
      },
    ],
  }));

  const inspect = ctx.inspect();
  assert.match(inspect, /Implement context hygiene/);
  assert.match(inspect, /Do not show hidden patches/);
  assert.match(inspect, /supersede/);
  assert.match(inspect, /protected/);
  assert.match(inspect, /Session pool entries: 1/);
});

test('context manager: records monotonic transcript ids and applies id-based ops', () => {
  const dir = mktmp('ma-context-');
  const ctx = createContextManager('s_indexed_0000', dir);

  const entries = ctx.recordMessages([
    { role: 'user', content: 'Do not mutate this user message' },
    { role: 'assistant', content: 'Old assistant assumption that can be summarized' },
    { role: 'tool', tool_call_id: 'tc_1', content: 'Tool result can leave active context' },
  ]);

  assert.deepEqual(entries.map((entry) => entry.i), [0, 1, 2]);
  assert.equal(entries[0].immutable, true);
  assert.equal(entries[1].immutable, false);

  ctx.applyPatch(JSON.stringify({
    ops: [
      { i: 0, act: 'edit', res: 'malicious user edit should be ignored' },
      { i: 1, act: 'edit', res: 'Assistant assumption summarized', reason: 'reduce noise' },
      { i: 2, act: 'rm', reason: 'tool result no longer needed' },
    ],
  }));

  const state = ctx.state();
  const userItem = state.activeItems.find((item) => item.i === 0);
  const assistantItem = state.activeItems.find((item) => item.i === 1);
  const toolItem = state.activeItems.find((item) => item.i === 2);

  assert.equal(userItem?.mode, 'protected');
  assert.equal(userItem?.content, 'Do not mutate this user message');
  assert.equal(assistantItem?.mode, 'summary');
  assert.equal(assistantItem?.content, 'Assistant assumption summarized');
  assert.equal(toolItem, undefined);

  const results = ctx.search('tool result');
  assert.ok(results.some((entry) => entry.i === 2));
  assert.match(ctx.recall('2'), /Recalled/);
  assert.equal(ctx.state().activeItems.find((item) => item.i === 2)?.i, 2);
});

test('context manager: rejects half tool-group rm ops', () => {
  const dir = mktmp('ma-context-');
  const ctx = createContextManager('s_tool_group_0000', dir);

  ctx.recordMessages([
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'tc_1', content: 'tool result should stay paired' },
  ]);

  ctx.applyPatch(JSON.stringify({
    ops: [
      { i: 0, act: 'rm', reason: 'half group should be rejected' },
    ],
  }));

  assert.ok(ctx.state().activeItems.some((item) => item.i === 0));
  assert.ok(ctx.state().activeItems.some((item) => item.i === 1));
  assert.equal(ctx.search('tool result').length, 0);

  ctx.applyPatch(JSON.stringify({
    ops: [
      { i: 0, act: 'rm', reason: 'explicit whole group removal' },
      { i: 1, act: 'rm', reason: 'explicit whole group removal' },
    ],
  }));

  assert.equal(ctx.state().activeItems.some((item) => item.i === 0), false);
  assert.equal(ctx.state().activeItems.some((item) => item.i === 1), false);
  assert.ok(ctx.search('tool result').some((entry) => entry.i === 1));
});

test('context manager: rejects half rm for multi-tool assistant groups', () => {
  const dir = mktmp('ma-context-');
  const ctx = createContextManager('s_multi_tool_group_0000', dir);

  ctx.recordMessages([
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'tc_a', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'tc_b', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'tc_a', content: 'result a' },
    { role: 'tool', tool_call_id: 'tc_b', content: 'result b' },
  ]);

  ctx.applyPatch(JSON.stringify({
    ops: [
      { i: 0, act: 'rm', reason: 'assistant only should be rejected' },
      { i: 1, act: 'rm', reason: 'one result only should still be rejected' },
    ],
  }));

  assert.deepEqual(
    ctx.state().activeItems.map((item) => item.i).sort((a, b) => a - b),
    [0, 1, 2]
  );

  ctx.applyPatch(JSON.stringify({
    ops: [
      { i: 0, act: 'rm', reason: 'whole multi-tool group' },
      { i: 1, act: 'rm', reason: 'whole multi-tool group' },
      { i: 2, act: 'rm', reason: 'whole multi-tool group' },
    ],
  }));

  assert.equal(ctx.state().activeItems.length, 0);
});

test('context manager: ensureIndexed backfills old sessions once', () => {
  const dir = mktmp('ma-context-');
  const ctx = createContextManager('s_resume_0000', dir);

  ctx.ensureIndexed([
    { role: 'user', content: 'first old message' },
    { role: 'assistant', content: 'first old response' },
  ]);
  ctx.ensureIndexed([
    { role: 'user', content: 'should not be duplicated' },
  ]);

  const inspect = ctx.inspect();
  assert.match(inspect, /Transcript index entries: 2/);
  assert.match(inspect, /\[i=0 role=user mode=protected\]/);
  assert.match(inspect, /\[i=1 role=assistant mode=raw\]/);
});

test('context manager: builds llm context from active items only', () => {
  const dir = mktmp('ma-context-');
  const ctx = createContextManager('s_llm_context_0000', dir);

  ctx.recordMessages([
    { role: 'user', content: 'current real user task' },
    { role: 'assistant', content: 'active assistant finding' },
    { role: 'tool', tool_call_id: 'tc_1', content: 'active tool result' },
    { role: 'assistant', content: 'cold noisy result' },
  ]);

  ctx.applyPatch(JSON.stringify({
    ops: [
      { i: 3, act: 'rm', reason: 'not needed for current task' },
    ],
  }));

  const messages = ctx.buildLlmContext();
  const text = messages.map((msg) => String(msg.content)).join('\n');

  assert.match(text, /current real user task/);
  assert.match(text, /active assistant finding/);
  assert.match(text, /active tool result/);
  assert.doesNotMatch(text, /cold noisy result/);
  assert.ok(ctx.search('cold noisy result').some((entry) => entry.i === 3));
});

test('context manager: protected user remains active after many tool messages', () => {
  const dir = mktmp('ma-context-');
  const ctx = createContextManager('s_protected_user_0000', dir);

  ctx.recordMessages([{ role: 'user', content: 'do not drop this task' }]);
  for (let i = 0; i < 40; i++) {
    ctx.recordMessages([
      { role: 'tool', tool_call_id: `tc_${i}`, content: `tool result ${i}` },
    ]);
  }

  const messages = ctx.buildLlmContext();
  assert.ok(
    messages.some((msg) => msg.role === 'user' && msg.content === 'do not drop this task')
  );
});

import test from 'node:test';
import assert from 'node:assert';
import type { AgentEvent } from '../../../../src/agent/events.js';
import { collectEvents, mergeTraces } from '../event-collector.js';

async function* fromArray(events: AgentEvent[]): AsyncGenerator<AgentEvent, void, unknown> {
  for (const ev of events) {
    yield ev;
  }
}

async function* throwing(
  events: AgentEvent[],
  err: Error
): AsyncGenerator<AgentEvent, void, unknown> {
  for (const ev of events) {
    yield ev;
  }
  throw err;
}

test('collectEvents: token events aggregate into finalText', async () => {
  const gen = fromArray([
    { type: 'task:start', taskId: 't1', prompt: 'hi' },
    { type: 'token', text: 'Hello' },
    { type: 'token', text: ', ' },
    { type: 'token', text: 'world' },
    { type: 'task:done', taskId: 't1' },
  ]);

  const trace = await collectEvents(gen, 't1', 0);

  assert.equal(trace.finalText, 'Hello, world');
  assert.equal(trace.taskId, 't1');
  assert.equal(trace.runIndex, 0);
  assert.equal(trace.messagesCount, 5);
  assert.equal(trace.events.length, 5);
  assert.equal(trace.toolCalls.length, 0);
  assert.equal(trace.hitMaxLoops, false);
  assert.equal(trace.aborted, false);
  assert.equal(trace.crashed, false);
  assert.equal(typeof trace.startedAt, 'number');
  assert.ok(trace.elapsedMs >= 0);
});

test('collectEvents: text event also contributes to finalText (fallback source)', async () => {
  const gen = fromArray([
    { type: 'token', text: 'stream-part' },
    { type: 'text', content: '-and-fallback' },
  ]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.finalText, 'stream-part-and-fallback');
});

test('collectEvents: records context usage, progress and silent tool streak', async () => {
  const gen = fromArray([
    { type: 'context:usage', used: 25_000, total: 1_000_000, compactThreshold: 750_000, source: 'registry' },
    { type: 'tool:call', name: 'read_file', args: { path: 'a.ts' } },
    { type: 'tool:result', ok: true, content: 'a' },
    { type: 'tool:call', name: 'read_file', args: { path: 'b.ts' } },
    { type: 'tool:result', ok: true, content: 'b' },
    { type: 'progress', message: '已执行 2 个工具调用，最近：read_file b.ts 完成。继续基于这些结果推进。' },
    { type: 'tool:call', name: 'grep', args: { pattern: 'x' } },
    { type: 'tool:result', ok: true, content: 'x' },
  ]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.contextWindow, 1_000_000);
  assert.equal(trace.compactThreshold, 750_000);
  assert.equal(trace.maxContextUsed, 25_000);
  assert.equal(trace.progressCount, 1);
  assert.equal(trace.maxSilentToolStreak, 2);
});

test('collectEvents: task failure captures actionable failure summary', async () => {
  const summary = '[失败总结]\n已完成：已执行 4 个工具调用。\n失败点：provider timeout\n下一步：建议检查 provider。';
  const trace = await collectEvents(
    fromArray([
      { type: 'text', content: summary },
      { type: 'task:failed', taskId: 't', error: 'provider timeout' },
    ]),
    't',
    0
  );

  assert.equal(trace.failureSummary, summary);
  assert.equal(trace.errorCount, 1);
});

test('collectEvents: tool:call + tool:result pair into ToolCallRecord (order preserved)', async () => {
  const gen = fromArray([
    { type: 'tool:call', name: 'read_file', args: { path: 'a.ts' } },
    { type: 'tool:result', ok: true, content: 'file body A' },
    { type: 'tool:call', name: 'grep', args: { pattern: 'foo' } },
    { type: 'tool:result', ok: false, content: 'error: not found' },
  ]);

  const trace = await collectEvents(gen, 't', 0);

  assert.equal(trace.toolCalls.length, 2);
  assert.deepEqual(trace.toolCalls[0], {
    name: 'read_file',
    args: { path: 'a.ts' },
    ok: true,
    resultPreview: 'file body A',
  });
  assert.deepEqual(trace.toolCalls[1], {
    name: 'grep',
    args: { pattern: 'foo' },
    ok: false,
    resultPreview: 'error: not found',
  });
});

test('collectEvents: FIFO pairing when multiple tool:calls precede results', async () => {
  const gen = fromArray([
    { type: 'tool:call', name: 'a', args: {} },
    { type: 'tool:call', name: 'b', args: {} },
    { type: 'tool:result', ok: true, content: 'r-a' },
    { type: 'tool:result', ok: true, content: 'r-b' },
  ]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.toolCalls.length, 2);
  assert.equal(trace.toolCalls[0].name, 'a');
  assert.equal(trace.toolCalls[0].resultPreview, 'r-a');
  assert.equal(trace.toolCalls[1].name, 'b');
  assert.equal(trace.toolCalls[1].resultPreview, 'r-b');
});

test('collectEvents: orphan tool:result produces <unknown>', async () => {
  const gen = fromArray([
    { type: 'tool:result', ok: false, content: 'orphan' },
  ]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0].name, '<unknown>');
  assert.equal(trace.toolCalls[0].ok, false);
  assert.equal(trace.toolProtocol?.orphanToolResults, 1);
});

test('collectEvents: resultPreview truncates at 200 chars', async () => {
  const longContent = 'x'.repeat(500);
  const gen = fromArray([
    { type: 'tool:call', name: 'read_file', args: {} },
    { type: 'tool:result', ok: true, content: longContent },
  ]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.toolCalls[0].resultPreview.length, 200);
});

test('collectEvents: thinking:end durationMs accumulates', async () => {
  const gen = fromArray([
    { type: 'thinking:start' },
    { type: 'thinking:end', durationMs: 120 },
    { type: 'thinking:start' },
    { type: 'thinking:end', durationMs: 300 },
  ]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.thinkingMs, 420);
});

test('collectEvents: negative/non-number thinking durations ignored', async () => {
  const gen = fromArray([
    { type: 'thinking:end', durationMs: 100 },
    { type: 'thinking:end', durationMs: -50 },
    { type: 'thinking:end', durationMs: Number.NaN },
  ] as AgentEvent[]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.thinkingMs, 100);
});

test('collectEvents: task:failed with "max loops" sets hitMaxLoops', async () => {
  const gen = fromArray([
    { type: 'task:failed', taskId: 't', error: 'max loops' },
  ]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.hitMaxLoops, true);
});

test('collectEvents: task:failed with "reached max loop count" also triggers hitMaxLoops', async () => {
  const gen = fromArray([
    { type: 'task:failed', taskId: 't', error: 'reached max loop count (25), aborting' },
  ]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.hitMaxLoops, true);
});

test('collectEvents: task:failed with unrelated error does not set hitMaxLoops', async () => {
  const gen = fromArray([
    { type: 'task:failed', taskId: 't', error: 'network timeout' },
  ]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.hitMaxLoops, false);
});

test('collectEvents: task:aborted sets aborted', async () => {
  const gen = fromArray([
    { type: 'task:aborted', taskId: 't' },
  ]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.aborted, true);
});

test('collectEvents: bare aborted event sets aborted', async () => {
  const gen = fromArray([
    { type: 'aborted' },
  ]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.aborted, true);
});

test('collectEvents: generator throws → crashed=true with reason', async () => {
  const gen = throwing(
    [
      { type: 'token', text: 'partial' },
      { type: 'tool:call', name: 'x', args: {} },
    ],
    new Error('boom')
  );

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.crashed, true);
  assert.equal(trace.crashReason, 'boom');
  assert.equal(trace.finalText, 'partial');
  assert.equal(trace.events.length, 2);
});

test('collectEvents: non-Error throw → crashReason uses String()', async () => {
  async function* bad(): AsyncGenerator<AgentEvent, void, unknown> {
    yield { type: 'token', text: 'hi' };
    // eslint-disable-next-line no-throw-literal
    throw 'string-error';
  }

  const trace = await collectEvents(bad(), 't', 0);
  assert.equal(trace.crashed, true);
  assert.equal(trace.crashReason, 'string-error');
});

test('collectEvents: apiCalls counts tool:call + task:done', async () => {
  const gen = fromArray([
    { type: 'tool:call', name: 'a', args: {} },
    { type: 'tool:result', ok: true, content: '' },
    { type: 'tool:call', name: 'b', args: {} },
    { type: 'tool:result', ok: true, content: '' },
    { type: 'task:done', taskId: 't' },
  ]);

  const trace = await collectEvents(gen, 't', 0);
  assert.equal(trace.apiCalls, 3);
});

test('collectEvents: records round, compact, warning, error and unclosed tool metrics', async () => {
  const gen = fromArray([
    { type: 'tool:call', name: 'fs__read_file', args: { path: 'README.md' } },
    { type: 'tool:result', ok: true, content: 'readme' },
    { type: 'tool:call', name: 'fs__read_file', args: { path: 'README.md' } },
    { type: 'tool:result', ok: true, content: 'readme again' },
    { type: 'tool:call', name: 'context_recall', args: { query: 'first constraint' } },
    { type: 'tool:result', ok: false, content: 'miss' },
    { type: 'tool:call', name: 'shell', args: { cmd: 'ma ctx recall abc' } },
    { type: 'compact:done', freed: 1200 },
    { type: 'warning', message: 'near limit' },
    { type: 'token', text: 'done' },
  ]);

  const trace = await collectEvents(gen, 'T', 1, { index: 2, user: 'round text' });

  assert.equal(trace.compactCount, 1);
  assert.equal(trace.contextRecallCount, 2);
  assert.equal(trace.warningCount, 1);
  assert.equal(trace.errorCount, 1);
  assert.equal(trace.repeatedToolCallCount, 1);
  assert.equal(trace.toolProtocol?.unclosedToolCalls, 1);
  assert.equal(trace.rounds?.length, 1);
  assert.equal(trace.rounds?.[0].roundIndex, 2);
  assert.equal(trace.rounds?.[0].user, 'round text');
  assert.equal(trace.rounds?.[0].finalText, 'done');
  assert.equal(trace.toolCalls.every((tc) => tc.roundIndex === 2), true);
});

test('collectEvents: complete realistic run — token stream + tools + thinking + done', async () => {
  const gen = fromArray([
    { type: 'task:start', taskId: 't', prompt: '分析项目' },
    { type: 'thinking:start' },
    { type: 'thinking:end', durationMs: 200 },
    { type: 'tool:call', name: 'list_files', args: { path: '.' } },
    { type: 'tool:result', ok: true, content: 'README.md\npackage.json' },
    { type: 'token', text: '这是' },
    { type: 'token', text: '一个' },
    { type: 'token', text: 'Node 项目' },
    { type: 'task:done', taskId: 't' },
  ]);

  const trace = await collectEvents(gen, 'task-x', 2);
  assert.equal(trace.taskId, 'task-x');
  assert.equal(trace.runIndex, 2);
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.thinkingMs, 200);
  assert.equal(trace.finalText, '这是一个Node 项目');
  assert.equal(trace.hitMaxLoops, false);
  assert.equal(trace.aborted, false);
  assert.equal(trace.crashed, false);
});

test('mergeTraces: empty list throws', () => {
  assert.throws(() => mergeTraces([]), /empty trace list/);
});

test('mergeTraces: single trace returned as-is', async () => {
  const t = await collectEvents(
    fromArray([{ type: 'token', text: 'a' }]),
    'task',
    0
  );
  const merged = mergeTraces([t]);
  assert.strictEqual(merged, t);
});

test('mergeTraces: concatenates events, toolCalls, sums counters, ORs flags', async () => {
  const t1 = await collectEvents(
    fromArray([
      { type: 'tool:call', name: 'a', args: {} },
      { type: 'tool:result', ok: true, content: 'r1' },
      { type: 'token', text: 'round1-answer' },
      { type: 'thinking:end', durationMs: 100 },
      { type: 'task:done', taskId: 't' },
    ]),
    'T',
    0
  );
  const t2 = await collectEvents(
    fromArray([
      { type: 'tool:call', name: 'b', args: {} },
      { type: 'tool:result', ok: false, content: 'r2' },
      { type: 'token', text: 'round2-answer' },
      { type: 'thinking:end', durationMs: 250 },
      { type: 'task:failed', taskId: 't', error: 'max loops' },
    ]),
    'T',
    0
  );

  const m = mergeTraces([t1, t2]);
  assert.equal(m.taskId, 'T');
  assert.equal(m.events.length, t1.events.length + t2.events.length);
  assert.equal(m.toolCalls.length, 2);
  assert.equal(m.toolCalls[0].name, 'a');
  assert.equal(m.toolCalls[1].name, 'b');
  assert.equal(m.finalText, 'round1-answer\nround2-answer');
  assert.equal(m.messagesCount, t1.messagesCount + t2.messagesCount);
  assert.equal(m.thinkingMs, 350);
  assert.equal(m.apiCalls, t1.apiCalls + t2.apiCalls);
  assert.equal(m.elapsedMs, t1.elapsedMs + t2.elapsedMs);
  assert.equal(m.startedAt, t1.startedAt);
  assert.equal(m.hitMaxLoops, true);
  assert.equal(m.aborted, false);
  assert.equal(m.crashed, false);
});

test('mergeTraces: combines behavior metrics and round traces', async () => {
  const t1 = await collectEvents(
    fromArray([
      { type: 'tool:call', name: 'fs__read_file', args: { path: 'a.ts' } },
      { type: 'tool:result', ok: true, content: 'a' },
      { type: 'compact:done', freed: 500 },
      { type: 'warning', message: 'w1' },
      { type: 'token', text: 'one' },
    ]),
    'T',
    0,
    { index: 0, user: 'r1' }
  );
  const t2 = await collectEvents(
    fromArray([
      { type: 'tool:result', ok: false, content: 'orphan' },
      { type: 'tool:call', name: 'fs__read_file', args: { path: 'a.ts' } },
      { type: 'tool:result', ok: true, content: 'a again' },
      { type: 'tool:call', name: 'context_recall', args: { query: 'x' } },
      { type: 'compact:done', freed: 700 },
      { type: 'token', text: 'two' },
    ]),
    'T',
    0,
    { index: 1, user: 'r2' }
  );

  const m = mergeTraces([t1, t2]);

  assert.equal(m.compactCount, 2);
  assert.equal(m.contextRecallCount, 1);
  assert.equal(m.warningCount, 1);
  assert.equal(m.errorCount, 1);
  assert.equal(m.toolProtocol?.orphanToolResults, 1);
  assert.equal(m.toolProtocol?.unclosedToolCalls, 1);
  assert.equal(m.repeatedToolCallCount, 1);
  assert.equal(m.rounds?.length, 2);
});

test('mergeTraces: aborted OR crashed propagates from any round', async () => {
  const t1 = await collectEvents(
    fromArray([{ type: 'token', text: 'a' }]),
    'T',
    0
  );
  const t2 = await collectEvents(
    fromArray([{ type: 'task:aborted', taskId: 'T' }]),
    'T',
    0
  );
  const t3 = await collectEvents(
    throwing([{ type: 'token', text: 'b' }], new Error('died')),
    'T',
    0
  );

  const m = mergeTraces([t1, t2, t3]);
  assert.equal(m.aborted, true);
  assert.equal(m.crashed, true);
  assert.equal(m.crashReason, 'died');
});

test('mergeTraces: skips empty finalText from rounds (no extra \\n)', async () => {
  const t1 = await collectEvents(fromArray([{ type: 'token', text: 'hello' }]), 'T', 0);
  const t2 = await collectEvents(fromArray([]), 'T', 0);
  const t3 = await collectEvents(fromArray([{ type: 'token', text: 'world' }]), 'T', 0);

  const m = mergeTraces([t1, t2, t3]);
  assert.equal(m.finalText, 'hello\nworld');
});

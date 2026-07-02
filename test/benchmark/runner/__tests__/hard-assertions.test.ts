import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateHard } from '../assertions/hard.js';
import type {
  AgentEvent,
  HardAssertion,
  RunTrace,
  ToolCallRecord,
} from '../types.js';

// ─── Factories ───

function makeTrace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    taskId: 'T-test',
    runIndex: 0,
    events: [],
    toolCalls: [],
    finalText: '',
    messagesCount: 0,
    thinkingMs: 0,
    apiCalls: 0,
    startedAt: Date.now(),
    elapsedMs: 0,
    hitMaxLoops: false,
    aborted: false,
    crashed: false,
    ...overrides,
  };
}

function tc(
  name: string,
  args: Record<string, unknown> = {},
  ok: boolean = true,
  resultPreview: string = ''
): ToolCallRecord {
  return { name, args, ok, resultPreview };
}

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hard-assertions-${prefix}-`));
}

// ─── 1. tool_called ───

test('tool_called: pass when exact tool name present', () => {
  const trace = makeTrace({ toolCalls: [tc('fs__read_file', { path: 'README.md' })] });
  const [res] = evaluateHard(
    [{ type: 'tool_called', tool: 'fs__read_file', argsContains: { path: 'README.md' } }],
    trace,
    '/tmp'
  );
  assert.equal(res.passed, true, res.reason);
});

test('tool_called: argsContains relative path matches absolute workspace path', () => {
  const trace = makeTrace({
    toolCalls: [tc('fs__read_file', { path: '/tmp/ma-bench-fixture-x/src/index.js' })],
  });
  const [res] = evaluateHard(
    [{ type: 'tool_called', tool: 'fs__read_file', argsContains: { path: 'src/index.js' } }],
    trace,
    '/tmp'
  );
  assert.equal(res.passed, true, res.reason);
});

test('tool_called: fail when tool not present', () => {
  const trace = makeTrace({ toolCalls: [tc('fs__read_file')] });
  const [res] = evaluateHard([{ type: 'tool_called', tool: 'exec__execute_command' }], trace, '/tmp');
  assert.equal(res.passed, false);
});

test('context_window_min: fails when resolved model window is too small', () => {
  const [res] = evaluateHard(
    [{ type: 'context_window_min', min: 1_000_000 }],
    makeTrace({ contextWindow: 32_768 }),
    '/tmp'
  );
  assert.equal(res.passed, false);
  assert.match(res.reason, /32768 < 1000000/);
});

test('no_silent_tool_streak: fails when tools run without visible progress', () => {
  const [res] = evaluateHard(
    [{ type: 'no_silent_tool_streak', max: 4 }],
    makeTrace({ maxSilentToolStreak: 6 }),
    '/tmp'
  );
  assert.equal(res.passed, false);
  assert.match(res.reason, /6 > 4/);
});

test('progress_count_min: fails when no visible progress is emitted', () => {
  const [res] = evaluateHard(
    [{ type: 'progress_count_min', min: 1 }],
    makeTrace({ progressCount: 0 }),
    '/tmp'
  );
  assert.equal(res.passed, false);
  assert.match(res.reason, /0 < 1/);
});

test('task_failure_has_actionable_summary: requires failure summary when task fails', () => {
  const failedTrace = makeTrace({
    events: [{ type: 'task:failed', taskId: 't', error: 'provider timeout' }],
    failureSummary: '[失败总结]\n已完成：已执行 4 个工具调用。\n失败点：provider timeout\n下一步：建议检查 provider。',
  });
  const [passed] = evaluateHard(
    [{ type: 'task_failure_has_actionable_summary' }],
    failedTrace,
    '/tmp'
  );
  assert.equal(passed.passed, true, passed.reason);

  const missingTrace = makeTrace({
    events: [{ type: 'task:failed', taskId: 't', error: 'provider timeout' }],
    failureSummary: 'timeout',
  });
  const [failed] = evaluateHard(
    [{ type: 'task_failure_has_actionable_summary' }],
    missingTrace,
    '/tmp'
  );
  assert.equal(failed.passed, false);
});

test('task_failure_has_actionable_summary: also covers handled tool failures', () => {
  const [res] = evaluateHard(
    [{ type: 'task_failure_has_actionable_summary' }],
    makeTrace({
      errorCount: 1,
      finalText: '操作失败。已完成：尝试读取目录。失败点：目录不存在。下一步：请确认路径后重试。',
    }),
    '/tmp'
  );
  assert.equal(res.passed, true, res.reason);
});

test('compact_failure_has_user_summary: requires compact failure plus actionable summary', () => {
  const trace = makeTrace({
    events: [{ type: 'task:failed', taskId: 't', error: 'active context still too large after compaction' }],
    failureSummary: '[失败总结]\n已完成：读取多个文件。\n失败点：active context still too large after compaction\n下一步：建议减少活跃上下文。',
  });
  const [res] = evaluateHard(
    [{ type: 'compact_failure_has_user_summary' }],
    trace,
    '/tmp'
  );
  assert.equal(res.passed, true, res.reason);
});

test('tool_called: regex toolMatches + argsMatches', () => {
  const trace = makeTrace({ toolCalls: [tc('fs-edit__write_file', { path: 'src/foo.ts' })] });
  const [res] = evaluateHard(
    [
      {
        type: 'tool_called',
        toolMatches: 'fs(-edit)?__(write|edit)_file',
        argsMatches: { path: '\\.ts$' },
      },
    ],
    trace,
    '/tmp'
  );
  assert.equal(res.passed, true, res.reason);
});

test('tool_called: fail when argsContains mismatch', () => {
  const trace = makeTrace({ toolCalls: [tc('fs__read_file', { path: 'other.md' })] });
  const [res] = evaluateHard(
    [{ type: 'tool_called', tool: 'fs__read_file', argsContains: { path: 'README.md' } }],
    trace,
    '/tmp'
  );
  assert.equal(res.passed, false);
});

// ─── 2. tool_not_called ───

test('tool_not_called: pass when absent', () => {
  const trace = makeTrace({ toolCalls: [tc('fs__read_file')] });
  const [res] = evaluateHard([{ type: 'tool_not_called', tool: 'exec__execute_command' }], trace, '/tmp');
  assert.equal(res.passed, true, res.reason);
});

test('tool_not_called: fail when present', () => {
  const trace = makeTrace({ toolCalls: [tc('exec__execute_command', { cmd: 'rm -rf /' })] });
  const [res] = evaluateHard([{ type: 'tool_not_called', tool: 'exec__execute_command' }], trace, '/tmp');
  assert.equal(res.passed, false);
});

// ─── 3. tool_retry_max ───

test('tool_retry_max: pass when same-error count within limit', () => {
  const trace = makeTrace({
    toolCalls: [
      tc('fs__read_file', { path: 'x' }, false),
      tc('fs__read_file', { path: 'x' }, false),
      tc('fs__read_file', { path: 'y' }, true),
    ],
  });
  const [res] = evaluateHard([{ type: 'tool_retry_max', maxSameError: 2 }], trace, '/tmp');
  assert.equal(res.passed, true, res.reason);
});

test('tool_retry_max: fail when >max same-args failures', () => {
  const trace = makeTrace({
    toolCalls: [
      tc('fs__read_file', { path: 'x' }, false),
      tc('fs__read_file', { path: 'x' }, false),
      tc('fs__read_file', { path: 'x' }, false),
    ],
  });
  const [res] = evaluateHard([{ type: 'tool_retry_max', maxSameError: 2 }], trace, '/tmp');
  assert.equal(res.passed, false);
});

test('tool_retry_max: successful calls NOT counted as retries', () => {
  // 5 successful calls with same args must not trip the limit
  const trace = makeTrace({
    toolCalls: Array.from({ length: 5 }, () => tc('fs__read_file', { path: 'x' }, true)),
  });
  const [res] = evaluateHard([{ type: 'tool_retry_max', maxSameError: 2 }], trace, '/tmp');
  assert.equal(res.passed, true, res.reason);
});

test('tool_retry_max: args order should not affect key equality', () => {
  const trace = makeTrace({
    toolCalls: [
      tc('fs__read_file', { path: 'x', mode: 'r' }, false),
      tc('fs__read_file', { mode: 'r', path: 'x' }, false),
      tc('fs__read_file', { path: 'x', mode: 'r' }, false),
    ],
  });
  const [res] = evaluateHard([{ type: 'tool_retry_max', maxSameError: 2 }], trace, '/tmp');
  assert.equal(res.passed, false, 'three same-args failures should fail max=2');
});

test('no_orphan_tool: fails on orphan result or unclosed call', () => {
  const ok = evaluateHard(
    [{ type: 'no_orphan_tool' }],
    makeTrace({ toolProtocol: { orphanToolResults: 0, unclosedToolCalls: 0 } }),
    '/tmp'
  )[0];
  const bad = evaluateHard(
    [{ type: 'no_orphan_tool' }],
    makeTrace({ toolProtocol: { orphanToolResults: 1, unclosedToolCalls: 0 } }),
    '/tmp'
  )[0];
  assert.equal(ok.passed, true);
  assert.equal(bad.passed, false);
});

test('compact_count_min/max checks trace compact count', () => {
  const trace = makeTrace({ compactCount: 2 });
  const min = evaluateHard([{ type: 'compact_count_min', min: 2 }], trace, '/tmp')[0];
  const max = evaluateHard([{ type: 'compact_count_max', max: 1 }], trace, '/tmp')[0];
  assert.equal(min.passed, true);
  assert.equal(max.passed, false);
});

test('tool_call_count_by_round counts matching tools in a round', () => {
  const trace = makeTrace({
    rounds: [
      {
        roundIndex: 0,
        user: 'r0',
        toolCalls: [tc('fs__read_file'), tc('grep__grep')],
        finalText: '',
        compactCount: 0,
        warningCount: 0,
        errorCount: 0,
        elapsedMs: 1,
      },
    ],
  });
  const ok = evaluateHard(
    [{ type: 'tool_call_count_by_round', round: 0, max: 1, toolMatches: 'read_file$' }],
    trace,
    '/tmp'
  )[0];
  const bad = evaluateHard(
    [{ type: 'tool_call_count_by_round', round: 0, max: 0, toolMatches: 'read_file$' }],
    trace,
    '/tmp'
  )[0];
  assert.equal(ok.passed, true);
  assert.equal(bad.passed, false);
});

test('final_text_mentions_uncertainty_or_question detects clarification', () => {
  const ok = evaluateHard(
    [{ type: 'final_text_mentions_uncertainty_or_question' }],
    makeTrace({ finalText: '我需要确认目标文件路径。' }),
    '/tmp'
  )[0];
  const bad = evaluateHard(
    [{ type: 'final_text_mentions_uncertainty_or_question' }],
    makeTrace({ finalText: '我已经完成。' }),
    '/tmp'
  )[0];
  assert.equal(ok.passed, true);
  assert.equal(bad.passed, false);
});

test('no_repeat_read_same_file_after_context_available fails repeated reads', () => {
  const trace = makeTrace({
    toolCalls: [
      tc('fs__read_file', { path: 'src/index.js' }),
      tc('fs__read_file', { path: './src/index.js' }),
    ],
  });
  const [res] = evaluateHard(
    [{ type: 'no_repeat_read_same_file_after_context_available' }],
    trace,
    '/tmp'
  );
  assert.equal(res.passed, false);
});

// ─── 4. file_content ───

test('file_content: pass when contains/notContains/regex match', () => {
  const dir = mkTmpDir('fc-ok');
  fs.writeFileSync(path.join(dir, 'README.md'), 'VERSION: 2.0.0\nhello');
  const [res] = evaluateHard(
    [
      {
        type: 'file_content',
        path: 'README.md',
        contains: 'VERSION: 2.0.0',
        notContains: 'VERSION: 1.0.0',
        regex: '^VERSION: \\d+\\.\\d+\\.\\d+',
      },
    ],
    makeTrace(),
    dir
  );
  assert.equal(res.passed, true, res.reason);
});

test('file_content: fail when missing file', () => {
  const dir = mkTmpDir('fc-missing');
  const [res] = evaluateHard(
    [{ type: 'file_content', path: 'nope.txt', contains: 'x' }],
    makeTrace(),
    dir
  );
  assert.equal(res.passed, false);
});

test('file_content: fail when notContains hits', () => {
  const dir = mkTmpDir('fc-forbidden');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'has forbidden word');
  const [res] = evaluateHard(
    [{ type: 'file_content', path: 'a.txt', notContains: 'forbidden' }],
    makeTrace(),
    dir
  );
  assert.equal(res.passed, false);
});

test('file_content: exact match pass/fail', () => {
  const dir = mkTmpDir('fc-exact');
  fs.writeFileSync(path.join(dir, 'e.txt'), 'hi');
  const ok = evaluateHard([{ type: 'file_content', path: 'e.txt', exact: 'hi' }], makeTrace(), dir)[0];
  const bad = evaluateHard([{ type: 'file_content', path: 'e.txt', exact: 'hello' }], makeTrace(), dir)[0];
  assert.equal(ok.passed, true);
  assert.equal(bad.passed, false);
});

// ─── 5. file_exists ───

test('file_exists: pass/fail', () => {
  const dir = mkTmpDir('fe');
  fs.writeFileSync(path.join(dir, 'there.txt'), '');
  const ok = evaluateHard([{ type: 'file_exists', path: 'there.txt' }], makeTrace(), dir)[0];
  const bad = evaluateHard([{ type: 'file_exists', path: 'nope.txt' }], makeTrace(), dir)[0];
  assert.equal(ok.passed, true);
  assert.equal(bad.passed, false);
});

// ─── 6. not_file_modified (M1 skip) ───

test('not_file_modified: M1 returns skipped + passed', () => {
  const [res] = evaluateHard(
    [{ type: 'not_file_modified', path: 'whatever.ts' }],
    makeTrace(),
    '/tmp'
  );
  assert.equal(res.passed, true);
  assert.match(res.reason, /skipped/i);
});

// ─── 7. no_error_5xx ───

test('no_error_5xx: pass when no error signal', () => {
  const events: AgentEvent[] = [
    { type: 'tool:call', name: 'fs__read_file', args: {} },
    { type: 'tool:result', ok: true, content: 'file contents ok' },
  ];
  const [res] = evaluateHard([{ type: 'no_error_5xx' }], makeTrace({ events }), '/tmp');
  assert.equal(res.passed, true, res.reason);
});

test('no_error_5xx: fail when 500 in tool:result', () => {
  const events: AgentEvent[] = [
    { type: 'tool:result', ok: false, content: 'HTTP 500 Internal Server Error' },
  ];
  const [res] = evaluateHard([{ type: 'no_error_5xx' }], makeTrace({ events }), '/tmp');
  assert.equal(res.passed, false);
});

test('no_error_5xx: fail on generic [error] tag', () => {
  const events: AgentEvent[] = [{ type: 'tool:result', ok: false, content: '[error] tool crashed' }];
  const [res] = evaluateHard([{ type: 'no_error_5xx' }], makeTrace({ events }), '/tmp');
  assert.equal(res.passed, false);
});

// ─── 8. final_text_contains ───

test('final_text_contains: pass for substring', () => {
  const trace = makeTrace({ finalText: 'Changed VERSION to 2.0.0 in README' });
  const [res] = evaluateHard(
    [{ type: 'final_text_contains', contains: 'VERSION' }],
    trace,
    '/tmp'
  );
  assert.equal(res.passed, true);
});

test('final_text_contains: pass for regex', () => {
  const trace = makeTrace({ finalText: 'done in 42ms' });
  const [res] = evaluateHard(
    [{ type: 'final_text_contains', regex: '\\d+ms$' }],
    trace,
    '/tmp'
  );
  assert.equal(res.passed, true);
});

test('final_text_contains: fail when missing', () => {
  const trace = makeTrace({ finalText: 'nothing special' });
  const [res] = evaluateHard(
    [{ type: 'final_text_contains', contains: 'ERROR' }],
    trace,
    '/tmp'
  );
  assert.equal(res.passed, false);
});

// ─── 9. final_text_min_chars ───

test('final_text_min_chars: pass plain length', () => {
  const trace = makeTrace({ finalText: 'a'.repeat(100) });
  const [res] = evaluateHard([{ type: 'final_text_min_chars', chars: 50 }], trace, '/tmp');
  assert.equal(res.passed, true);
});

test('final_text_min_chars: fail plain length', () => {
  const trace = makeTrace({ finalText: 'short' });
  const [res] = evaluateHard([{ type: 'final_text_min_chars', chars: 20 }], trace, '/tmp');
  assert.equal(res.passed, false);
});

test('final_text_min_chars: chinese-only counting', () => {
  // 10 chinese chars padded by ascii — chinese=true should ignore ascii
  const trace = makeTrace({ finalText: 'hello 中文字符测试内容够多 world' });
  const ok = evaluateHard(
    [{ type: 'final_text_min_chars', chars: 10, chinese: true }],
    trace,
    '/tmp'
  )[0];
  const bad = evaluateHard(
    [{ type: 'final_text_min_chars', chars: 20, chinese: true }],
    trace,
    '/tmp'
  )[0];
  assert.equal(ok.passed, true, ok.reason);
  assert.equal(bad.passed, false);
});

// ─── 10. event_sequence ───

test('event_sequence: pass non-contiguous subsequence', () => {
  const events: AgentEvent[] = [
    { type: 'task:start', taskId: 't', prompt: '' },
    { type: 'thinking:start' },
    { type: 'tool:call', name: 'fs__read_file', args: {} },
    { type: 'token', text: 'a' },
    { type: 'tool:result', ok: true, content: '' },
    { type: 'text', content: 'done' },
    { type: 'task:done', taskId: 't' },
  ];
  const [res] = evaluateHard(
    [{ type: 'event_sequence', sequence: ['task:start', 'tool:call', 'tool:result', 'task:done'] }],
    makeTrace({ events }),
    '/tmp'
  );
  assert.equal(res.passed, true, res.reason);
});

test('event_sequence: fail when order violated', () => {
  const events: AgentEvent[] = [
    { type: 'tool:result', ok: true, content: '' },
    { type: 'tool:call', name: 'x', args: {} },
  ];
  const [res] = evaluateHard(
    [{ type: 'event_sequence', sequence: ['tool:call', 'tool:result'] }],
    makeTrace({ events }),
    '/tmp'
  );
  assert.equal(res.passed, false);
});

// ─── 11. messages_count_max ───

test('messages_count_max: pass and fail', () => {
  const ok = evaluateHard(
    [{ type: 'messages_count_max', max: 10 }],
    makeTrace({ messagesCount: 8 }),
    '/tmp'
  )[0];
  const bad = evaluateHard(
    [{ type: 'messages_count_max', max: 10 }],
    makeTrace({ messagesCount: 11 }),
    '/tmp'
  )[0];
  assert.equal(ok.passed, true);
  assert.equal(bad.passed, false);
});

// ─── 12. exit_code ───

test('exit_code: pass for exit 0', () => {
  const dir = mkTmpDir('exit-ok');
  const [res] = evaluateHard([{ type: 'exit_code', cmd: 'true', code: 0 }], makeTrace(), dir);
  assert.equal(res.passed, true, res.reason);
});

test('exit_code: fail when actual ≠ expected', () => {
  const dir = mkTmpDir('exit-bad');
  const [res] = evaluateHard([{ type: 'exit_code', cmd: 'false', code: 0 }], makeTrace(), dir);
  assert.equal(res.passed, false);
});

test('exit_code: pass when expecting nonzero and getting nonzero', () => {
  const dir = mkTmpDir('exit-nz');
  const [res] = evaluateHard(
    [{ type: 'exit_code', cmd: 'sh -c "exit 3"', code: 3 }],
    makeTrace(),
    dir
  );
  assert.equal(res.passed, true, res.reason);
});

// ─── Dispatcher batch ───

test('evaluateHard: runs N assertions and returns N results in order', () => {
  const dir = mkTmpDir('batch');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'ok');
  const trace = makeTrace({
    finalText: 'all good',
    toolCalls: [tc('fs__read_file', { path: 'a.txt' })],
  });
  const results = evaluateHard(
    [
      { type: 'tool_called', tool: 'fs__read_file' },
      { type: 'file_exists', path: 'a.txt' },
      { type: 'final_text_contains', contains: 'good' },
    ],
    trace,
    dir
  );
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.passed), JSON.stringify(results));
});

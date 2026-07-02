import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type {
  HardAssertion,
  HardAssertionResult,
  RunTrace,
  ToolCallRecord,
  AgentEvent,
} from '../types.js';

// ─── Dispatcher ───

export function evaluateHard(
  assertions: HardAssertion[],
  trace: RunTrace,
  cwd: string
): HardAssertionResult[] {
  return assertions.map((a) => evaluateOne(a, trace, cwd));
}

function evaluateOne(
  a: HardAssertion,
  trace: RunTrace,
  cwd: string
): HardAssertionResult {
  switch (a.type) {
    case 'tool_called':
      return checkToolCalled(a, trace);
    case 'tool_not_called':
      return checkToolNotCalled(a, trace);
    case 'tool_retry_max':
      return checkToolRetryMax(a, trace);
    case 'no_orphan_tool':
      return checkNoOrphanTool(a, trace);
    case 'compact_count_min':
      return checkCompactCountMin(a, trace);
    case 'compact_count_max':
      return checkCompactCountMax(a, trace);
    case 'context_window_min':
      return checkContextWindowMin(a, trace);
    case 'no_silent_tool_streak':
      return checkNoSilentToolStreak(a, trace);
    case 'progress_count_min':
      return checkProgressCountMin(a, trace);
    case 'compact_failure_has_user_summary':
      return checkCompactFailureHasUserSummary(a, trace);
    case 'task_failure_has_actionable_summary':
      return checkTaskFailureHasActionableSummary(a, trace);
    case 'tool_call_count_by_round':
      return checkToolCallCountByRound(a, trace);
    case 'final_text_mentions_uncertainty_or_question':
      return checkFinalTextMentionsUncertaintyOrQuestion(a, trace);
    case 'no_repeat_read_same_file_after_context_available':
      return checkNoRepeatReadSameFile(a, trace);
    case 'file_content':
      return checkFileContent(a, cwd);
    case 'file_exists':
      return checkFileExists(a, cwd);
    case 'not_file_modified':
      return checkNotFileModified(a);
    case 'no_error_5xx':
      return checkNoError5xx(a, trace);
    case 'final_text_contains':
      return checkFinalTextContains(a, trace);
    case 'final_text_min_chars':
      return checkFinalTextMinChars(a, trace);
    case 'event_sequence':
      return checkEventSequence(a, trace);
    case 'messages_count_max':
      return checkMessagesCountMax(a, trace);
    case 'exit_code':
      return checkExitCode(a, cwd);
  }
}

// ─── 3b. no_orphan_tool ───

function checkNoOrphanTool(
  a: Extract<HardAssertion, { type: 'no_orphan_tool' }>,
  trace: RunTrace
): HardAssertionResult {
  const orphan = trace.toolProtocol?.orphanToolResults ?? 0;
  const unclosed = trace.toolProtocol?.unclosedToolCalls ?? 0;
  if (orphan === 0 && unclosed === 0) {
    return { assertion: a, passed: true, reason: 'tool protocol events are paired' };
  }
  return {
    assertion: a,
    passed: false,
    reason: `orphan tool results=${orphan}, unclosed tool calls=${unclosed}`,
  };
}

// ─── 3c. compact_count_min/max ───

function checkCompactCountMin(
  a: Extract<HardAssertion, { type: 'compact_count_min' }>,
  trace: RunTrace
): HardAssertionResult {
  const count = trace.compactCount ?? 0;
  if (count >= a.min) return { assertion: a, passed: true, reason: `${count} ≥ ${a.min}` };
  return { assertion: a, passed: false, reason: `${count} < ${a.min}` };
}

function checkCompactCountMax(
  a: Extract<HardAssertion, { type: 'compact_count_max' }>,
  trace: RunTrace
): HardAssertionResult {
  const count = trace.compactCount ?? 0;
  if (count <= a.max) return { assertion: a, passed: true, reason: `${count} ≤ ${a.max}` };
  return { assertion: a, passed: false, reason: `${count} > ${a.max}` };
}

function checkContextWindowMin(
  a: Extract<HardAssertion, { type: 'context_window_min' }>,
  trace: RunTrace
): HardAssertionResult {
  const actual = trace.contextWindow ?? 0;
  if (actual >= a.min) {
    return { assertion: a, passed: true, reason: `contextWindow ${actual} >= ${a.min}` };
  }
  return { assertion: a, passed: false, reason: `contextWindow ${actual} < ${a.min}` };
}

function checkNoSilentToolStreak(
  a: Extract<HardAssertion, { type: 'no_silent_tool_streak' }>,
  trace: RunTrace
): HardAssertionResult {
  const actual = trace.maxSilentToolStreak ?? 0;
  if (actual <= a.max) {
    return { assertion: a, passed: true, reason: `max silent tool streak ${actual} <= ${a.max}` };
  }
  return { assertion: a, passed: false, reason: `max silent tool streak ${actual} > ${a.max}` };
}

function checkProgressCountMin(
  a: Extract<HardAssertion, { type: 'progress_count_min' }>,
  trace: RunTrace
): HardAssertionResult {
  const actual = trace.progressCount ?? 0;
  if (actual >= a.min) {
    return { assertion: a, passed: true, reason: `progressCount ${actual} >= ${a.min}` };
  }
  return { assertion: a, passed: false, reason: `progressCount ${actual} < ${a.min}` };
}

function checkCompactFailureHasUserSummary(
  a: Extract<HardAssertion, { type: 'compact_failure_has_user_summary' }>,
  trace: RunTrace
): HardAssertionResult {
  const failure = trace.events.find(
    (ev) =>
      ev.type === 'task:failed' &&
      /context|compact|compaction|上下文/i.test(ev.error)
  );
  if (!failure) {
    return { assertion: a, passed: false, reason: 'no compact/context failure observed' };
  }
  return checkActionableSummary(a, trace, 'compact/context failure');
}

function checkTaskFailureHasActionableSummary(
  a: Extract<HardAssertion, { type: 'task_failure_has_actionable_summary' }>,
  trace: RunTrace
): HardAssertionResult {
  const failed = trace.events.some((ev) => ev.type === 'task:failed');
  const toolErrors = trace.errorCount ?? 0;
  if (!failed && toolErrors === 0) {
    return { assertion: a, passed: true, reason: 'no task/tool failure observed' };
  }
  return checkActionableSummary(a, trace, failed ? 'task failure' : 'tool failure');
}

function checkActionableSummary(
  assertion: HardAssertion,
  trace: RunTrace,
  label: string
): HardAssertionResult {
  const summary = trace.failureSummary ?? trace.finalText;
  const markers = ['已完成', '失败点', '下一步', '建议', '需要', '请'].filter((m) => summary.includes(m));
  const actionable = summary.length >= 25 && markers.length >= 2;
  if (actionable) {
    return { assertion, passed: true, reason: `${label} has actionable summary` };
  }
  return {
    assertion,
    passed: false,
    reason: `${label} missing actionable summary; got: ${truncate(summary, 160)}`,
  };
}

// ─── 3d. tool_call_count_by_round ───

function checkToolCallCountByRound(
  a: Extract<HardAssertion, { type: 'tool_call_count_by_round' }>,
  trace: RunTrace
): HardAssertionResult {
  const round = (trace.rounds ?? []).find((r) => r.roundIndex === a.round);
  if (!round) {
    return { assertion: a, passed: false, reason: `round ${a.round} not found` };
  }
  const count = round.toolCalls.filter((tc) => matchToolName(tc, a.tool, a.toolMatches)).length;
  if (a.min !== undefined && count < a.min) {
    return { assertion: a, passed: false, reason: `round ${a.round}: ${count} < min ${a.min}` };
  }
  if (a.max !== undefined && count > a.max) {
    return { assertion: a, passed: false, reason: `round ${a.round}: ${count} > max ${a.max}` };
  }
  return { assertion: a, passed: true, reason: `round ${a.round}: count=${count}` };
}

// ─── 3e. uncertainty / question ───

function checkFinalTextMentionsUncertaintyOrQuestion(
  a: Extract<HardAssertion, { type: 'final_text_mentions_uncertainty_or_question' }>,
  trace: RunTrace
): HardAssertionResult {
  const pattern = /[?？]|不确定|无法确定|需要确认|请确认|请提供|需要你|还需要|clarify|confirm|need more/i;
  if (pattern.test(trace.finalText)) {
    return { assertion: a, passed: true, reason: 'final text asks/acknowledges uncertainty' };
  }
  return {
    assertion: a,
    passed: false,
    reason: `final text does not ask or mention uncertainty; tail: ${truncate(trace.finalText.slice(-160), 160)}`,
  };
}

// ─── 3f. no_repeat_read_same_file_after_context_available ───

function checkNoRepeatReadSameFile(
  a: Extract<HardAssertion, { type: 'no_repeat_read_same_file_after_context_available' }>,
  trace: RunTrace
): HardAssertionResult {
  const maxReads = a.maxReads ?? 1;
  const counts = new Map<string, number>();
  for (const tc of trace.toolCalls) {
    if (!isReadFileTool(tc.name)) continue;
    const p = readPathArg(tc.args);
    if (!p) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const offenders = [...counts.entries()].filter(([, count]) => count > maxReads);
  if (offenders.length === 0) {
    return { assertion: a, passed: true, reason: `no file read more than ${maxReads} time(s)` };
  }
  return {
    assertion: a,
    passed: false,
    reason: offenders.map(([p, count]) => `${p} read ${count}x`).join('; '),
  };
}

// ─── Matchers ───

function matchToolName(record: ToolCallRecord, tool?: string, toolMatches?: string): boolean {
  if (tool !== undefined) return record.name === tool;
  if (toolMatches !== undefined) return new RegExp(toolMatches).test(record.name);
  return true;
}

function normalizePath(p: unknown): string {
  if (typeof p !== 'string') return String(p);
  return p.replace(/^\.\//, '').replace(/\/+$/, '');
}

function matchPath(actual: unknown, expected: unknown): boolean {
  const na = normalizePath(actual);
  const ne = normalizePath(expected);
  if (na === ne) return true;
  if (typeof expected === 'string' && typeof actual === 'string') {
    const expectedIsAbsolute = path.isAbsolute(expected);
    if (!expectedIsAbsolute && (na.endsWith('/' + ne) || na === ne)) return true;
  }
  return false;
}

function matchArgsContains(record: ToolCallRecord, argsContains?: Record<string, unknown>): boolean {
  if (!argsContains) return true;
  for (const [key, expected] of Object.entries(argsContains)) {
    if (!(key in record.args)) return false;
    const actual = record.args[key];
    if (key === 'path' || key === 'file' || key === 'directory') {
      if (!matchPath(actual, expected)) return false;
    } else if (typeof expected === 'string' && typeof actual === 'string') {
      if (!actual.includes(expected)) return false;
    } else {
      if (actual !== expected) return false;
    }
  }
  return true;
}

function matchArgsRegex(record: ToolCallRecord, argsMatches?: Record<string, string>): boolean {
  if (!argsMatches) return true;
  for (const [key, pattern] of Object.entries(argsMatches)) {
    const val = record.args[key];
    if (typeof val !== 'string') return false;
    if (!new RegExp(pattern).test(val)) return false;
  }
  return true;
}

function findToolMatches(
  trace: RunTrace,
  opts: { tool?: string; toolMatches?: string; argsContains?: Record<string, unknown>; argsMatches?: Record<string, string> }
): ToolCallRecord[] {
  return trace.toolCalls.filter(
    (tc) =>
      matchToolName(tc, opts.tool, opts.toolMatches) &&
      matchArgsContains(tc, opts.argsContains) &&
      matchArgsRegex(tc, opts.argsMatches)
  );
}

// ─── 1. tool_called ───

function checkToolCalled(
  a: Extract<HardAssertion, { type: 'tool_called' }>,
  trace: RunTrace
): HardAssertionResult {
  const matches = findToolMatches(trace, a);
  if (matches.length > 0) {
    return { assertion: a, passed: true, reason: `matched ${matches.length} call(s)` };
  }
  const desc = describeToolFilter(a);
  return {
    assertion: a,
    passed: false,
    reason: `no tool call matched ${desc}; saw [${trace.toolCalls.map((t) => t.name).join(', ')}]`,
  };
}

// ─── 2. tool_not_called ───

function checkToolNotCalled(
  a: Extract<HardAssertion, { type: 'tool_not_called' }>,
  trace: RunTrace
): HardAssertionResult {
  const matches = findToolMatches(trace, a);
  if (matches.length === 0) {
    return { assertion: a, passed: true, reason: 'no matching tool call (ok)' };
  }
  return {
    assertion: a,
    passed: false,
    reason: `expected no match for ${describeToolFilter(a)}, got ${matches.length}`,
  };
}

// ─── 3. tool_retry_max ───

function checkToolRetryMax(
  a: Extract<HardAssertion, { type: 'tool_retry_max' }>,
  trace: RunTrace
): HardAssertionResult {
  const counts = new Map<string, number>();
  for (const tc of trace.toolCalls) {
    if (tc.ok) continue;
    const key = `${tc.name}:${stableStringify(tc.args)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let worstKey = '';
  let worst = 0;
  for (const [k, v] of counts) {
    if (v > worst) {
      worst = v;
      worstKey = k;
    }
  }
  if (worst > a.maxSameError) {
    return {
      assertion: a,
      passed: false,
      reason: `same-args failure repeated ${worst} times for ${worstKey} (max ${a.maxSameError})`,
    };
  }
  return { assertion: a, passed: true, reason: `max same-error count ${worst} ≤ ${a.maxSameError}` };
}

// ─── 4. file_content ───

function checkFileContent(
  a: Extract<HardAssertion, { type: 'file_content' }>,
  cwd: string
): HardAssertionResult {
  const full = path.join(cwd, a.path);
  if (!fs.existsSync(full)) {
    return { assertion: a, passed: false, reason: `file does not exist: ${a.path}` };
  }
  const content = fs.readFileSync(full, 'utf-8');
  if (a.exact !== undefined && content !== a.exact) {
    return {
      assertion: a,
      passed: false,
      reason: `exact mismatch; got ${truncate(content, 120)}`,
    };
  }
  if (a.contains !== undefined && !content.includes(a.contains)) {
    return { assertion: a, passed: false, reason: `missing substring "${a.contains}"` };
  }
  if (a.notContains !== undefined && content.includes(a.notContains)) {
    return { assertion: a, passed: false, reason: `forbidden substring present "${a.notContains}"` };
  }
  if (a.regex !== undefined && !new RegExp(a.regex).test(content)) {
    return { assertion: a, passed: false, reason: `regex /${a.regex}/ did not match` };
  }
  return { assertion: a, passed: true, reason: `content checks passed (${content.length} bytes)` };
}

// ─── 5. file_exists ───

function checkFileExists(
  a: Extract<HardAssertion, { type: 'file_exists' }>,
  cwd: string
): HardAssertionResult {
  const full = path.join(cwd, a.path);
  if (fs.existsSync(full)) {
    return { assertion: a, passed: true, reason: `exists: ${a.path}` };
  }
  return { assertion: a, passed: false, reason: `missing: ${a.path}` };
}

// ─── 6. not_file_modified (M1 skip: needs baseline) ───

function checkNotFileModified(
  a: Extract<HardAssertion, { type: 'not_file_modified' }>
): HardAssertionResult {
  return {
    assertion: a,
    passed: true,
    reason: 'skipped: requires baseline (M1 limitation)',
  };
}

// ─── 7. no_error_5xx ───

function checkNoError5xx(
  a: Extract<HardAssertion, { type: 'no_error_5xx' }>,
  trace: RunTrace
): HardAssertionResult {
  for (const ev of trace.events) {
    if (ev.type !== 'tool:result') continue;
    if (hasLlmError(ev.content)) {
      return {
        assertion: a,
        passed: false,
        reason: `5xx/error in tool:result: ${truncate(ev.content, 120)}`,
      };
    }
  }
  return { assertion: a, passed: true, reason: 'no 5xx in tool:result events' };
}

function hasLlmError(text: string): boolean {
  return /\[error\]|Internal Server Error|5\d\d\s+Error|\b50[0-9]\b|\b51[0-9]\b/.test(text);
}

// ─── 8. final_text_contains ───

function checkFinalTextContains(
  a: Extract<HardAssertion, { type: 'final_text_contains' }>,
  trace: RunTrace
): HardAssertionResult {
  if (a.contains !== undefined && trace.finalText.includes(a.contains)) {
    return { assertion: a, passed: true, reason: `found "${a.contains}"` };
  }
  if (a.regex !== undefined && new RegExp(a.regex).test(trace.finalText)) {
    return { assertion: a, passed: true, reason: `regex /${a.regex}/ matched` };
  }
  const filter = a.contains ?? a.regex ?? '(no filter)';
  return {
    assertion: a,
    passed: false,
    reason: `finalText missing ${filter}; tail: ${truncate(trace.finalText.slice(-200), 200)}`,
  };
}

// ─── 9. final_text_min_chars ───

function checkFinalTextMinChars(
  a: Extract<HardAssertion, { type: 'final_text_min_chars' }>,
  trace: RunTrace
): HardAssertionResult {
  let count: number;
  if (a.chinese) {
    const chunks = trace.finalText.match(/[一-鿿]+/g) || [];
    count = chunks.join('').length;
  } else {
    count = trace.finalText.length;
  }
  if (count >= a.chars) {
    return { assertion: a, passed: true, reason: `${count} ≥ ${a.chars}` };
  }
  return {
    assertion: a,
    passed: false,
    reason: `${count} < ${a.chars}${a.chinese ? ' (chinese chars only)' : ''}`,
  };
}

// ─── 10. event_sequence ───

function checkEventSequence(
  a: Extract<HardAssertion, { type: 'event_sequence' }>,
  trace: RunTrace
): HardAssertionResult {
  const types = trace.events.map((e) => e.type);
  let i = 0;
  for (const t of types) {
    if (t === a.sequence[i]) i++;
    if (i === a.sequence.length) break;
  }
  if (i === a.sequence.length) {
    return { assertion: a, passed: true, reason: `found subsequence [${a.sequence.join(' → ')}]` };
  }
  return {
    assertion: a,
    passed: false,
    reason: `missing after "${a.sequence[i]}" (matched ${i}/${a.sequence.length}); event types: [${truncate(types.join(','), 200)}]`,
  };
}

// ─── 11. messages_count_max ───

function checkMessagesCountMax(
  a: Extract<HardAssertion, { type: 'messages_count_max' }>,
  trace: RunTrace
): HardAssertionResult {
  if (trace.messagesCount <= a.max) {
    return { assertion: a, passed: true, reason: `${trace.messagesCount} ≤ ${a.max}` };
  }
  return { assertion: a, passed: false, reason: `${trace.messagesCount} > ${a.max}` };
}

// ─── 12. exit_code ───

function checkExitCode(
  a: Extract<HardAssertion, { type: 'exit_code' }>,
  cwd: string
): HardAssertionResult {
  try {
    execSync(a.cmd, { cwd, stdio: 'pipe' });
    if (a.code === 0) {
      return { assertion: a, passed: true, reason: `exit 0 (expected ${a.code})` };
    }
    return { assertion: a, passed: false, reason: `exit 0 but expected ${a.code}` };
  } catch (err) {
    const actual =
      err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number'
        ? (err as { status: number }).status
        : -1;
    if (actual === a.code) {
      return { assertion: a, passed: true, reason: `exit ${actual} (expected ${a.code})` };
    }
    return { assertion: a, passed: false, reason: `exit ${actual} ≠ ${a.code}` };
  }
}

// ─── Helpers ───

function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function isReadFileTool(name: string): boolean {
  return /(^|__)read_file$/.test(name) || /(^|__)readFile$/.test(name);
}

function readPathArg(args: Record<string, unknown>): string {
  const raw = args.path ?? args.file ?? args.filePath;
  return typeof raw === 'string' ? normalizePath(raw) : '';
}

function describeToolFilter(
  a: { tool?: string; toolMatches?: string; argsContains?: Record<string, unknown>; argsMatches?: Record<string, string> }
): string {
  const parts: string[] = [];
  if (a.tool) parts.push(`tool="${a.tool}"`);
  if (a.toolMatches) parts.push(`toolMatches=/${a.toolMatches}/`);
  if (a.argsContains) parts.push(`argsContains=${JSON.stringify(a.argsContains)}`);
  if (a.argsMatches) parts.push(`argsMatches=${JSON.stringify(a.argsMatches)}`);
  return parts.join(' ') || '(any)';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

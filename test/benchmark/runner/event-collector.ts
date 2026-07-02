import type { AgentEvent } from '../../../src/agent/events.js';
import type { RunTrace, ToolCallRecord, RoundTrace } from './types.js';

const MAX_LOOP_ERROR_PATTERN = /max\s*loops?/i;
const RESULT_PREVIEW_MAX = 200;

function previewResult(content: string): string {
  if (typeof content !== 'string') return '';
  return content.length > RESULT_PREVIEW_MAX
    ? content.slice(0, RESULT_PREVIEW_MAX)
    : content;
}

export async function collectEvents(
  gen: AsyncGenerator<AgentEvent, void, unknown>,
  taskId: string,
  runIndex: number,
  round?: { index: number; user: string }
): Promise<RunTrace> {
  const startedAt = Date.now();
  const events: AgentEvent[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const pending: Array<{ name: string; args: Record<string, unknown> }> = [];
  const textParts: string[] = [];

  let thinkingMs = 0;
  let compactCount = 0;
  let contextRecallCount = 0;
  let warningCount = 0;
  let errorCount = 0;
  let orphanToolResults = 0;
  let contextWindow: number | undefined;
  let compactThreshold: number | undefined;
  let maxContextUsed = 0;
  let progressCount = 0;
  let currentSilentToolStreak = 0;
  let maxSilentToolStreak = 0;
  let lastVisibleText = '';
  let failureSummary: string | undefined;
  let hitMaxLoops = false;
  let aborted = false;
  let crashed = false;
  let crashReason: string | undefined;

  const markVisible = (text?: string) => {
    currentSilentToolStreak = 0;
    if (text && text.trim()) lastVisibleText = text.trim();
  };

  try {
    for await (const ev of gen) {
      events.push(ev);

      switch (ev.type) {
        case 'token':
          if (typeof ev.text === 'string') textParts.push(ev.text);
          markVisible(ev.text);
          break;

        case 'text':
          if (typeof ev.content === 'string') textParts.push(ev.content);
          markVisible(ev.content);
          if (/\[失败总结\]|失败点|下一步/.test(ev.content)) {
            failureSummary = ev.content;
          }
          break;

        case 'progress':
          progressCount++;
          markVisible(ev.message);
          break;

        case 'context:usage':
          contextWindow = ev.total;
          compactThreshold = ev.compactThreshold;
          maxContextUsed = Math.max(maxContextUsed, ev.used);
          break;

        case 'tool:call':
          pending.push({ name: ev.name, args: ev.args ?? {} });
          if (isContextRecallCall(ev.name, ev.args ?? {})) contextRecallCount++;
          currentSilentToolStreak++;
          maxSilentToolStreak = Math.max(maxSilentToolStreak, currentSilentToolStreak);
          break;

        case 'tool:result': {
          const p = pending.shift();
          if (p) {
            toolCalls.push(toolRecord(p.name, p.args, ev.ok, ev.content, round?.index));
          } else {
            orphanToolResults++;
            toolCalls.push(toolRecord('<unknown>', {}, ev.ok, ev.content, round?.index));
          }
          if (!ev.ok) errorCount++;
          break;
        }

        case 'thinking:end':
          if (typeof ev.durationMs === 'number' && ev.durationMs > 0) {
            thinkingMs += ev.durationMs;
          }
          break;

        case 'task:failed':
          if (typeof ev.error === 'string' && MAX_LOOP_ERROR_PATTERN.test(ev.error)) {
            hitMaxLoops = true;
          }
          if (!failureSummary && lastVisibleText) failureSummary = lastVisibleText;
          errorCount++;
          break;

        case 'task:aborted':
        case 'aborted':
          aborted = true;
          break;

        case 'compact:done':
          compactCount++;
          break;

        case 'warning':
          warningCount++;
          break;

        default:
          break;
      }
    }
  } catch (err) {
    crashed = true;
    crashReason = err instanceof Error ? err.message : String(err);
  }

  const finalText = textParts.join('');
  const apiCalls = events.filter(
    (e) => e.type === 'tool:call' || e.type === 'task:done'
  ).length;
  const unclosedToolCalls = pending.length;
  const repeatedToolCallCount = countRepeatedToolCalls(toolCalls);
  const roundTrace: RoundTrace | undefined = round
    ? {
        roundIndex: round.index,
        user: round.user,
        toolCalls,
        finalText,
        compactCount,
        warningCount,
        errorCount,
        elapsedMs: Date.now() - startedAt,
      }
    : undefined;

  return {
    taskId,
    runIndex,
    events,
    toolCalls,
    rounds: roundTrace ? [roundTrace] : [],
    finalText,
    messagesCount: events.length,
    thinkingMs,
    apiCalls,
    compactCount,
    contextRecallCount,
    contextWindow,
    compactThreshold,
    maxContextUsed,
    maxSilentToolStreak,
    progressCount,
    failureSummary,
    warningCount,
    errorCount,
    repeatedToolCallCount,
    toolProtocol: {
      orphanToolResults,
      unclosedToolCalls,
    },
    startedAt,
    elapsedMs: Date.now() - startedAt,
    hitMaxLoops,
    aborted,
    crashed,
    crashReason,
  };
}

export function mergeTraces(traces: RunTrace[]): RunTrace {
  if (traces.length === 0) {
    throw new Error('mergeTraces: cannot merge empty trace list');
  }
  if (traces.length === 1) return traces[0];

  const first = traces[0];
  const merged: RunTrace = {
    taskId: first.taskId,
    runIndex: first.runIndex,
    events: [],
    toolCalls: [],
    rounds: [],
    finalText: '',
    messagesCount: 0,
    thinkingMs: 0,
    apiCalls: 0,
    compactCount: 0,
    contextRecallCount: 0,
    contextWindow: undefined,
    compactThreshold: undefined,
    maxContextUsed: 0,
    maxSilentToolStreak: 0,
    progressCount: 0,
    failureSummary: undefined,
    warningCount: 0,
    errorCount: 0,
    repeatedToolCallCount: 0,
    toolProtocol: {
      orphanToolResults: 0,
      unclosedToolCalls: 0,
    },
    startedAt: first.startedAt,
    elapsedMs: 0,
    hitMaxLoops: false,
    aborted: false,
    crashed: false,
    crashReason: undefined,
  };

  const finalTextParts: string[] = [];
  const crashReasons: string[] = [];

  for (const t of traces) {
    merged.events.push(...t.events);
    merged.toolCalls.push(...t.toolCalls);
    merged.rounds?.push(...(t.rounds ?? []));
    if (t.finalText) finalTextParts.push(t.finalText);
    merged.messagesCount += t.messagesCount;
    merged.thinkingMs += t.thinkingMs;
    merged.apiCalls += t.apiCalls;
    merged.compactCount = (merged.compactCount ?? 0) + (t.compactCount ?? 0);
    merged.contextRecallCount = (merged.contextRecallCount ?? 0) + (t.contextRecallCount ?? 0);
    merged.contextWindow = Math.max(merged.contextWindow ?? 0, t.contextWindow ?? 0) || undefined;
    merged.compactThreshold = Math.max(merged.compactThreshold ?? 0, t.compactThreshold ?? 0) || undefined;
    merged.maxContextUsed = Math.max(merged.maxContextUsed ?? 0, t.maxContextUsed ?? 0);
    merged.maxSilentToolStreak = Math.max(merged.maxSilentToolStreak ?? 0, t.maxSilentToolStreak ?? 0);
    merged.progressCount = (merged.progressCount ?? 0) + (t.progressCount ?? 0);
    if (t.failureSummary) merged.failureSummary = t.failureSummary;
    merged.warningCount = (merged.warningCount ?? 0) + (t.warningCount ?? 0);
    merged.errorCount = (merged.errorCount ?? 0) + (t.errorCount ?? 0);
    merged.repeatedToolCallCount = countRepeatedToolCalls(merged.toolCalls);
    merged.toolProtocol = {
      orphanToolResults:
        (merged.toolProtocol?.orphanToolResults ?? 0) +
        (t.toolProtocol?.orphanToolResults ?? 0),
      unclosedToolCalls:
        (merged.toolProtocol?.unclosedToolCalls ?? 0) +
        (t.toolProtocol?.unclosedToolCalls ?? 0),
    };
    merged.elapsedMs += t.elapsedMs;
    if (t.hitMaxLoops) merged.hitMaxLoops = true;
    if (t.aborted) merged.aborted = true;
    if (t.crashed) {
      merged.crashed = true;
      if (t.crashReason) crashReasons.push(t.crashReason);
    }
  }

  merged.finalText = finalTextParts.join('\n');
  if (crashReasons.length > 0) {
    merged.crashReason = crashReasons.join('; ');
  }

  return merged;
}

function toolRecord(
  name: string,
  args: Record<string, unknown>,
  ok: boolean,
  content: string,
  roundIndex: number | undefined
): ToolCallRecord {
  const record: ToolCallRecord = {
    name,
    args,
    ok,
    resultPreview: previewResult(content),
  };
  if (roundIndex !== undefined) record.roundIndex = roundIndex;
  return record;
}

function isContextRecallCall(name: string, args: Record<string, unknown>): boolean {
  if (name.includes('context') && name.includes('recall')) return true;
  const raw = typeof args.command === 'string'
    ? args.command
    : typeof args.cmd === 'string'
      ? args.cmd
      : '';
  return /\bma\s+ctx\s+recall\b/.test(raw);
}

function countRepeatedToolCalls(toolCalls: ToolCallRecord[]): number {
  const seen = new Set<string>();
  let repeated = 0;
  for (const tc of toolCalls) {
    const key = `${tc.name}:${stableStringify(tc.args)}`;
    if (seen.has(key)) repeated++;
    seen.add(key);
  }
  return repeated;
}

function stableStringify(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return JSON.stringify(sorted);
}

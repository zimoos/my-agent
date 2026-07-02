import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BenchmarkReport, Level, TaskResult } from './types.js';
import { LEVEL_ORDER, LEVEL_CONFIG } from './types.js';

// ─── Public API ───

export async function writeReport(
  report: BenchmarkReport,
  outDir: string
): Promise<{ jsonPath: string; mdPath: string }> {
  const runDir = path.join(outDir, report.runId);
  const perTaskDir = path.join(runDir, 'per-task');
  await mkdir(perTaskDir, { recursive: true });

  const jsonPath = path.join(runDir, 'summary.json');
  const mdPath = path.join(runDir, 'summary.md');

  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(mdPath, toMarkdown(report), 'utf8');

  const perTaskWrites: Promise<void>[] = [];
  for (const level of LEVEL_ORDER) {
    const levelScore = report.byLevel[level];
    if (!levelScore) continue;
    for (const task of levelScore.tasks) {
      const filePath = path.join(perTaskDir, `${task.taskId}.json`);
      perTaskWrites.push(writeFile(filePath, JSON.stringify(task, null, 2), 'utf8'));
      perTaskWrites.push(writeFile(
        path.join(perTaskDir, `${task.taskId}.md`),
        taskToMarkdown(task),
        'utf8'
      ));
    }
  }
  await Promise.all(perTaskWrites);

  return { jsonPath, mdPath };
}

function taskToMarkdown(task: TaskResult): string {
  const lines: string[] = [];
  lines.push(`# ${task.taskId}`);
  if (task.skipped) {
    lines.push('');
    lines.push(`Skipped: ${task.skipReason ?? 'unknown reason'}`);
    return lines.join('\n') + '\n';
  }
  lines.push('');
  lines.push(`median=${formatScore(task.median)} passRate=${formatScore(task.passRate)} stability=${formatScore(task.stability)}`);
  for (const run of task.runs) {
    lines.push('');
    lines.push(`## Run ${run.trace.runIndex}`);
    lines.push(`hard=${run.hardPass ? 'pass' : 'fail'} raw=${formatScore(run.rawScore)} soft=${formatScore(run.softScore)}`);
    lines.push(`compact=${run.trace.compactCount ?? 0} warnings=${run.trace.warningCount ?? 0} errors=${run.trace.errorCount ?? 0} repeatedTools=${run.trace.repeatedToolCallCount ?? 0}`);
    lines.push(`ux=context ${run.trace.maxContextUsed ?? 0}/${run.trace.compactThreshold ?? 0}/${run.trace.contextWindow ?? 0} silentTools=${run.trace.maxSilentToolStreak ?? 0} progress=${run.trace.progressCount ?? 0}`);
    if (run.trace.failureSummary) {
      lines.push(`failureSummary=${truncate(run.trace.failureSummary.replace(/\s+/g, ' '), 160)}`);
    }
    if (run.hardResults.length > 0) {
      lines.push('');
      lines.push('Hard assertions:');
      for (const h of run.hardResults) {
        lines.push(`- ${h.passed ? 'PASS' : 'FAIL'} ${JSON.stringify(h.assertion)} — ${h.reason}`);
      }
    }
    const judged = run.softResults.filter((s) => s.reason);
    if (judged.length > 0) {
      lines.push('');
      lines.push('Judge notes:');
      for (const s of judged) {
        lines.push(`- score=${s.score === null ? 'null' : formatScore(s.score)} ${s.reason}`);
      }
    }
    if ((run.trace.rounds ?? []).length > 0) {
      lines.push('');
      lines.push('Rounds:');
      for (const r of run.trace.rounds ?? []) {
        const tools = r.toolCalls.map((t) => t.name).join(', ') || 'none';
        lines.push(`- #${r.roundIndex}: tools=[${tools}] compact=${r.compactCount} warn=${r.warningCount} err=${r.errorCount} answer=${truncate(r.finalText.replace(/\s+/g, ' '), 120)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

export function formatDashboard(report: BenchmarkReport): string {
  const lines: string[] = [];
  const rule = '═'.repeat(59);

  lines.push(rule);
  lines.push(`  MA Agent Benchmark — ${formatTimestamp(report.startedAt)}`);
  lines.push(rule);
  lines.push('');
  lines.push(`  Config:         ${report.config.agent} + ${report.config.model}`);
  lines.push(`  BaseURL:        ${report.config.baseURL}`);
  lines.push(`  Total Score:    ${formatScore(report.totalScore)} / 100`);
  lines.push(`  Level:          L${formatScore(report.level)} / 5.0`);
  lines.push(`  Elapsed:        ${formatElapsed(report.elapsedMs)}`);
  lines.push('');
  lines.push('  ─────── UX Redlines ───────');
  for (const line of formatUxRedlines(report)) lines.push(line);
  lines.push('');
  lines.push('  ─────── Levels ───────');
  for (const line of formatLevels(report)) lines.push(line);
  lines.push('');
  lines.push('  ─────── Top 3 Loss Points ───────');
  for (const line of formatWeakest(report)) lines.push(line);
  lines.push('');
  lines.push(rule);

  return lines.join('\n');
}

function formatUxRedlines(report: BenchmarkReport): string[] {
  const runs = LEVEL_ORDER
    .flatMap((level) => report.byLevel[level]?.tasks ?? [])
    .flatMap((task) => task.runs);
  if (runs.length === 0) return ['  (no runs)'];
  const maxSilent = Math.max(...runs.map((run) => run.trace.maxSilentToolStreak ?? 0));
  const progressRuns = runs.filter((run) => (run.trace.progressCount ?? 0) > 0).length;
  const maxWindow = Math.max(...runs.map((run) => run.trace.contextWindow ?? 0));
  const failureSummaries = runs.filter((run) => run.trace.failureSummary).length;
  return [
    `  Context window max: ${maxWindow}`,
    `  Max silent tools:   ${maxSilent}`,
    `  Progress runs:      ${progressRuns}/${runs.length}`,
    `  Failure summaries:  ${failureSummaries}/${runs.length}`,
  ];
}

// ─── Internals ───

function toMarkdown(report: BenchmarkReport): string {
  return '```\n' + formatDashboard(report) + '\n```\n';
}

function formatLevels(report: BenchmarkReport): string[] {
  const out: string[] = [];
  let locked = false;
  for (const level of LEVEL_ORDER) {
    const ls = report.byLevel[level];
    const name = LEVEL_NAMES[level];
    const gate = Math.round(LEVEL_CONFIG[level].rate * 100);
    const gateSuffix = level === 'L0' ? 'gate 100%' : `gate ${gate}%`;

    if (!ls) {
      out.push(`  ${padEnd(levelLabel(level, name), 22)}${bar(0)} ${padStart('—', 4)}  — (no data)`);
      continue;
    }

    const pct = Math.round(ls.passRate * 100);
    const mark = locked ? '—' : ls.gateOk ? '✓' : '×';
    const gateText = locked
      ? '(locked)'
      : ls.gateOk
        ? `(${gateSuffix})`
        : `(${gateSuffix}, not met)`;

    out.push(
      `  ${padEnd(levelLabel(level, name), 22)}${bar(ls.passRate)} ${padStart(pct + '%', 4)}  ${mark} ${gateText}`
    );

    if (!ls.gateOk) locked = true;
  }
  return out;
}

function formatWeakest(report: BenchmarkReport): string[] {
  const top = report.weakest.slice(0, 3);
  if (top.length === 0) return ['  (none)'];
  return top.map(
    (w, i) => `  ${i + 1}. ${w.taskId} → ${w.reason} (median ${formatScore(w.median)})`
  );
}

function bar(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function levelLabel(level: Level, name: string): string {
  return `${level} ${name}`;
}

function padEnd(s: string, n: number): string {
  const w = visualWidth(s);
  if (w >= n) return s;
  return s + ' '.repeat(n - w);
}

function padStart(s: string, n: number): string {
  const w = visualWidth(s);
  if (w >= n) return s;
  return ' '.repeat(n - w) + s;
}

function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp > 0x7f ? 2 : 1;
  }
  return w;
}

function formatScore(n: number): string {
  return n.toFixed(1);
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m${rest}s`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da} ${hh}:${mm}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

const LEVEL_NAMES: Record<Level, string> = {
  L0: 'Connectivity',
  L1: 'Stable Tools',
  L2: 'Multi-turn',
  L3: 'Complex Flow',
  L4: 'Autonomous Plan',
  L5: 'Near Claude Code',
};

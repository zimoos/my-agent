import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatDashboard, writeReport } from '../reporter.js';
import type {
  BenchmarkReport,
  LevelScore,
  TaskResult,
  TaskScore,
  RunTrace,
} from '../types.js';

function mockTrace(taskId: string, runIndex = 0): RunTrace {
  return {
    taskId,
    runIndex,
    events: [],
    toolCalls: [],
    finalText: 'ok',
    messagesCount: 2,
    thinkingMs: 0,
    apiCalls: 1,
    startedAt: 0,
    elapsedMs: 1234,
    hitMaxLoops: false,
    aborted: false,
    crashed: false,
  };
}

function mockTaskScore(taskId: string, rawScore: number): TaskScore {
  return {
    taskId,
    hardPass: rawScore >= 0.6,
    softScore: rawScore,
    rawScore,
    hardResults: [],
    softResults: [],
    trace: mockTrace(taskId),
  };
}

function mockTaskResult(
  taskId: string,
  level: TaskResult['level'],
  median: number
): TaskResult {
  const runs = [median, median, median, median, median].map((m) =>
    mockTaskScore(taskId, m)
  );
  return {
    taskId,
    level,
    runs,
    median,
    stability: 1.0,
    passRate: median >= 0.7 ? 1 : 0,
  };
}

function mockLevelScore(
  level: LevelScore['level'],
  score: number,
  passRate: number,
  gateOk: boolean,
  taskIds: string[] = [`${level}-001`]
): LevelScore {
  return {
    level,
    score,
    passRate,
    gateOk,
    tasks: taskIds.map((id) => mockTaskResult(id, level, score)),
  };
}

function mockReport(overrides: Partial<BenchmarkReport> = {}): BenchmarkReport {
  return {
    runId: '2026-04-29T14-32-00Z-abc',
    config: { agent: 'MA v0.3.1', model: 'Qwen3-30B', baseURL: 'http://localhost:1234' },
    totalScore: 58.3,
    level: 2.6,
    byLevel: {
      L0: mockLevelScore('L0', 1.0, 1.0, true, ['L0-001', 'L0-002']),
      L1: mockLevelScore('L1', 0.88, 0.92, true, ['L1-001']),
      L2: mockLevelScore('L2', 0.72, 0.78, false, ['L2-001', 'L2-002']),
    },
    weakest: [
      { taskId: 'L2-010', median: 0.2, reason: 'tool not called' },
      { taskId: 'L2-015', median: 0.3, reason: 'duration over budget' },
      { taskId: 'L1-007', median: 0.4, reason: 'final text too short' },
      { taskId: 'L1-003', median: 0.5, reason: 'tool retry exceeded' },
    ],
    startedAt: '2026-04-29T14:32:00Z',
    elapsedMs: 125_400,
    ...overrides,
  };
}

test('formatDashboard: includes header with config, total score, level, timestamp', () => {
  const report = mockReport();
  const out = formatDashboard(report);
  assert.match(out, /MA Agent Benchmark/);
  assert.match(out, /MA v0\.3\.1 \+ Qwen3-30B/);
  assert.match(out, /Total Score: +58\.3 \/ 100/);
  assert.match(out, /Level: +L2\.6 \/ 5\.0/);
  assert.match(out, /2026-04-29/);
});

test('formatDashboard: draws 10-cell bars per level with ✓/×/— markers', () => {
  const out = formatDashboard(mockReport());
  // L0 passed 100% → full bar + ✓
  assert.match(out, /L0 Connectivity\s+██████████\s+100%\s+✓/);
  // L1 passed gate → 9 filled + 1 empty
  assert.match(out, /L1 Stable Tools\s+█{9}░\s+92%\s+✓/);
  // L2 failed gate → 8 filled + 2 empty + ×  (round(0.78*10)=8)
  assert.match(out, /L2 Multi-turn\s+█{8}░{2}\s+78%\s+×/);
  // L3/L4/L5 missing → empty bar + no data
  assert.match(out, /L3 Complex Flow\s+░{10}/);
});

test('formatDashboard: every level appears with correct ordering', () => {
  const out = formatDashboard(mockReport());
  const idxL0 = out.indexOf('L0 Connectivity');
  const idxL1 = out.indexOf('L1 Stable Tools');
  const idxL2 = out.indexOf('L2 Multi-turn');
  const idxL5 = out.indexOf('L5 Near Claude Code');
  assert.ok(idxL0 > 0 && idxL1 > idxL0 && idxL2 > idxL1 && idxL5 > idxL2);
});

test('formatDashboard: top 3 loss points limited to 3 entries', () => {
  const out = formatDashboard(mockReport());
  assert.match(out, /Top 3 Loss Points/);
  assert.match(out, /1\. L2-010/);
  assert.match(out, /2\. L2-015/);
  assert.match(out, /3\. L1-007/);
  assert.ok(!out.includes('L1-003'), 'only first 3 weakest should appear');
});

test('formatDashboard: score formatted to one decimal', () => {
  const out = formatDashboard(mockReport({ totalScore: 58, level: 2 }));
  assert.match(out, /Total Score: +58\.0 \/ 100/);
  assert.match(out, /Level: +L2\.0 \/ 5\.0/);
});

test('formatDashboard: handles report with no weakest entries', () => {
  const out = formatDashboard(mockReport({ weakest: [] }));
  assert.match(out, /Top 3 Loss Points/);
  assert.match(out, /\(none\)/);
});

test('formatDashboard: handles report with zero byLevel data gracefully', () => {
  const out = formatDashboard(mockReport({ byLevel: {} }));
  assert.match(out, /L0 Connectivity/);
  assert.match(out, /no data/);
});

test('writeReport: creates summary.json, summary.md, per-task files', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'reporter-test-'));
  try {
    const report = mockReport();
    const { jsonPath, mdPath } = await writeReport(report, tmp);

    const expectedRunDir = path.join(tmp, report.runId);
    assert.equal(jsonPath, path.join(expectedRunDir, 'summary.json'));
    assert.equal(mdPath, path.join(expectedRunDir, 'summary.md'));

    const jsonContent = await readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(jsonContent);
    assert.equal(parsed.runId, report.runId);
    assert.equal(parsed.totalScore, 58.3);
    assert.equal(parsed.config.model, 'Qwen3-30B');

    const mdContent = await readFile(mdPath, 'utf8');
    assert.match(mdContent, /```/);
    assert.match(mdContent, /MA Agent Benchmark/);

    const perTaskDir = path.join(expectedRunDir, 'per-task');
    const perTaskStat = await stat(perTaskDir);
    assert.ok(perTaskStat.isDirectory());

    // All tasks from L0 (2) + L1 (1) + L2 (2) = 5 tasks, each has JSON and Markdown detail.
    for (const id of ['L0-001', 'L0-002', 'L1-001', 'L2-001', 'L2-002']) {
      const p = path.join(perTaskDir, `${id}.json`);
      const s = await stat(p);
      assert.ok(s.isFile(), `${id}.json should exist`);
      const body = JSON.parse(await readFile(p, 'utf8'));
      assert.equal(body.taskId, id);
      assert.ok(Array.isArray(body.runs));

      const md = path.join(perTaskDir, `${id}.md`);
      const mdStat = await stat(md);
      assert.ok(mdStat.isFile(), `${id}.md should exist`);
      assert.match(await readFile(md, 'utf8'), new RegExp(`# ${id}`));
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('writeReport: works when byLevel is empty (no per-task files)', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'reporter-test-'));
  try {
    const report = mockReport({ byLevel: {} });
    const { jsonPath, mdPath } = await writeReport(report, tmp);
    await stat(jsonPath);
    await stat(mdPath);
    // per-task dir still created but empty
    const perTaskDir = path.join(tmp, report.runId, 'per-task');
    const s = await stat(perTaskDir);
    assert.ok(s.isDirectory());
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

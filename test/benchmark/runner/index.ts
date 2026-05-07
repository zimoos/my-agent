#!/usr/bin/env tsx
/**
 * Benchmark CLI entry point.
 *
 * Usage:
 *   npm run benchmark                   # full run (L0+L1+L2)
 *   npm run benchmark -- --level L1     # single level
 *   npm run benchmark -- --task L1-005  # single task
 *   npm run benchmark -- --dry-run      # load + validate only
 *
 * L3 (universal agent benchmark):
 *   npm run benchmark -- --level L3 --adapter test/benchmark/adapters/ma.yaml --judge-key $OPENAI_API_KEY
 *   npm run benchmark -- --level L3 --adapter <path> --judge-key <key> --task L3-001
 */

import * as path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadTasks } from './task-loader.js';
import { runTask } from './task-runner.js';
import { scoreLevel, scoreBenchmark } from './scorer.js';
import { writeReport, formatDashboard } from './reporter.js';
import type {
  TaskDef,
  TaskResult,
  TaskScore,
  LevelScore,
  BenchmarkReport,
  Level,
  RunTrace,
} from './types.js';
import {
  LEVEL_ORDER,
  EXIT_OK,
  EXIT_GATE_FAIL,
  EXIT_L0_INVALID,
  EXIT_RUNTIME_ERROR,
} from './types.js';
import { loadAdapter } from './cli-adapter.js';
import { loadL3Tasks, runL3Task, type L3TaskResult } from './l3-task-runner.js';
import { selectJudgeModel, type JudgeConfig, type JudgeScore } from './judge-client.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const TASKS_DIR = path.join(ROOT, 'tasks');
const TASKS_L3_DIR = path.join(ROOT, 'tasks', 'L3');
const FIXTURES_DIR = path.join(ROOT, 'fixtures');
const E2E_FIXTURES_DIR = path.resolve(ROOT, '..', 'e2e', 'fixtures');
const REPORTS_DIR = path.join(ROOT, 'reports');

interface CliArgs {
  level?: Level;
  task?: string;
  dryRun: boolean;
  configPath?: string;
  adapterPath?: string;
  judgeKey?: string;
  judgeBaseURL?: string;
  tasksL3Dir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { dryRun: false };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--level' && argv[i + 1]) {
      out.level = argv[++i] as Level;
    } else if (arg === '--task' && argv[i + 1]) {
      out.task = argv[++i];
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--config' && argv[i + 1]) {
      out.configPath = argv[++i];
    } else if (arg === '--adapter' && argv[i + 1]) {
      out.adapterPath = argv[++i];
    } else if (arg === '--judge-key' && argv[i + 1]) {
      out.judgeKey = argv[++i];
    } else if (arg === '--judge-base-url' && argv[i + 1]) {
      out.judgeBaseURL = argv[++i];
    } else if (arg === '--tasks-l3' && argv[i + 1]) {
      out.tasksL3Dir = argv[++i];
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  // 1. Load L0-L2 tasks via existing loader
  console.log(`Loading tasks from ${TASKS_DIR}...`);
  const { tasks, errors } = loadTasks({
    tasksDir: TASKS_DIR,
    fixturesDir: FIXTURES_DIR,
    e2eFixturesDir: E2E_FIXTURES_DIR,
    // L3 由独立 loader 处理；现有 loader 看到 L3 YAML 会按 TaskDef 强校验失败，
    // 因此 L3 时把 L0-L2 过滤器关掉不影响；但要确保 task-loader 不扫到 L3 目录。
    filterLevel: args.level === 'L3' ? undefined : args.level,
    filterTask: args.level === 'L3' ? undefined : args.task,
  });

  if (errors.length > 0) {
    console.error('\n❌ Task validation errors:\n');
    for (const e of errors) console.error(`  • ${e}`);
    process.exit(EXIT_L0_INVALID);
  }

  const runL3 = args.level === 'L3' || (args.task?.startsWith('L3-') ?? false);
  let l3Tasks: ReturnType<typeof loadL3Tasks> = [];
  if (runL3) {
    const l3Dir = args.tasksL3Dir ?? TASKS_L3_DIR;
    try {
      l3Tasks = loadL3Tasks(l3Dir);
    } catch (err) {
      console.error(`\n❌ L3 task load error: ${(err as Error).message}`);
      process.exit(EXIT_L0_INVALID);
    }
    if (args.task) {
      l3Tasks = l3Tasks.filter((t) => t.id === args.task);
    }
  }

  console.log(
    `Loaded ${tasks.length} tasks (L0-L2)` +
      (runL3 ? ` + ${l3Tasks.length} L3 tasks` : ''),
  );
  if (args.dryRun) {
    console.log('Dry run — validation passed, no execution.');
    process.exit(EXIT_OK);
  }

  if (runL3 && l3Tasks.length === 0) {
    console.error('\n❌ --level L3 指定,但没有找到任何 L3 任务');
    process.exit(EXIT_L0_INVALID);
  }

  if (runL3 && !args.adapterPath) {
    console.error('\n❌ L3 需要 --adapter <path>');
    process.exit(EXIT_L0_INVALID);
  }
  if (runL3 && !args.judgeKey) {
    console.error('\n❌ L3 需要 --judge-key <apiKey>');
    process.exit(EXIT_L0_INVALID);
  }

  // 2. Group L0-L2 by level
  const byLevel = new Map<Level, TaskDef[]>();
  for (const t of tasks) {
    const arr = byLevel.get(t.level) || [];
    arr.push(t);
    byLevel.set(t.level, arr);
  }

  const runL0Gate = !args.level && !args.task;
  if (runL0Gate && !byLevel.has('L0')) {
    console.error('\n❌ No L0 tasks found — L0 gate cannot be evaluated.');
    process.exit(EXIT_L0_INVALID);
  }

  // 3. Run L0-L2 serially, level by level
  const allResults: TaskResult[] = [];
  const levelScores: LevelScore[] = [];
  const startedAt = Date.now();

  for (const level of LEVEL_ORDER) {
    if (level === 'L3') continue; // L3 单独走
    const levelTasks = byLevel.get(level);
    if (!levelTasks || levelTasks.length === 0) continue;

    console.log(`\n── Running ${level} (${levelTasks.length} tasks) ──`);
    const results: TaskResult[] = [];
    const weights: Record<string, number> = {};

    for (let i = 0; i < levelTasks.length; i++) {
      const task = levelTasks[i];
      const progress = `[${i + 1}/${levelTasks.length}]`;
      process.stdout.write(`  ${progress} ${task.id} ${task.title}...`);

      try {
        const result = await runTask(task, { configPath: args.configPath });
        results.push(result);
        weights[task.id] = task.weight;
        const icon = result.passRate >= 0.5 ? '✓' : '✗';
        console.log(
          ` ${icon} median=${result.median.toFixed(2)} stability=${result.stability.toFixed(2)}`,
        );
      } catch (err) {
        console.log(` 💥 ${(err as Error).message}`);
        results.push({
          taskId: task.id,
          level: task.level,
          runs: [],
          median: 0,
          stability: 0,
          passRate: 0,
        });
        weights[task.id] = task.weight;
      }
    }

    const ls = scoreLevel(results, level, weights);
    levelScores.push(ls);
    allResults.push(...results);

    const icon = ls.gateOk ? '✓' : '✗';
    console.log(
      `  ${level} result: score=${ls.score.toFixed(3)} passRate=${ls.passRate.toFixed(3)} gate=${icon}`,
    );

    if (level === 'L0' && runL0Gate && !ls.gateOk) {
      console.error(
        '\n❌ L0 gate failed — invalid run. Fix basic connectivity first.',
      );
      process.exit(EXIT_L0_INVALID);
    }
  }

  // 4. Run L3 if requested
  const l3Details: L3TaskResult[] = [];
  if (runL3 && l3Tasks.length > 0) {
    const adapterConfig = loadAdapter(args.adapterPath!);
    const judgeConfig: JudgeConfig = {
      model: selectJudgeModel(adapterConfig.underlyingModel),
      apiKey: args.judgeKey!,
    };
    if (args.judgeBaseURL) judgeConfig.baseURL = args.judgeBaseURL;

    console.log(
      `\n── Running L3 (${l3Tasks.length} tasks, adapter=${adapterConfig.name}, judge=${judgeConfig.model}) ──`,
    );

    const l3TaskResults: TaskResult[] = [];
    const l3Weights: Record<string, number> = {};

    for (let i = 0; i < l3Tasks.length; i++) {
      const t = l3Tasks[i];
      const progress = `[${i + 1}/${l3Tasks.length}]`;
      process.stdout.write(`  ${progress} ${t.id} ${t.title}...`);

      try {
        const r = await runL3Task(t, adapterConfig, judgeConfig, {
          fixturesDir: FIXTURES_DIR,
        });
        l3Details.push(r);
        l3TaskResults.push(l3ResultToTaskResult(r));
        l3Weights[t.id] = t.weight;
        const icon = r.passed ? '✓' : '✗';
        console.log(
          ` ${icon} total=${r.total.toFixed(2)} runs=${r.runs.length}`,
        );
      } catch (err) {
        console.log(` 💥 ${(err as Error).message}`);
        l3TaskResults.push({
          taskId: t.id,
          level: 'L3',
          runs: [],
          median: 0,
          stability: 0,
          passRate: 0,
        });
        l3Weights[t.id] = t.weight;
      }
    }

    const ls = scoreLevel(l3TaskResults, 'L3', l3Weights);
    levelScores.push(ls);
    allResults.push(...l3TaskResults);

    const icon = ls.gateOk ? '✓' : '✗';
    console.log(
      `  L3 result: score=${ls.score.toFixed(3)} passRate=${ls.passRate.toFixed(3)} gate=${icon}`,
    );
  }

  // 5. Score benchmark
  const { totalScore, level: finalLevel } = scoreBenchmark(levelScores);
  const elapsedMs = Date.now() - startedAt;

  // 6. Build report
  const weakest = allResults
    .filter((r) => r.median < 0.7)
    .sort((a, b) => a.median - b.median)
    .slice(0, 5)
    .map((r) => ({
      taskId: r.taskId,
      median: r.median,
      reason: r.passRate === 0 ? 'never passed' : 'low score',
    }));

  const report: BenchmarkReport = {
    runId:
      new Date().toISOString().replace(/[:.]/g, '-') +
      '-' +
      Math.random().toString(36).slice(2, 6),
    config: { agent: 'MA', model: 'local', baseURL: 'http://localhost' },
    totalScore,
    level: finalLevel,
    byLevel: Object.fromEntries(
      levelScores.map((ls) => [ls.level, ls]),
    ) as BenchmarkReport['byLevel'],
    weakest,
    startedAt: new Date(startedAt).toISOString(),
    elapsedMs,
  };

  // 7. Output
  console.log('\n' + formatDashboard(report));

  await writeReport(report, REPORTS_DIR);
  if (l3Details.length > 0) {
    const runDir = path.join(REPORTS_DIR, report.runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, 'l3-details.json'),
      JSON.stringify(l3Details, null, 2),
      'utf8',
    );
  }
  console.log(`\nReport written to ${REPORTS_DIR}/${report.runId}/`);

  // 8. Exit code
  const allGatesPass = levelScores.every((ls) => ls.gateOk);
  process.exit(allGatesPass ? EXIT_OK : EXIT_GATE_FAIL);
}

// ─── Helpers ───

// 把 L3 的 JudgeScore 包成现有 TaskResult 形状,以便复用 scoreLevel / reporter。
// 每 run 的 rawScore 用 6 维加权 total;hardPass 用 L3 pass 四重门槛。
function l3ResultToTaskResult(r: L3TaskResult): TaskResult {
  const emptyTrace: RunTrace = {
    taskId: r.taskId,
    runIndex: 0,
    events: [],
    toolCalls: [],
    finalText: '',
    messagesCount: 0,
    thinkingMs: 0,
    apiCalls: 0,
    startedAt: 0,
    elapsedMs: 0,
    hitMaxLoops: false,
    aborted: false,
    crashed: false,
  };

  const runScores: TaskScore[] = r.runs.map((score, i) => {
    const total = weightedTotal(score);
    const hardPass = isL3Pass(score, total);
    return {
      taskId: r.taskId,
      hardPass,
      softScore: 1,
      rawScore: total,
      hardResults: [],
      softResults: [],
      trace: { ...emptyTrace, runIndex: i },
    };
  });

  const passRate =
    runScores.length > 0
      ? runScores.filter((s) => s.hardPass).length / runScores.length
      : 0;

  return {
    taskId: r.taskId,
    level: 'L3',
    runs: runScores,
    median: r.total,
    stability: r.passed ? 1 : 0,
    passRate,
  };
}

function weightedTotal(s: JudgeScore): number {
  return (
    s.taskCompletion * 0.25 +
    s.correctness * 0.2 +
    s.completeness * 0.15 +
    s.codeQuality * 0.1 +
    s.efficiency * 0.1 +
    s.noRegression * 0.2
  );
}

function isL3Pass(s: JudgeScore, total: number): boolean {
  return (
    total >= 0.65 &&
    s.taskCompletion >= 0.5 &&
    s.correctness >= 0.5 &&
    s.noRegression === 1
  );
}

main().catch((err) => {
  console.error('Benchmark runtime error:', err);
  process.exit(EXIT_RUNTIME_ERROR);
});

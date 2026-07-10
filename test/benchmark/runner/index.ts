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
 *   npm run benchmark -- --level L3 --adapter test/benchmark/adapters/codex.yaml --task L3-009 --runs 1
 *   npm run benchmark -- --level L3 --adapter <path> --judge-key <key> --judge-model <model> --task L3-001
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
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
import { loadAdapter, type AdapterConfig } from './cli-adapter.js';
import { loadL3Tasks, runL3Task, type L3TaskResult } from './l3-task-runner.js';
import { selectJudgeModel, type JudgeConfig, type JudgeScore } from './judge-client.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const TASKS_DIR = path.join(ROOT, 'tasks');
const TASKS_L3_DIR = path.join(ROOT, 'tasks', 'L3');
const FIXTURES_DIR = path.join(ROOT, 'fixtures');
const E2E_FIXTURES_DIR = path.resolve(ROOT, '..', 'e2e', 'fixtures');
const REPORTS_DIR = path.join(ROOT, 'reports');
const BENCHMARK_ENV_PATH = path.join(os.homedir(), '.my-agent', 'benchmark.env');

interface CliArgs {
  level?: Level;
  task?: string;
  dryRun: boolean;
  configPath?: string;
  adapterPath?: string;
  judgeKey?: string;
  judgeBaseURL?: string;
  judgeModel?: string;
  tasksL3Dir?: string;
  runs?: number;
  seed?: string;
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
    } else if (arg === '--judge-model' && argv[i + 1]) {
      out.judgeModel = argv[++i];
    } else if (arg === '--tasks-l3' && argv[i + 1]) {
      out.tasksL3Dir = argv[++i];
    } else if (arg === '--runs' && argv[i + 1]) {
      const runs = Number(argv[++i]);
      if (Number.isInteger(runs) && runs > 0) {
        out.runs = runs;
      }
    } else if (arg === '--seed' && argv[i + 1]) {
      out.seed = argv[++i];
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  applyBenchmarkEnvDefaults(args);
  const runL3 = args.level === 'L3' || (args.task?.startsWith('L3-') ?? false);

  // 1. Load L0-L2 tasks via existing loader
  const l12Load = runL3
    ? { tasks: [] as TaskDef[], errors: [] as string[] }
    : loadTasks({
        tasksDir: TASKS_DIR,
        fixturesDir: FIXTURES_DIR,
        e2eFixturesDir: E2E_FIXTURES_DIR,
        filterLevel: args.level,
        filterTask: args.task,
      });
  const tasks = args.runs
    ? l12Load.tasks.map((t) => withRuns(t, args.runs!))
    : l12Load.tasks;
  const errors = l12Load.errors;

  if (errors.length > 0) {
    console.error('\n❌ Task validation errors:\n');
    for (const e of errors) console.error(`  • ${e}`);
    process.exit(EXIT_L0_INVALID);
  }

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
    if (args.runs) {
      l3Tasks = l3Tasks.map((t) => withRuns(t, args.runs!));
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
  const runId = makeRunId(startedAt);
  const benchmarkSeed = args.seed ?? randomBytes(8).toString('hex');
  let adapterConfigForReport: AdapterConfig | undefined;
  const l12JudgeConfig: JudgeConfig | undefined = args.judgeKey
    ? {
        model: resolveJudgeModel(
          args.judgeModel ?? selectJudgeModel('local'),
          args.judgeBaseURL,
        ),
        apiKey: args.judgeKey,
        ...(args.judgeBaseURL ? { baseURL: args.judgeBaseURL } : {}),
      }
    : undefined;

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
        const result = await runTask(task, {
          configPath: args.configPath,
          judgeConfig: l12JudgeConfig,
          benchmarkRunId: runId,
          benchmarkSeed,
        });
        results.push(result);
        weights[task.id] = task.weight;
        const icon = result.skipped ? '↷' : result.passRate >= 0.5 ? '✓' : '✗';
        console.log(
          result.skipped
            ? ` ${icon} skipped=${result.skipReason}`
            : ` ${icon} median=${result.median.toFixed(2)} stability=${result.stability.toFixed(2)}`,
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
    adapterConfigForReport = adapterConfig;
    const model = resolveJudgeModel(
      args.judgeModel ?? selectJudgeModel(adapterConfig.underlyingModel),
      args.judgeBaseURL,
    );
    const judgeConfig: JudgeConfig = {
      model,
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
    runId,
    freshness: {
      seed: benchmarkSeed,
      mode: 'static-regression-isolated-workspace',
      taskSelectionFingerprint: taskSelectionFingerprint(tasks, l3Tasks),
      semanticVariation: 'static-regression',
      notes: [
        '每个 run 复制 fixture 到新的临时 workspace 并重启 agent。',
        '当前模式保持题面稳定,用于回归可比性; 防背题的新鲜语义变体需要 seeded variant/hidden holdout 模式。',
      ],
    },
    config: buildReportConfig(args, adapterConfigForReport),
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

function makeRunId(startedAt: number): string {
  return (
    new Date(startedAt).toISOString().replace(/[:.]/g, '-') +
    '-' +
    randomBytes(3).toString('hex')
  );
}

function taskSelectionFingerprint(
  tasks: TaskDef[],
  l3Tasks: ReturnType<typeof loadL3Tasks>,
): string {
  const payload = {
    l12: tasks.map((t) => ({
      id: t.id,
      sourcePath: t.sourcePath,
      weight: t.weight,
      runs: t.runtime.runs,
    })),
    l3: l3Tasks.map((t) => ({
      id: t.id,
      sourcePath: t.sourcePath,
      weight: t.weight,
      runs: t.runtime.runs,
    })),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

// 把 L3 的 JudgeScore 包成现有 TaskResult 形状,以便复用 scoreLevel / reporter。
// 每 run 的 rawScore 用 6 维加权 total;hardPass 用 L3 pass 四重门槛。
export function l3ResultToTaskResult(r: L3TaskResult): TaskResult {
  const emptyTrace: RunTrace = {
    taskId: r.taskId,
    runIndex: 0,
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
    toolProtocol: { orphanToolResults: 0, unclosedToolCalls: 0 },
    startedAt: 0,
    elapsedMs: 0,
    hitMaxLoops: false,
    aborted: false,
    crashed: false,
  };

  const runScores: TaskScore[] = r.runs.map((score, i) => {
    const total = weightedTotal(score);
    const detail = r.details.find((candidate) => candidate.runIndex === i);
    const hardPass =
      r.passed &&
      detail !== undefined &&
      detail.hardGateFailures.length === 0 &&
      isL3Pass(score, total);
    return {
      taskId: r.taskId,
      hardPass,
      softScore: 1,
      rawScore: hardPass ? total : 0,
      hardResults: [],
      softResults: [],
      trace: { ...emptyTrace, runIndex: i },
    };
  });

  const passRate =
    runScores.length > 0
      ? runScores.filter((s) => s.hardPass).length / runScores.length
      : 0;
  const hasFailedRun = runScores.some((s) => !s.hardPass);

  return {
    taskId: r.taskId,
    level: 'L3',
    runs: runScores,
    median: hasFailedRun ? 0 : r.total,
    stability: hasFailedRun ? 0 : 1,
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

function applyBenchmarkEnvDefaults(args: CliArgs): void {
  const fileEnv = loadBenchmarkEnvFile();
  for (const [key, value] of Object.entries(fileEnv)) {
    process.env[key] ??= value;
  }
  const env = { ...fileEnv, ...process.env };

  args.judgeKey ??= env.MA_BENCH_JUDGE_KEY;
  args.judgeBaseURL ??= env.MA_BENCH_JUDGE_BASE_URL;
  args.judgeModel ??= env.MA_BENCH_JUDGE_MODEL;
}

function buildReportConfig(
  args: CliArgs,
  adapterConfig?: AdapterConfig,
): BenchmarkReport['config'] {
  if (adapterConfig) {
    return {
      agent: adapterConfig.name,
      model: adapterConfig.underlyingModel,
      baseURL: 'cli-adapter',
    };
  }

  const model = readModelConfigForReport(args.configPath);
  return {
    agent: 'MA',
    model: model?.model ?? 'unknown',
    baseURL: model?.baseURL ?? 'unknown',
  };
}

function readModelConfigForReport(
  configPath?: string,
): { model?: string; baseURL?: string } | undefined {
  if (!configPath) return undefined;
  try {
    const raw = fs.readFileSync(path.resolve(configPath), 'utf8');
    const cfg = JSON.parse(raw) as { model?: { model?: unknown; baseURL?: unknown } };
    if (!cfg.model || typeof cfg.model !== 'object') return undefined;
    return {
      model: typeof cfg.model.model === 'string' ? cfg.model.model : undefined,
      baseURL: typeof cfg.model.baseURL === 'string' ? cfg.model.baseURL : undefined,
    };
  } catch {
    return undefined;
  }
}

function loadBenchmarkEnvFile(): Record<string, string> {
  const envPath = process.env.MA_BENCH_ENV_FILE ?? BENCHMARK_ENV_PATH;
  if (!fs.existsSync(envPath)) return {};

  const entries: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

function resolveJudgeModel(model: string, baseURL?: string): string {
  if (baseURL?.includes('api.deepseek.com')) {
    if (model === 'flash') return 'deepseek-v4-flash';
    if (model === 'pro') return 'deepseek-v4-pro';
  }
  return model;
}

function withRuns<T extends { runtime: { runs: number } }>(task: T, runs: number): T {
  return {
    ...task,
    runtime: {
      ...task.runtime,
      runs,
    },
  };
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((err) => {
    console.error('Benchmark runtime error:', err);
    process.exit(EXIT_RUNTIME_ERROR);
  });
}

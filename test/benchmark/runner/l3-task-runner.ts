import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import {
  runAdapter,
  type AdapterConfig,
  type AdapterResult,
} from './cli-adapter.js';
import {
  collectDiff,
  prepareWorkspace,
  type WorkspaceDiff,
} from './workspace-manager.js';
import {
  judge,
  type JudgeConfig,
  type JudgeInput,
  type JudgeScore,
} from './judge-client.js';
import { medianJudgeScore, scoreL3 } from './l3-scorer.js';

// ─── L3TaskDef (YAML shape) ───

export interface L3ObjectiveCheck {
  command: string;
  weightInto: string;
}

export interface L3TaskDef {
  id: string;
  title: string;
  level: 'L3';
  category: string;
  weight: number;
  fixture: {
    project: string;
    setup?: string[];
  };
  prompt: string;
  rubricPoints: string[];
  referenceSolution?: string;
  objectiveChecks: L3ObjectiveCheck[];
  runtime: {
    timeoutSec: number;
    runs: number;
  };
  sourcePath?: string;
}

// 单 run 执行细节（诊断用）
export interface L3RunDetail {
  runIndex: number;
  score: JudgeScore;
  adapter: {
    exitCode: number;
    timedOut: boolean;
    elapsedMs: number;
  };
  workspaceDiffSummary: string;
  objectiveChecks: Array<{
    command: string;
    weightInto: string;
    exitCode: number;
    stdoutTail: string;
  }>;
}

export interface L3TaskResult {
  taskId: string;
  runs: JudgeScore[];
  median: JudgeScore;
  passed: boolean;
  total: number;
  details: L3RunDetail[];
}

// ─── YAML Loader ───

function requireString(
  obj: Record<string, unknown>,
  key: string,
  loc: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`[${loc}] field "${key}" must be a non-empty string`);
  }
  return v;
}

export function loadL3Task(yamlPath: string): L3TaskDef {
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`L3 task yaml not found: ${yamlPath}`);
  }
  const text = fs.readFileSync(yamlPath, 'utf8');
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    throw new Error(
      `L3 task yaml parse failed [${yamlPath}]: ${(err as Error).message}`,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`L3 task yaml top-level must be a mapping: ${yamlPath}`);
  }
  const obj = raw as Record<string, unknown>;
  const loc = path.basename(yamlPath);

  const id = requireString(obj, 'id', loc);
  const title = requireString(obj, 'title', loc);
  const level = requireString(obj, 'level', loc);
  if (level !== 'L3') {
    throw new Error(`[${loc}] level must be "L3", got "${level}"`);
  }
  const category = requireString(obj, 'category', loc);

  const weightRaw = obj['weight'];
  if (typeof weightRaw !== 'number' || !(weightRaw > 0)) {
    throw new Error(`[${loc}] weight must be a positive number`);
  }

  const fixtureRaw = obj['fixture'];
  if (!fixtureRaw || typeof fixtureRaw !== 'object' || Array.isArray(fixtureRaw)) {
    throw new Error(`[${loc}] fixture must be a mapping`);
  }
  const fixtureObj = fixtureRaw as Record<string, unknown>;
  const fixtureProject = requireString(fixtureObj, 'project', loc);
  let fixtureSetup: string[] | undefined;
  if (fixtureObj['setup'] !== undefined) {
    if (
      !Array.isArray(fixtureObj['setup']) ||
      !(fixtureObj['setup'] as unknown[]).every((s) => typeof s === 'string')
    ) {
      throw new Error(`[${loc}] fixture.setup must be an array of strings`);
    }
    fixtureSetup = fixtureObj['setup'] as string[];
  }

  const prompt = requireString(obj, 'prompt', loc);

  const rubricRaw = obj['rubric_points'];
  if (
    !Array.isArray(rubricRaw) ||
    !rubricRaw.every((s) => typeof s === 'string')
  ) {
    throw new Error(`[${loc}] rubric_points must be an array of strings`);
  }
  const rubricPoints = rubricRaw as string[];

  let referenceSolution: string | undefined;
  if (obj['reference_solution'] !== undefined) {
    if (typeof obj['reference_solution'] !== 'string') {
      throw new Error(`[${loc}] reference_solution must be a string`);
    }
    referenceSolution = obj['reference_solution'];
  }

  const checksRaw = obj['objective_checks'];
  if (!Array.isArray(checksRaw)) {
    throw new Error(`[${loc}] objective_checks must be an array`);
  }
  const objectiveChecks: L3ObjectiveCheck[] = checksRaw.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`[${loc}] objective_checks[${i}] must be a mapping`);
    }
    const c = item as Record<string, unknown>;
    const command = requireString(c, 'command', `${loc} objective_checks[${i}]`);
    const weightInto = requireString(
      c,
      'weight_into',
      `${loc} objective_checks[${i}]`,
    );
    return { command, weightInto };
  });

  const runtimeRaw = obj['runtime'];
  if (!runtimeRaw || typeof runtimeRaw !== 'object' || Array.isArray(runtimeRaw)) {
    throw new Error(`[${loc}] runtime must be a mapping`);
  }
  const runtimeObj = runtimeRaw as Record<string, unknown>;
  const timeoutSec = runtimeObj['timeout_sec'];
  const runs = runtimeObj['runs'];
  if (typeof timeoutSec !== 'number' || !(timeoutSec > 0)) {
    throw new Error(`[${loc}] runtime.timeout_sec must be a positive number`);
  }
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs <= 0) {
    throw new Error(`[${loc}] runtime.runs must be a positive integer`);
  }

  return {
    id,
    title,
    level: 'L3',
    category,
    weight: weightRaw,
    fixture: { project: fixtureProject, setup: fixtureSetup },
    prompt,
    rubricPoints,
    referenceSolution,
    objectiveChecks,
    runtime: { timeoutSec, runs },
    sourcePath: yamlPath,
  };
}

export function loadL3Tasks(tasksDir: string): L3TaskDef[] {
  if (!fs.existsSync(tasksDir)) return [];
  const yamlPaths: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.yaml') || name.endsWith('.yml')) yamlPaths.push(full);
    }
  };
  walk(tasksDir);
  return yamlPaths.map(loadL3Task);
}

// ─── Objective checks execution ───

interface ObjectiveCheckResult {
  command: string;
  weightInto: string;
  exitCode: number;
  stdout: string;
}

function runObjectiveCheck(
  check: L3ObjectiveCheck,
  workdir: string,
): ObjectiveCheckResult {
  try {
    const stdout = execSync(check.command, {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      command: check.command,
      weightInto: check.weightInto,
      exitCode: 0,
      stdout,
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    const exitCode = typeof e.status === 'number' ? e.status : 1;
    const out = toStr(e.stdout) + toStr(e.stderr);
    return {
      command: check.command,
      weightInto: check.weightInto,
      exitCode,
      stdout: out,
    };
  }
}

function toStr(v: Buffer | string | undefined): string {
  if (!v) return '';
  return typeof v === 'string' ? v : v.toString('utf-8');
}

// ─── Core: single run ───

interface RunOnceOutput {
  score: JudgeScore;
  detail: L3RunDetail;
}

async function runOnce(
  task: L3TaskDef,
  fixtureDir: string,
  adapterConfig: AdapterConfig,
  judgeConfig: JudgeConfig,
  runIndex: number,
): Promise<RunOnceOutput> {
  const ws = await prepareWorkspace(fixtureDir, task.fixture.setup);
  try {
    const adapterResult: AdapterResult = await runAdapter(
      adapterConfig,
      task.prompt,
      ws.workdir,
    );

    const diff: WorkspaceDiff = await collectDiff(ws.workdir);

    const checkResults = task.objectiveChecks.map((c) =>
      runObjectiveCheck(c, ws.workdir),
    );

    const judgeInput: JudgeInput = {
      taskDescription: `${task.id} - ${task.title}`,
      prompt: task.prompt,
      rubricPoints: task.rubricPoints,
      referenceSolution: task.referenceSolution,
      workspaceDiff: diff.files.map((f) => f.diff).join('\n'),
      finalAnswer: adapterResult.finalAnswer,
      objectiveChecks: checkResults.map((c) => ({
        command: c.command,
        exitCode: c.exitCode,
        stdout: c.stdout,
        weightInto: c.weightInto,
      })),
      runtimeStats: {
        elapsedMs: adapterResult.elapsedMs,
        exitCode: adapterResult.exitCode,
      },
    };

    const score = await judge(judgeInput, judgeConfig);

    const detail: L3RunDetail = {
      runIndex,
      score,
      adapter: {
        exitCode: adapterResult.exitCode,
        timedOut: adapterResult.timedOut,
        elapsedMs: adapterResult.elapsedMs,
      },
      workspaceDiffSummary: diff.summary,
      objectiveChecks: checkResults.map((c) => ({
        command: c.command,
        weightInto: c.weightInto,
        exitCode: c.exitCode,
        stdoutTail: (c.stdout ?? '').slice(-400),
      })),
    };

    return { score, detail };
  } finally {
    await ws.cleanup();
  }
}

// ─── Public entry ───

export interface RunL3TaskOptions {
  // fixture 根目录；task.fixture.project 相对它定位
  fixturesDir: string;
}

export async function runL3Task(
  task: L3TaskDef,
  adapterConfig: AdapterConfig,
  judgeConfig: JudgeConfig,
  options: RunL3TaskOptions,
): Promise<L3TaskResult> {
  const fixtureDir = path.resolve(options.fixturesDir, task.fixture.project);
  if (!fs.existsSync(fixtureDir)) {
    throw new Error(
      `[${task.id}] fixture project not found: ${fixtureDir}`,
    );
  }

  const scores: JudgeScore[] = [];
  const details: L3RunDetail[] = [];

  for (let i = 0; i < task.runtime.runs; i++) {
    const { score, detail } = await runOnce(
      task,
      fixtureDir,
      adapterConfig,
      judgeConfig,
      i,
    );
    scores.push(score);
    details.push(detail);
  }

  const median = medianJudgeScore(scores);
  const { total, passed } = scoreL3(median);

  return {
    taskId: task.id,
    runs: scores,
    median,
    passed,
    total,
    details,
  };
}

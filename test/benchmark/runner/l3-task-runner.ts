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
import {
  BROWSER_EVIDENCE_CLASSES,
  collectTrustedBrowserEvidence,
  type BrowserEvidenceClass,
  type BrowserEvidenceResult,
  type BrowserVerificationSpec,
  type BrowserViewportSpec,
} from './browser-verifier.js';

// ─── L3TaskDef (YAML shape) ───

export interface L3ObjectiveCheck {
  command: string;
  weightInto: string;
  expectedExit: number;
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
  noModifyFiles: string[];
  objectiveChecks: L3ObjectiveCheck[];
  browserVerification?: BrowserVerificationSpec;
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
    expectedExit: number;
    actualExit: number;
    exitCode: number;
    stdoutTail: string;
  }>;
  browserVerification?: BrowserEvidenceResult & {
    evidencePath: string;
  };
  hardGateFailures: string[];
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
    const command =
      optionalString(c, 'command') ??
      optionalString(c, 'cmd');
    if (!command) {
      throw new Error(
        `[${loc} objective_checks[${i}]] field "command" or "cmd" must be a non-empty string`,
      );
    }
    const weightInto = requireString(
      c,
      'weight_into',
      `${loc} objective_checks[${i}]`,
    );
    const expectedExitRaw = c['expected_exit'];
    let expectedExit = 0;
    if (expectedExitRaw !== undefined) {
      if (
        typeof expectedExitRaw !== 'number' ||
        !Number.isInteger(expectedExitRaw) ||
        expectedExitRaw < 0
      ) {
        throw new Error(
          `[${loc} objective_checks[${i}]] expected_exit must be a non-negative integer`,
        );
      }
      expectedExit = expectedExitRaw;
    }
    return { command, weightInto, expectedExit };
  });

  const noModifyRaw = obj['no_modify_files'];
  let noModifyFiles: string[] = [];
  if (noModifyRaw !== undefined) {
    if (
      !Array.isArray(noModifyRaw) ||
      !noModifyRaw.every((s) => typeof s === 'string' && s.length > 0)
    ) {
      throw new Error(`[${loc}] no_modify_files must be an array of non-empty strings`);
    }
    noModifyFiles = noModifyRaw as string[];
  }

  const browserVerification = parseBrowserVerification(
    obj['browser_verification'],
    loc,
  );

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
    noModifyFiles,
    objectiveChecks,
    browserVerification,
    runtime: { timeoutSec, runs },
    sourcePath: yamlPath,
  };
}

function parseBrowserVerification(
  raw: unknown,
  loc: string,
): BrowserVerificationSpec | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`[${loc}] browser_verification must be a mapping`);
  }
  const obj = raw as Record<string, unknown>;
  const entrypoint = requireString(obj, 'entrypoint', `${loc} browser_verification`);
  const evidencePath = optionalString(obj, 'evidence_path');
  assertRelativePath(entrypoint, `${loc} browser_verification.entrypoint`);
  if (evidencePath) {
    assertRelativePath(evidencePath, `${loc} browser_verification.evidence_path`);
  }

  const requiredRaw = obj['required_evidence'];
  if (!Array.isArray(requiredRaw) || requiredRaw.length === 0) {
    throw new Error(
      `[${loc}] browser_verification.required_evidence must be a non-empty array`,
    );
  }
  const allowedEvidence = new Set<string>(BROWSER_EVIDENCE_CLASSES);
  const requiredEvidence: BrowserEvidenceClass[] = [];
  for (const [i, value] of requiredRaw.entries()) {
    if (typeof value !== 'string' || !allowedEvidence.has(value)) {
      throw new Error(
        `[${loc}] browser_verification.required_evidence[${i}] is not supported`,
      );
    }
    if (requiredEvidence.includes(value as BrowserEvidenceClass)) {
      throw new Error(
        `[${loc}] browser_verification.required_evidence contains duplicate "${value}"`,
      );
    }
    requiredEvidence.push(value as BrowserEvidenceClass);
  }

  const viewportsRaw = obj['viewports'];
  if (!Array.isArray(viewportsRaw) || viewportsRaw.length === 0) {
    throw new Error(`[${loc}] browser_verification.viewports must be a non-empty array`);
  }
  const viewportNames = new Set<string>();
  const viewports: BrowserViewportSpec[] = viewportsRaw.map((value, i) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        `[${loc}] browser_verification.viewports[${i}] must be a mapping`,
      );
    }
    const viewport = value as Record<string, unknown>;
    const name = requireString(
      viewport,
      'name',
      `${loc} browser_verification.viewports[${i}]`,
    );
    const width = viewport['width'];
    const height = viewport['height'];
    if (!Number.isInteger(width) || (width as number) <= 0) {
      throw new Error(
        `[${loc}] browser_verification.viewports[${i}].width must be a positive integer`,
      );
    }
    if (!Number.isInteger(height) || (height as number) <= 0) {
      throw new Error(
        `[${loc}] browser_verification.viewports[${i}].height must be a positive integer`,
      );
    }
    if (viewportNames.has(name)) {
      throw new Error(
        `[${loc}] browser_verification.viewports contains duplicate name "${name}"`,
      );
    }
    viewportNames.add(name);
    return { name, width: width as number, height: height as number };
  });

  const controlsRaw = requiredMapping(obj, 'controls', `${loc} browser_verification`);
  const controls = {
    movementKey: requireString(controlsRaw, 'movement_key', `${loc} browser_verification.controls`),
    collisionKey: requireString(controlsRaw, 'collision_key', `${loc} browser_verification.controls`),
    saveKey: requireString(controlsRaw, 'save_key', `${loc} browser_verification.controls`),
    hitSelector: requireString(controlsRaw, 'hit_selector', `${loc} browser_verification.controls`),
  };

  const hookRaw = requiredMapping(obj, 'hook', `${loc} browser_verification`);
  const hookVersion = hookRaw['version'];
  if (!Number.isInteger(hookVersion) || (hookVersion as number) <= 0) {
    throw new Error(`[${loc}] browser_verification.hook.version must be a positive integer`);
  }
  const hook = {
    global: requireString(hookRaw, 'global', `${loc} browser_verification.hook`),
    version: hookVersion as number,
    snapshotMethod: requireString(
      hookRaw,
      'snapshot_method',
      `${loc} browser_verification.hook`,
    ),
  };

  let server: BrowserVerificationSpec['server'];
  if (obj['server'] !== undefined) {
    const serverRaw = requiredMapping(obj, 'server', `${loc} browser_verification`);
    const host = requireString(serverRaw, 'host', `${loc} browser_verification.server`);
    const port = serverRaw['port'];
    if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65_535) {
      throw new Error(`[${loc}] browser_verification.server.port must be an integer from 0 to 65535`);
    }
    server = { host, port: port as number };
  }

  let persistence: BrowserVerificationSpec['persistence'];
  if (obj['persistence'] !== undefined) {
    const persistenceRaw = requiredMapping(
      obj,
      'persistence',
      `${loc} browser_verification`,
    );
    const storageKey = requireString(
      persistenceRaw,
      'storage_key',
      `${loc} browser_verification.persistence`,
    );
    const observedStatePathsRaw = persistenceRaw['observed_state_paths'];
    if (
      !Array.isArray(observedStatePathsRaw) ||
      observedStatePathsRaw.length === 0 ||
      !observedStatePathsRaw.every((value) => typeof value === 'string' && value.length > 0)
    ) {
      throw new Error(
        `[${loc}] browser_verification.persistence.observed_state_paths must be a non-empty array of strings`,
      );
    }
    persistence = {
      storageKey,
      observedStatePaths: observedStatePathsRaw as string[],
    };
  }

  return {
    entrypoint,
    requiredEvidence,
    viewports,
    controls,
    hook,
    ...(persistence ? { persistence } : {}),
    ...(server ? { server } : {}),
    ...(evidencePath ? { evidencePath } : {}),
  };
}

function requiredMapping(
  obj: Record<string, unknown>,
  key: string,
  loc: string,
): Record<string, unknown> {
  const value = obj[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[${loc}] field "${key}" must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function assertRelativePath(value: string, loc: string): void {
  if (path.isAbsolute(value) || path.normalize(value).split(path.sep).includes('..')) {
    throw new Error(`[${loc}] must stay within the benchmark workspace`);
  }
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
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
  expectedExit: number;
  actualExit: number;
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
      expectedExit: check.expectedExit,
      actualExit: 0,
      exitCode: check.expectedExit === 0 ? 0 : 1,
      stdout,
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    const exitCode = typeof e.status === 'number' ? e.status : 1;
    const out = toStr(e.stdout) + toStr(e.stderr);
    return {
      command: check.command,
      weightInto: check.weightInto,
      expectedExit: check.expectedExit,
      actualExit: exitCode,
      exitCode: exitCode === check.expectedExit ? 0 : exitCode || 1,
      stdout: `expected_exit=${check.expectedExit} actual_exit=${exitCode}\n${out}`,
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

    const checkResults = [
      ...task.objectiveChecks,
      ...task.noModifyFiles.map((file) => ({
        command: `git diff --quiet HEAD -- ${shellQuote(file)}`,
        weightInto: 'NoRegression',
        expectedExit: 0,
      })),
    ].map((c) => runObjectiveCheck(c, ws.workdir));

    const browserVerification = task.browserVerification
      ? await collectTrustedBrowserEvidence(task.browserVerification, ws.workdir)
      : undefined;
    const judgeChecks: JudgeInput['objectiveChecks'] = checkResults.map((c) => ({
      command: c.command,
      exitCode: c.exitCode,
      stdout: c.stdout,
      weightInto: c.weightInto,
    }));
    if (browserVerification) {
      judgeChecks.push({
        command: `browser_verification ${browserVerification.evidencePath}`,
        exitCode: browserVerification.passed ? 0 : 1,
        stdout: browserVerification.summary,
        weightInto: 'TaskCompletion',
      });
    }

    const judgeInput: JudgeInput = {
      taskDescription: `${task.id} - ${task.title}`,
      prompt: task.prompt,
      rubricPoints: task.rubricPoints,
      referenceSolution: task.referenceSolution,
      workspaceDiff: diff.files.map((f) => f.diff).join('\n'),
      finalAnswer: adapterResult.finalAnswer,
      objectiveChecks: judgeChecks,
      runtimeStats: {
        elapsedMs: adapterResult.elapsedMs,
        exitCode: adapterResult.exitCode,
      },
    };

    const score = await judge(judgeInput, judgeConfig);

    const hardGateFailures = [
      ...(adapterResult.timedOut ? ['adapter timed out'] : []),
      ...(adapterResult.exitCode !== 0
        ? [`adapter exited with code ${adapterResult.exitCode}`]
        : []),
      ...checkResults
        .filter((check) => check.exitCode !== 0)
        .map((check) => `objective check failed: ${check.command}`),
      ...(browserVerification?.failures ?? []).map(
        (failure) => `browser verification failed: ${failure}`,
      ),
    ];

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
        expectedExit: c.expectedExit,
        actualExit: c.actualExit,
        exitCode: c.exitCode,
        stdoutTail: (c.stdout ?? '').slice(-400),
      })),
      browserVerification: browserVerification && {
        passed: browserVerification.passed,
        failures: browserVerification.failures,
        evidencePath: browserVerification.evidencePath,
      },
      hardGateFailures,
    };

    return { score, detail };
  } finally {
    await ws.cleanup();
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
  const { total, passed: scorePassed } = scoreL3(median);
  const passed = scorePassed && details.every((detail) => detail.hardGateFailures.length === 0);

  return {
    taskId: task.id,
    runs: scores,
    median,
    passed,
    total,
    details,
  };
}

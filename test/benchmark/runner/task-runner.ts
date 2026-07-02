/**
 * task-runner.ts — Wave 2 业务模块
 *
 * 把 Wave1 的独立模块串成完整一条 task 的执行链：
 *   bootstrap → chat (1 or N rounds) → collectEvents → (mergeTraces) →
 *   evaluateHard → evaluateSoft → scoreTask → shutdown → cleanup
 *
 * 按 `task.runtime.runs` 次重复执行后，取 median 得到 TaskResult。
 *
 * 关键约束（见 docs/benchmark-m1-consensus.md 第 1/2/10 条）：
 * - 每 run 重开 agent，避免跨 run 状态污染
 * - process.chdir 与 cleanup 用 try/finally 保证恢复
 * - bootstrap 失败 → 本次 run crashed=true, rawScore=0
 * - 多轮用 mergeTraces 聚合再打断言
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { bootstrap, shutdown } from '../../../src/index.js';
import type { ChatContent } from '../../../src/mcp/types.js';
import { prepareFixture } from './fixture-manager.js';
import { collectEvents, mergeTraces } from './event-collector.js';
import { evaluateHard } from './assertions/hard.js';
import { evaluateSoftWithJudge } from './assertions/soft.js';
import { scoreTask, computeMedian } from './scorer.js';
import type {
  TaskDef,
  TaskResult,
  TaskScore,
  RunTrace,
  HardAssertionResult,
  SoftResult,
  AttachmentSpec,
  Requirement,
} from './types.js';
import type { JudgeConfig } from './judge-client.js';

export interface RunTaskOptions {
  configPath?: string;
  judgeConfig?: JudgeConfig;
  benchmarkRunId?: string;
  benchmarkSeed?: string;
}

/**
 * 执行一条 task，内部循环 runs 次取 median。
 *
 * @param task    — task-loader 产出的 TaskDef
 * @param options — { configPath?: string } 透传给 bootstrap
 * @returns TaskResult（包含每 run 的 TaskScore + median + stability + passRate）
 */
export async function runTask(
  task: TaskDef,
  options: RunTaskOptions = {}
): Promise<TaskResult> {
  const unmet = unmetRequirements(task.requires);
  if (unmet.length > 0) {
    return skippedTaskResult(task, unmet.join(', '));
  }

  const runs: TaskScore[] = [];
  const totalRuns = Math.max(1, task.runtime.runs);

  for (let i = 0; i < totalRuns; i++) {
    const score = await runSingle(
      task,
      i,
      options.configPath,
      options.judgeConfig,
      options.benchmarkRunId,
      options.benchmarkSeed,
    );
    runs.push(score);
  }

  const { median, stability, passRate } = computeMedian(runs);

  return {
    taskId: task.id,
    level: task.level,
    runs,
    median,
    stability,
    passRate,
  };
}

/**
 * 单次 run：bootstrap → chat → collect → assert → score → shutdown。
 * 任何阶段异常都被捕获并记为 crashed，保证上游循环继续。
 */
async function runSingle(
  task: TaskDef,
  runIndex: number,
  configPath?: string,
  judgeConfig?: JudgeConfig,
  benchmarkRunId = 'ad-hoc',
  benchmarkSeed = 'none',
): Promise<TaskScore> {
  const originalCwd = process.cwd();

  let prepared: { cwd: string; cleanup: () => Promise<void> } | null = null;
  let connections: Awaited<ReturnType<typeof bootstrap>>['connections'] | null = null;
  let chdirApplied = false;

  let trace: RunTrace = emptyTrace(task.id, runIndex);
  let hardResults: HardAssertionResult[] = [];
  let softResults: SoftResult[] = [];

  // timeout 用 AbortController 串起整次 run；触发时 trace.aborted=true
  const timeoutMs = Math.max(1, task.runtime.timeoutSec) * 1000;
  const abortCtl = new AbortController();
  const timer = setTimeout(() => abortCtl.abort(), timeoutMs);

  try {
    prepared = await prepareFixture(task.fixture);
    process.chdir(prepared.cwd);
    chdirApplied = true;

    const boot = await bootstrap(configPath);
    connections = boot.connections;
    const agent = boot.agent;

    if (task.rounds && task.rounds.length > 0) {
      // 多轮：逐轮采集 → mergeTraces
      const partials: RunTrace[] = [];
      const maxRounds = task.runtime.maxRounds ?? task.rounds.length;
      for (let roundIndex = 0; roundIndex < task.rounds.length && roundIndex < maxRounds; roundIndex++) {
        const round = task.rounds[roundIndex];
        if (abortCtl.signal.aborted) break;
        const gen = agent.chat(
          buildChatContent(round.user, round.attachments, prepared.cwd),
          abortCtl.signal
        );
        const partial = await collectEvents(
          gen,
          task.id,
          runIndex,
          { index: roundIndex, user: round.user }
        );
        partials.push(partial);
      }
      trace = partials.length > 0 ? mergeTraces(partials) : emptyTrace(task.id, runIndex);
    } else if (task.userInput !== undefined) {
      // 单轮
      const gen = agent.chat(
        buildChatContent(task.userInput, task.attachments, prepared.cwd),
        abortCtl.signal
      );
      trace = await collectEvents(gen, task.id, runIndex, { index: 0, user: task.userInput });
    } else {
      // task-loader 应该拦住，兜底：空 trace
      trace = emptyTrace(task.id, runIndex);
      trace.crashed = true;
      trace.crashReason = 'task has neither userInput nor rounds';
    }

    if (abortCtl.signal.aborted) {
      trace.aborted = true;
    }
    trace.freshness = {
      runId: benchmarkRunId,
      seed: benchmarkSeed,
      caseId: `${task.id}#${runIndex}#${sha256(`${benchmarkSeed}:${task.id}:${runIndex}`).slice(0, 8)}`,
      workspaceId: prepared.workspaceId,
      ...(task.fixture?.project ? { fixtureProject: task.fixture.project } : {}),
      ...(prepared.fixtureFingerprint ? { fixtureFingerprint: prepared.fixtureFingerprint } : {}),
      promptFingerprint: taskPromptFingerprint(task),
      mode: 'static-regression-isolated-workspace',
    };

    // 断言评估；cwd 仍在 fixture 目录，file_content/exit_code 才能拿到正确路径
    hardResults = evaluateHard(task.hardAssertions, trace, prepared.cwd);
    softResults = await evaluateSoftWithJudge(
      task.softAssertions,
      trace,
      task,
      hardResults,
      judgeConfig
    );
  } catch (err) {
    // bootstrap / fixture / chat 任何阶段挂了都进这里
    trace.crashed = true;
    trace.crashReason = err instanceof Error ? err.message : String(err);
    // 已经 prepare 了 fixture 就尝试用当前 trace 跑断言，没 prepare 就只能给空结果
    if (prepared) {
      try {
        hardResults = evaluateHard(task.hardAssertions, trace, prepared.cwd);
      } catch {
        hardResults = [];
      }
    }
    try {
      softResults = await evaluateSoftWithJudge(
        task.softAssertions,
        trace,
        task,
        hardResults,
        judgeConfig
      );
    } catch {
      softResults = [];
    }
  } finally {
    clearTimeout(timer);
    if (connections) {
      try {
        await shutdown(connections);
      } catch {
        /* ignore */
      }
    }
    if (chdirApplied) {
      try {
        process.chdir(originalCwd);
      } catch {
        /* ignore */
      }
    }
    if (prepared) {
      try {
        await prepared.cleanup();
      } catch {
        /* ignore */
      }
    }
  }

  // scorer.scoreTask 只看 hardResults.every(passed)；
  // crashed/aborted/hitMaxLoops 必须在这里强制 fail 整次 run（rawScore=0）。
  const failed = trace.crashed || trace.aborted || trace.hitMaxLoops;
  const score = scoreTask(hardResults, softResults, { taskId: task.id, trace });
  if (failed) {
    return { ...score, hardPass: false, rawScore: 0 };
  }
  return score;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function taskPromptFingerprint(task: TaskDef): string {
  return sha256(JSON.stringify({
    userInput: task.userInput,
    attachments: task.attachments,
    rounds: task.rounds?.map((round) => ({
      user: round.user,
      attachments: round.attachments,
    })),
  })).slice(0, 16);
}

/**
 * crash 兜底用的空 trace。
 */
function emptyTrace(taskId: string, runIndex: number): RunTrace {
  return {
    taskId,
    runIndex,
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
    startedAt: Date.now(),
    elapsedMs: 0,
    hitMaxLoops: false,
    aborted: false,
    crashed: false,
  };
}

function unmetRequirements(requires: Requirement[] | undefined): string[] {
  const missing: string[] = [];
  for (const req of requires ?? []) {
    if (req === 'vision' && process.env.MA_BENCH_VISION !== '1') {
      missing.push('vision (set MA_BENCH_VISION=1)');
    }
    if (req === 'network' && process.env.MA_BENCH_NETWORK !== '1') {
      missing.push('network (set MA_BENCH_NETWORK=1)');
    }
    if (req === 'write_access' && process.env.MA_BENCH_READONLY === '1') {
      missing.push('write_access (MA_BENCH_READONLY=1)');
    }
  }
  return missing;
}

function skippedTaskResult(task: TaskDef, reason: string): TaskResult {
  const trace = emptyTrace(task.id, 0);
  const score: TaskScore = {
    taskId: task.id,
    hardPass: true,
    softScore: 1,
    rawScore: 1,
    hardResults: [],
    softResults: [],
    trace,
    skipped: true,
    skipReason: reason,
  };
  return {
    taskId: task.id,
    level: task.level,
    runs: [score],
    median: 1,
    stability: 1,
    passRate: 1,
    skipped: true,
    skipReason: reason,
  };
}

function buildChatContent(
  text: string,
  attachments: AttachmentSpec[] | undefined,
  cwd: string
): ChatContent {
  if (!attachments || attachments.length === 0) return text;
  return [
    { type: 'text', text },
    ...attachments.map((attachment) => ({
      type: 'image_url' as const,
      image_url: { url: imageToDataUrl(path.resolve(cwd, attachment.path), attachment.mime) },
    })),
  ];
}

function imageToDataUrl(file: string, explicitMime?: string): string {
  const mime = explicitMime ?? mimeFromPath(file);
  const data = fs.readFileSync(file).toString('base64');
  return `data:${mime};base64,${data}`;
}

function mimeFromPath(file: string): string {
  const ext = path.extname(file).toLowerCase().replace(/^\./, '');
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/png';
}

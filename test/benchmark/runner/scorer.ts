import type {
  HardAssertionResult,
  Level,
  LevelScore,
  RunTrace,
  SoftResult,
  TaskResult,
  TaskScore,
} from './types.js';
import { LEVEL_CONFIG, LEVEL_ORDER } from './types.js';

// ─── scoreTask ───
// hardPass = 所有 hard 全过
// softScore = 仅对 score !== null 的 soft 做加权平均（共识 #6：null 排除分母）
// rawScore = hardPass ? (0.6 + 0.4 × softScore) : 0
//
// taskId/trace 是上下文字段，由 task-runner 在调用时注入；
// 当前函数的职责是把"断言结果"算成"分数快照"。

export function scoreTask(
  hardResults: HardAssertionResult[],
  softResults: SoftResult[],
  ctx: { taskId: string; trace: RunTrace }
): TaskScore {
  const hardPass = hardResults.every((r) => r.passed);
  const softScore = computeSoftScore(softResults);
  const rawScore = hardPass ? 0.6 + 0.4 * softScore : 0;
  return {
    taskId: ctx.taskId,
    hardPass,
    softScore,
    rawScore,
    hardResults,
    softResults,
    trace: ctx.trace,
  };
}

function computeSoftScore(softResults: SoftResult[]): number {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const r of softResults) {
    if (r.score === null) continue;
    weightedSum += r.score * r.weight;
    weightTotal += r.weight;
  }
  // 分母为 0（全 null 或全 weight=0）→ softScore = 1，代表 soft 部分无负面证据。
  // 保持 L0 这类无 soft 断言任务在 hardPass 下 rawScore = 1.0。
  if (weightTotal === 0) return 1;
  return weightedSum / weightTotal;
}

// ─── computeMedian (inlined, 共识 #5) ───

export function computeMedian(runs: TaskScore[]): {
  median: number;
  stability: number;
  passRate: number;
} {
  const activeRuns = runs.filter((r) => !r.skipped);
  if (activeRuns.length === 0) {
    return { median: 0, stability: 0, passRate: 0 };
  }
  const scores = activeRuns.map((r) => r.rawScore);
  const median = medianOf(scores);
  const stability = clamp01(1 - stdDev(scores));
  const passRate = activeRuns.filter((r) => r.hardPass).length / activeRuns.length;
  return { median, stability, passRate };
}

function medianOf(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stdDev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// ─── scoreLevel ───
// score = Σ(weight × median) / Σ(weight)
// passRate = Σ(weight × taskPassRate) / Σ(weight) —— 共识 #9 加权
// gateOk = score ≥ cutoff AND passRate ≥ rate
//
// TaskResult 自身不带 weight（weight 来自 TaskDef），由 task-runner 通过
// taskWeights 映射把 taskId→weight 传进来；未提供则按均权处理。

export function scoreLevel(
  tasks: TaskResult[],
  level: Level,
  taskWeights?: Record<string, number>
): LevelScore {
  const cfg = LEVEL_CONFIG[level];
  const activeTasks = tasks.filter((t) => !t.skipped);
  if (activeTasks.length === 0) {
    return { level, score: 0, passRate: 0, gateOk: false, tasks };
  }
  let scoreSum = 0;
  let passSum = 0;
  let weightSum = 0;
  for (const t of activeTasks) {
    const w = taskWeights?.[t.taskId] ?? 1;
    scoreSum += w * t.median;
    passSum += w * t.passRate;
    weightSum += w;
  }
  if (weightSum === 0) {
    return { level, score: 0, passRate: 0, gateOk: false, tasks };
  }
  const score = scoreSum / weightSum;
  const passRate = passSum / weightSum;
  const gateOk = score >= cfg.cutoff && passRate >= cfg.rate;
  return { level, score, passRate, gateOk, tasks };
}

// ─── scoreBenchmark ───
// totalScore = Σ(α_L × score(L)) 仅对所有前置 gateOk 的 L 求和
// level = max passed + 下一级 score（带小数，§6.6）
// L0 未 gateOk → invalid，totalScore=0 level=0

export function scoreBenchmark(levels: LevelScore[]): {
  totalScore: number;
  level: number;
} {
  const byLevel = new Map<Level, LevelScore>();
  for (const ls of levels) byLevel.set(ls.level, ls);

  const l0 = byLevel.get('L0');
  if (!l0 || !l0.gateOk) {
    return { totalScore: 0, level: 0 };
  }

  // 从 L1 开始按顺序累计，遇到首个未 gateOk 的 level 停止贡献 totalScore，
  // 同时决定 final level 的小数部分（下一级 score）。
  let totalScore = 0;
  let maxPassedIdx = 0; // L0 已 pass → idx 0
  let firstFailed: LevelScore | undefined;

  for (let i = 1; i < LEVEL_ORDER.length; i++) {
    const L = LEVEL_ORDER[i];
    const ls = byLevel.get(L);
    if (!ls) break;
    if (ls.gateOk) {
      totalScore += LEVEL_CONFIG[L].weight * ls.score;
      maxPassedIdx = i;
    } else {
      firstFailed = ls;
      break;
    }
  }

  const decimal = firstFailed ? firstFailed.score : 0;
  const level = maxPassedIdx + decimal;
  return { totalScore, level };
}

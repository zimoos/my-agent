import type { JudgeScore } from './judge-client.js';

// L3 6 维权重（共识设计 §3.4）
// 总和必须 = 1.00
export const L3_WEIGHTS = {
  taskCompletion: 0.25,
  correctness: 0.20,
  completeness: 0.15,
  codeQuality: 0.10,
  efficiency: 0.10,
  noRegression: 0.20,
} as const;

export interface L3ScoreResult {
  total: number;
  passed: boolean;
}

// Pass 门槛（共识设计 §3.4）：
//   total ≥ 0.65
//   AND taskCompletion ≥ 0.5
//   AND correctness ≥ 0.5
//   AND noRegression === 1
export function scoreL3(scores: JudgeScore): L3ScoreResult {
  const total =
    scores.taskCompletion * L3_WEIGHTS.taskCompletion +
    scores.correctness * L3_WEIGHTS.correctness +
    scores.completeness * L3_WEIGHTS.completeness +
    scores.codeQuality * L3_WEIGHTS.codeQuality +
    scores.efficiency * L3_WEIGHTS.efficiency +
    scores.noRegression * L3_WEIGHTS.noRegression;

  const passed =
    total >= 0.65 &&
    scores.taskCompletion >= 0.5 &&
    scores.correctness >= 0.5 &&
    scores.noRegression === 1;

  return { total, passed };
}

// 从 n 个 JudgeScore 每维取中位数，reasoning 拼接
export function medianJudgeScore(runs: JudgeScore[]): JudgeScore {
  if (runs.length === 0) {
    throw new Error('medianJudgeScore: runs 不能为空');
  }
  const pick = (key: keyof Omit<JudgeScore, 'reasoning'>): number =>
    medianOf(runs.map((r) => r[key]));

  return {
    taskCompletion: pick('taskCompletion'),
    correctness: pick('correctness'),
    completeness: pick('completeness'),
    codeQuality: pick('codeQuality'),
    efficiency: pick('efficiency'),
    noRegression: pick('noRegression'),
    reasoning: runs.map((r, i) => `[run${i + 1}] ${r.reasoning}`).join(' | '),
  };
}

function medianOf(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

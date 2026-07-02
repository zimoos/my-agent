import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreBenchmark,
  scoreLevel,
  scoreTask,
  computeMedian,
} from '../scorer.js';
import type {
  HardAssertion,
  HardAssertionResult,
  Level,
  LevelScore,
  RunTrace,
  SoftAssertion,
  SoftResult,
  TaskResult,
  TaskScore,
} from '../types.js';

// ─── Factories ───

function makeTrace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    taskId: 'T-test',
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
    ...overrides,
  };
}

function hr(passed: boolean, reason = ''): HardAssertionResult {
  const assertion: HardAssertion = { type: 'no_error_5xx' };
  return { assertion, passed, reason };
}

function sr(score: number | null, weight: number): SoftResult {
  const assertion: SoftAssertion = { type: 'final_text_min_len', chars: 10, weight };
  return { assertion, score, weight };
}

function taskScore(
  taskId: string,
  hardPass: boolean,
  rawScore: number,
  softScore = 1
): TaskScore {
  return {
    taskId,
    hardPass,
    softScore,
    rawScore,
    hardResults: [hr(hardPass)],
    softResults: [],
    trace: makeTrace({ taskId }),
  };
}

function taskResult(
  taskId: string,
  level: Level,
  median: number,
  passRate: number,
  stability = 1
): TaskResult {
  return {
    taskId,
    level,
    runs: [],
    median,
    stability,
    passRate,
  };
}

// ─── scoreTask ───

test('scoreTask: 全 hard 过 + soft 满分 → rawScore = 1.0', () => {
  const hardResults = [hr(true), hr(true)];
  const softResults = [sr(1, 1), sr(1, 1)];
  const ts = scoreTask(hardResults, softResults, {
    taskId: 'T1',
    trace: makeTrace({ taskId: 'T1' }),
  });
  assert.equal(ts.hardPass, true);
  assert.equal(ts.softScore, 1);
  assert.equal(ts.rawScore, 1.0);
  assert.equal(ts.taskId, 'T1');
});

test('scoreTask: 全 hard 过 + 无 soft 断言 → rawScore = 1.0 (地板 0.6 + 0.4×1)', () => {
  const ts = scoreTask([hr(true)], [], {
    taskId: 'L0-001',
    trace: makeTrace(),
  });
  assert.equal(ts.hardPass, true);
  assert.equal(ts.softScore, 1);
  assert.equal(ts.rawScore, 1.0);
});

test('scoreTask: 单条 hard 失败 → rawScore = 0（无 effort credit）', () => {
  const hardResults = [hr(true), hr(false, 'missing file')];
  const softResults = [sr(1, 1)];
  const ts = scoreTask(hardResults, softResults, {
    taskId: 'T1',
    trace: makeTrace(),
  });
  assert.equal(ts.hardPass, false);
  assert.equal(ts.rawScore, 0);
});

test('scoreTask: hard 过 + soft 部分分 → rawScore = 0.6 + 0.4 × softScore', () => {
  const softResults = [sr(0.5, 1), sr(1.0, 1)]; // 加权平均 = 0.75
  const ts = scoreTask([hr(true)], softResults, {
    taskId: 'T1',
    trace: makeTrace(),
  });
  assert.equal(ts.softScore, 0.75);
  assert.equal(ts.rawScore, 0.6 + 0.4 * 0.75);
});

test('scoreTask: null soft 排除出分母（共识 #6）', () => {
  // 三条 soft：两条 null（未实现的 llm_judge / token_usage_max），一条 0.5
  // 分母只有第三条的 weight
  const softResults = [sr(null, 1), sr(null, 2), sr(0.5, 1)];
  const ts = scoreTask([hr(true)], softResults, {
    taskId: 'T1',
    trace: makeTrace(),
  });
  assert.equal(ts.softScore, 0.5);
  assert.equal(ts.rawScore, 0.6 + 0.4 * 0.5);
});

test('scoreTask: 全 null soft → softScore=1（无负面证据）', () => {
  const softResults = [sr(null, 1), sr(null, 2)];
  const ts = scoreTask([hr(true)], softResults, {
    taskId: 'T1',
    trace: makeTrace(),
  });
  assert.equal(ts.softScore, 1);
  assert.equal(ts.rawScore, 1.0);
});

test('scoreTask: 加权平均按 weight 分配（非均权）', () => {
  // 0.0 权重 3, 1.0 权重 1 → (0×3 + 1×1)/(3+1) = 0.25
  const softResults = [sr(0.0, 3), sr(1.0, 1)];
  const ts = scoreTask([hr(true)], softResults, {
    taskId: 'T1',
    trace: makeTrace(),
  });
  assert.equal(ts.softScore, 0.25);
});

// ─── computeMedian ───

test('computeMedian: 5 runs 奇数取中位', () => {
  const runs = [
    taskScore('T1', true, 0.9),
    taskScore('T1', true, 1.0),
    taskScore('T1', true, 0.7),
    taskScore('T1', true, 0.6),
    taskScore('T1', true, 0.8),
  ];
  const { median, passRate } = computeMedian(runs);
  assert.equal(median, 0.8); // 排序 [0.6,0.7,0.8,0.9,1.0] → 中位 0.8
  assert.equal(passRate, 1);
});

test('computeMedian: 4 runs 偶数取中间两个平均', () => {
  const runs = [
    taskScore('T1', true, 0.4),
    taskScore('T1', true, 0.6),
    taskScore('T1', true, 0.8),
    taskScore('T1', true, 1.0),
  ];
  const { median } = computeMedian(runs);
  assert.equal(median, 0.7); // (0.6+0.8)/2
});

test('computeMedian: passRate = hardPass 次数 / runs.length', () => {
  const runs = [
    taskScore('T1', true, 1.0),
    taskScore('T1', false, 0),
    taskScore('T1', true, 1.0),
    taskScore('T1', false, 0),
    taskScore('T1', true, 1.0),
  ];
  const { passRate, median } = computeMedian(runs);
  assert.equal(passRate, 3 / 5); // 0.6
  assert.equal(median, 1.0); // 排序 [0,0,1,1,1] 中位 1
});

test('computeMedian: 5 runs 分数一致 → stability ≈ 1', () => {
  const runs = [
    taskScore('T1', true, 0.9),
    taskScore('T1', true, 0.9),
    taskScore('T1', true, 0.9),
    taskScore('T1', true, 0.9),
    taskScore('T1', true, 0.9),
  ];
  const { stability } = computeMedian(runs);
  assert.equal(stability, 1);
});

test('computeMedian: 分数抖动大 → stability 明显下降', () => {
  const stable = computeMedian([
    taskScore('T1', true, 0.8),
    taskScore('T1', true, 0.8),
    taskScore('T1', true, 0.8),
  ]);
  const unstable = computeMedian([
    taskScore('T1', true, 0.2),
    taskScore('T1', true, 0.9),
    taskScore('T1', true, 0.5),
  ]);
  assert.ok(Math.abs(stable.stability - 1) < 1e-9, `stable.stability=${stable.stability}`);
  assert.ok(unstable.stability < stable.stability);
  assert.ok(unstable.stability >= 0 && unstable.stability <= 1);
});

test('computeMedian: stability clamp 到 [0,1]（std>1 时不会出负）', () => {
  // 0 和 1 交替，std ≈ 0.5 → stability ≈ 0.5
  const runs = [
    taskScore('T1', true, 0),
    taskScore('T1', false, 1),
    taskScore('T1', true, 0),
    taskScore('T1', false, 1),
  ];
  const { stability } = computeMedian(runs);
  assert.ok(stability >= 0 && stability <= 1);
});

test('computeMedian: 空 runs → 全 0', () => {
  const r = computeMedian([]);
  assert.deepEqual(r, { median: 0, stability: 0, passRate: 0 });
});

test('computeMedian: skipped runs 不计入中位数和通过率', () => {
  const skipped = {
    ...taskScore('T1', true, 1),
    skipped: true,
    skipReason: 'vision unavailable',
  };
  const r = computeMedian([
    skipped,
    taskScore('T1', true, 0.8),
    taskScore('T1', false, 0),
  ]);
  assert.equal(r.median, 0.4);
  assert.equal(r.passRate, 0.5);
});

// ─── scoreLevel ───

test('scoreLevel: L1 双门通过（score≥0.75 且 passRate≥0.9）', () => {
  const tasks = [
    taskResult('L1-001', 'L1', 0.9, 1.0),
    taskResult('L1-002', 'L1', 0.85, 0.95),
    taskResult('L1-003', 'L1', 0.8, 0.9),
  ];
  const ls = scoreLevel(tasks, 'L1');
  assert.ok(ls.score >= 0.75, `score=${ls.score}`);
  assert.ok(ls.passRate >= 0.9, `passRate=${ls.passRate}`);
  assert.equal(ls.gateOk, true);
  assert.equal(ls.level, 'L1');
});

test('scoreLevel: score 不足 → 门失败', () => {
  const tasks = [
    taskResult('L1-001', 'L1', 0.5, 1.0),
    taskResult('L1-002', 'L1', 0.6, 1.0),
  ];
  const ls = scoreLevel(tasks, 'L1');
  assert.ok(ls.score < 0.75);
  assert.equal(ls.gateOk, false);
});

test('scoreLevel: passRate 不足 → 门失败（即便 score 够）', () => {
  // 所有过的任务都 1.0，但通过率 50% → passRate 0.5 < 0.9
  const tasks = [
    taskResult('L1-001', 'L1', 1.0, 1.0),
    taskResult('L1-002', 'L1', 1.0, 0), // 这个没过
  ];
  const ls = scoreLevel(tasks, 'L1');
  assert.equal(ls.score, 1.0); // 简单平均
  assert.equal(ls.passRate, 0.5);
  assert.equal(ls.gateOk, false);
});

test('scoreLevel: taskWeights 加权（共识 #9）', () => {
  // 高权重任务拉低整体
  const tasks = [
    taskResult('big', 'L2', 0.3, 0.3), // weight 10
    taskResult('small', 'L2', 1.0, 1.0), // weight 1
  ];
  const weights = { big: 10, small: 1 };
  const ls = scoreLevel(tasks, 'L2', weights);
  // score = (10×0.3 + 1×1.0)/(10+1) = 4.0/11 ≈ 0.3636
  assert.ok(Math.abs(ls.score - 4.0 / 11) < 1e-9);
  // passRate = (10×0.3 + 1×1.0)/11 = 同上
  assert.ok(Math.abs(ls.passRate - 4.0 / 11) < 1e-9);
  assert.equal(ls.gateOk, false); // L2 门 0.65 / 0.8
});

test('scoreLevel: L0 门（100% cutoff + 100% passRate）', () => {
  const tasks = [
    taskResult('L0-001', 'L0', 1.0, 1.0),
    taskResult('L0-002', 'L0', 1.0, 1.0),
  ];
  const ls = scoreLevel(tasks, 'L0');
  assert.equal(ls.gateOk, true);

  const tasksFail = [
    taskResult('L0-001', 'L0', 1.0, 1.0),
    taskResult('L0-002', 'L0', 0.9, 0.9), // 只要有一个不到 1.0 就挂
  ];
  const lsFail = scoreLevel(tasksFail, 'L0');
  assert.equal(lsFail.gateOk, false);
});

test('scoreLevel: 空 tasks → score 0 门失败', () => {
  const ls = scoreLevel([], 'L1');
  assert.equal(ls.score, 0);
  assert.equal(ls.passRate, 0);
  assert.equal(ls.gateOk, false);
});

test('scoreLevel: skipped tasks 不参与 gate 统计', () => {
  const tasks = [
    taskResult('active', 'L1', 0.9, 1.0),
    {
      ...taskResult('skipped', 'L1', 1.0, 1.0),
      skipped: true,
      skipReason: 'vision unavailable',
    },
  ];
  const ls = scoreLevel(tasks, 'L1', { active: 1, skipped: 100 });
  assert.equal(ls.score, 0.9);
  assert.equal(ls.passRate, 1);
  assert.equal(ls.gateOk, true);
  assert.equal(ls.tasks.length, 2);
});

test('scoreLevel: 全部 skipped 时 gate 失败但保留任务报告', () => {
  const tasks = [
    {
      ...taskResult('skipped', 'L2', 1.0, 1.0),
      skipped: true,
      skipReason: 'vision unavailable',
    },
  ];
  const ls = scoreLevel(tasks, 'L2');
  assert.equal(ls.score, 0);
  assert.equal(ls.passRate, 0);
  assert.equal(ls.gateOk, false);
  assert.equal(ls.tasks.length, 1);
});

// ─── scoreBenchmark ───

function levelScore(
  level: Level,
  score: number,
  passRate: number,
  gateOk: boolean
): LevelScore {
  return { level, score, passRate, gateOk, tasks: [] };
}

test('scoreBenchmark: L0 未 gateOk → invalid（totalScore=0 level=0）', () => {
  const levels: LevelScore[] = [
    levelScore('L0', 0.9, 0.9, false),
    levelScore('L1', 1.0, 1.0, true),
    levelScore('L2', 1.0, 1.0, true),
  ];
  const r = scoreBenchmark(levels);
  assert.equal(r.totalScore, 0);
  assert.equal(r.level, 0);
});

test('scoreBenchmark: L0→L2 全过，L3 卡住 → totalScore = α1×s1 + α2×s2，level = 2 + L3.score', () => {
  const levels: LevelScore[] = [
    levelScore('L0', 1.0, 1.0, true),
    levelScore('L1', 0.9, 0.95, true),
    levelScore('L2', 0.8, 0.85, true),
    levelScore('L3', 0.4, 0.5, false), // 未过
    levelScore('L4', 0.9, 0.9, true), // 跳级不计入（L3 挂了）
  ];
  const r = scoreBenchmark(levels);
  // α1=15, α2=20 → 15×0.9 + 20×0.8 = 13.5 + 16 = 29.5
  assert.ok(Math.abs(r.totalScore - 29.5) < 1e-9);
  // level = 2 + L3.score(0.4) = 2.4
  assert.ok(Math.abs(r.level - 2.4) < 1e-9);
});

test('scoreBenchmark: 跳级阻断 —— L2 失败后 L3 分数不计入', () => {
  const levels: LevelScore[] = [
    levelScore('L0', 1.0, 1.0, true),
    levelScore('L1', 0.9, 0.95, true),
    levelScore('L2', 0.5, 0.5, false), // 卡在这
    levelScore('L3', 1.0, 1.0, true), // 即使满分也不算
    levelScore('L4', 1.0, 1.0, true),
  ];
  const r = scoreBenchmark(levels);
  // 只算 L1：15×0.9 = 13.5
  assert.ok(Math.abs(r.totalScore - 13.5) < 1e-9);
  assert.ok(Math.abs(r.level - (1 + 0.5)) < 1e-9); // 1 + L2.score
});

test('scoreBenchmark: 全 L0-L5 过 → 满分累加，level 无下一级 → 小数 = 0', () => {
  const levels: LevelScore[] = [
    levelScore('L0', 1.0, 1.0, true),
    levelScore('L1', 1.0, 1.0, true),
    levelScore('L2', 1.0, 1.0, true),
    levelScore('L3', 1.0, 1.0, true),
    levelScore('L4', 1.0, 1.0, true),
    levelScore('L5', 1.0, 1.0, true),
  ];
  const r = scoreBenchmark(levels);
  // 15 + 20 + 25 + 25 + 15 = 100
  assert.equal(r.totalScore, 100);
  assert.equal(r.level, 5);
});

test('scoreBenchmark: 只有 L0（M1 起步）→ level = 0 + L1.score（若存在）或 0', () => {
  const levels: LevelScore[] = [levelScore('L0', 1.0, 1.0, true)];
  const r = scoreBenchmark(levels);
  assert.equal(r.totalScore, 0); // 还没 L1+ 贡献
  assert.equal(r.level, 0); // 没下一级数据 → 小数 0
});

test('scoreBenchmark: L0 过 + L1 缺失 → 停在 L0，level=0', () => {
  const levels: LevelScore[] = [
    levelScore('L0', 1.0, 1.0, true),
    // L1 未提供（M1 中实际会有，但测试覆盖缺失场景）
  ];
  const r = scoreBenchmark(levels);
  assert.equal(r.totalScore, 0);
  assert.equal(r.level, 0);
});

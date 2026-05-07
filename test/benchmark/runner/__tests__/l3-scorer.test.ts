import { test } from 'node:test';
import assert from 'node:assert/strict';
import { L3_WEIGHTS, medianJudgeScore, scoreL3 } from '../l3-scorer.js';
import type { JudgeScore } from '../judge-client.js';

function s(overrides: Partial<JudgeScore> = {}): JudgeScore {
  return {
    taskCompletion: 1,
    correctness: 1,
    completeness: 1,
    codeQuality: 1,
    efficiency: 1,
    noRegression: 1,
    reasoning: '',
    ...overrides,
  };
}

// ─── L3_WEIGHTS 总和 = 1.00 ───

test('L3_WEIGHTS sums to 1.00', () => {
  const sum =
    L3_WEIGHTS.taskCompletion +
    L3_WEIGHTS.correctness +
    L3_WEIGHTS.completeness +
    L3_WEIGHTS.codeQuality +
    L3_WEIGHTS.efficiency +
    L3_WEIGHTS.noRegression;
  // 浮点容差
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `weights sum=${sum}`);
});

// ─── total 计算 ───

test('scoreL3 all-1 score: total=1, passed=true', () => {
  const r = scoreL3(s());
  assert.equal(r.total, 1);
  assert.equal(r.passed, true);
});

test('scoreL3 all-0 score: total=0, passed=false', () => {
  const r = scoreL3(s({
    taskCompletion: 0,
    correctness: 0,
    completeness: 0,
    codeQuality: 0,
    efficiency: 0,
    noRegression: 0,
  }));
  assert.equal(r.total, 0);
  assert.equal(r.passed, false);
});

test('scoreL3 weighted sum is correct', () => {
  const r = scoreL3(s({
    taskCompletion: 0.5,  // 0.5 * 0.25 = 0.125
    correctness: 0.5,     // 0.5 * 0.20 = 0.10
    completeness: 0.5,    // 0.5 * 0.15 = 0.075
    codeQuality: 0.5,     // 0.5 * 0.10 = 0.05
    efficiency: 0.5,      // 0.5 * 0.10 = 0.05
    noRegression: 1,      // 1 * 0.20 = 0.20
  }));
  // total = 0.125 + 0.10 + 0.075 + 0.05 + 0.05 + 0.20 = 0.60
  assert.ok(Math.abs(r.total - 0.6) < 1e-9, `total=${r.total}`);
  // total<0.65 → fail
  assert.equal(r.passed, false);
});

// ─── pass 门槛 ───

test('scoreL3 pass: total=0.65, all gates met', () => {
  // 需要构造一组刚好 total>=0.65 且三个门槛都过的分
  const score = s({
    taskCompletion: 0.5,
    correctness: 0.5,
    completeness: 1,
    codeQuality: 1,
    efficiency: 1,
    noRegression: 1,
  });
  // total = 0.5*0.25 + 0.5*0.20 + 1*0.15 + 1*0.10 + 1*0.10 + 1*0.20
  //       = 0.125 + 0.10 + 0.15 + 0.10 + 0.10 + 0.20 = 0.775
  const r = scoreL3(score);
  assert.ok(r.total >= 0.65);
  assert.equal(r.passed, true);
});

test('scoreL3 fail when taskCompletion < 0.5', () => {
  const r = scoreL3(s({ taskCompletion: 0.4 }));
  // total ≈ 0.4*0.25 + 0.20 + 0.15 + 0.10 + 0.10 + 0.20 = 0.85 ≥ 0.65
  assert.ok(r.total >= 0.65);
  assert.equal(r.passed, false);
});

test('scoreL3 fail when correctness < 0.5', () => {
  const r = scoreL3(s({ correctness: 0.49 }));
  assert.equal(r.passed, false);
});

test('scoreL3 fail when noRegression !== 1 (even 0.9)', () => {
  const r = scoreL3(s({ noRegression: 0.9 }));
  // noRegression 硬门槛 === 1
  assert.equal(r.passed, false);
});

test('scoreL3 fail when total < 0.65 even if gates pass', () => {
  const score = s({
    taskCompletion: 0.5,
    correctness: 0.5,
    completeness: 0,
    codeQuality: 0,
    efficiency: 0,
    noRegression: 1,
  });
  // total = 0.5*0.25 + 0.5*0.20 + 0 + 0 + 0 + 0.20 = 0.425
  const r = scoreL3(score);
  assert.ok(r.total < 0.65);
  assert.equal(r.passed, false);
});

test('scoreL3 boundary: taskCompletion exactly 0.5', () => {
  const score = s({ taskCompletion: 0.5 });
  const r = scoreL3(score);
  assert.equal(r.passed, true);
});

// ─── medianJudgeScore ───

test('medianJudgeScore picks per-dim median', () => {
  const r = medianJudgeScore([
    s({ taskCompletion: 0.2, correctness: 0.3 }),
    s({ taskCompletion: 0.5, correctness: 0.6 }),
    s({ taskCompletion: 0.9, correctness: 0.9 }),
  ]);
  assert.equal(r.taskCompletion, 0.5);
  assert.equal(r.correctness, 0.6);
  // 其他维度 3 个 1 → median 1
  assert.equal(r.noRegression, 1);
});

test('medianJudgeScore handles even count via avg of two middle', () => {
  const r = medianJudgeScore([
    s({ taskCompletion: 0.2 }),
    s({ taskCompletion: 0.4 }),
    s({ taskCompletion: 0.6 }),
    s({ taskCompletion: 0.8 }),
  ]);
  // median of [0.2, 0.4, 0.6, 0.8] = (0.4 + 0.6) / 2 = 0.5
  assert.ok(Math.abs(r.taskCompletion - 0.5) < 1e-9);
});

test('medianJudgeScore throws on empty', () => {
  assert.throws(() => medianJudgeScore([]), /不能为空/);
});

test('medianJudgeScore concatenates reasoning', () => {
  const r = medianJudgeScore([
    s({ reasoning: 'a' }),
    s({ reasoning: 'b' }),
    s({ reasoning: 'c' }),
  ]);
  assert.ok(r.reasoning.includes('[run1] a'));
  assert.ok(r.reasoning.includes('[run3] c'));
});

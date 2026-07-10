import { test } from 'node:test';
import assert from 'node:assert/strict';

import { l3ResultToTaskResult } from '../index.js';
import type { JudgeScore } from '../judge-client.js';
import type { L3RunDetail, L3TaskResult } from '../l3-task-runner.js';
import { scoreLevel } from '../scorer.js';

const PASSING_JUDGE_SCORE: JudgeScore = {
  taskCompletion: 1,
  correctness: 1,
  completeness: 1,
  codeQuality: 1,
  efficiency: 1,
  noRegression: 1,
  reasoning: 'judge pass',
};

function makeDetail(hardGateFailures: string[]): L3RunDetail {
  return {
    runIndex: 0,
    score: PASSING_JUDGE_SCORE,
    adapter: { exitCode: 0, timedOut: false, elapsedMs: 1 },
    workspaceDiffSummary: '',
    objectiveChecks: [],
    hardGateFailures,
  };
}

function makeResult(
  passed: boolean,
  hardGateFailures: string[],
): L3TaskResult {
  return {
    taskId: 'L3-015',
    runs: [PASSING_JUDGE_SCORE],
    median: PASSING_JUDGE_SCORE,
    passed,
    total: 1,
    details: [makeDetail(hardGateFailures)],
  };
}

test('L3 result conversion keeps hard gates authoritative over a passing judge', () => {
  const cases = [
    {
      name: 'run detail has a hard-gate failure',
      result: makeResult(false, ['browser verification failed: collision']),
    },
    {
      name: 'aggregate L3 result is not passed',
      result: makeResult(false, []),
    },
  ];

  for (const { name, result } of cases) {
    const taskResult = l3ResultToTaskResult(result);
    assert.equal(taskResult.runs[0]?.hardPass, false, name);
    assert.equal(taskResult.runs[0]?.rawScore, 0, name);
    assert.equal(taskResult.passRate, 0, name);

    const levelResult = scoreLevel([taskResult], 'L3', { 'L3-015': 1 });
    assert.equal(levelResult.passRate, 0, name);
    assert.equal(levelResult.gateOk, false, name);
  }
});

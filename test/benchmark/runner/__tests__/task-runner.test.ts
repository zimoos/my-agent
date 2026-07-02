import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTask } from '../task-runner.js';
import type { TaskDef } from '../types.js';

function skippedVisionTask(): TaskDef {
  return {
    id: 'L2-999',
    title: 'vision skip',
    level: 'L2',
    category: 'vision',
    weight: 1,
    userInput: 'describe image',
    attachments: [{ type: 'image', path: 'missing.png' }],
    requires: ['vision'],
    hardAssertions: [{ type: 'final_text_min_chars', chars: 1 }],
    softAssertions: [],
    runtime: { timeoutSec: 1, runs: 3, maxRounds: null, layer: 'L2' },
    sourcePath: 'inline',
  };
}

test('runTask: unmet vision requirement is skipped before fixture/bootstrap', async () => {
  const old = process.env.MA_BENCH_VISION;
  delete process.env.MA_BENCH_VISION;
  try {
    const result = await runTask(skippedVisionTask());
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? '', /vision/);
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].skipped, true);
    assert.equal(result.median, 1);
  } finally {
    if (old === undefined) delete process.env.MA_BENCH_VISION;
    else process.env.MA_BENCH_VISION = old;
  }
});

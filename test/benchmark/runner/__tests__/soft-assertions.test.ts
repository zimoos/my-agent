import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSoft, evaluateSoftWithJudge } from '../assertions/soft.js';
import type {
  HardAssertionResult,
  RunTrace,
  SoftAssertion,
  TaskDef,
  ToolCallRecord,
} from '../types.js';
import type { JudgeInput, JudgeScore } from '../judge-client.js';

function makeTrace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    taskId: 't1',
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

function makeToolCall(name = 'readFile'): ToolCallRecord {
  return { name, args: {}, ok: true, resultPreview: '' };
}

function makeTask(overrides: Partial<TaskDef> = {}): TaskDef {
  return {
    id: 'L2-test',
    title: '多轮质量测试',
    level: 'L2',
    category: 'context',
    weight: 1,
    rounds: [
      { user: '第一轮：项目叫 alpha', judgeRubric: ['应保留项目名 alpha'] },
      { user: '最后回忆项目名' },
    ],
    behaviorExpectations: ['信息不足时必须先提问'],
    judgeRubric: ['最终回答必须遵守最新约束'],
    hardAssertions: [],
    softAssertions: [],
    runtime: { timeoutSec: 60, runs: 1, maxRounds: null, layer: 'L2' },
    sourcePath: 'inline',
    ...overrides,
  };
}

function passingHard(): HardAssertionResult[] {
  return [
    {
      assertion: { type: 'final_text_contains', contains: 'alpha' },
      passed: true,
      reason: 'found',
    },
  ];
}

// ─── final_text_min_len ───

test('final_text_min_len: 恰好达到阈值 score = 1', () => {
  const trace = makeTrace({ finalText: 'x'.repeat(100) });
  const assertions: SoftAssertion[] = [{ type: 'final_text_min_len', chars: 100, weight: 1 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, 1);
  assert.equal(r.weight, 1);
});

test('final_text_min_len: 一半长度 score = 0.5', () => {
  const trace = makeTrace({ finalText: 'x'.repeat(50) });
  const assertions: SoftAssertion[] = [{ type: 'final_text_min_len', chars: 100, weight: 2 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, 0.5);
  assert.equal(r.weight, 2);
});

test('final_text_min_len: 超过阈值 score 封顶 1', () => {
  const trace = makeTrace({ finalText: 'x'.repeat(300) });
  const assertions: SoftAssertion[] = [{ type: 'final_text_min_len', chars: 100, weight: 1 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, 1);
});

// ─── tool_call_count_max ───

test('tool_call_count_max: 调用数 = max score = 1', () => {
  const trace = makeTrace({ toolCalls: [makeToolCall(), makeToolCall(), makeToolCall()] });
  const assertions: SoftAssertion[] = [{ type: 'tool_call_count_max', max: 3, weight: 1 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, 1);
});

test('tool_call_count_max: 调用数是 max 两倍 score = 0.5', () => {
  const trace = makeTrace({ toolCalls: Array.from({ length: 10 }, () => makeToolCall()) });
  const assertions: SoftAssertion[] = [{ type: 'tool_call_count_max', max: 5, weight: 1 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, 0.5);
});

test('tool_call_count_max: 零调用且 max>0 score = 1', () => {
  const trace = makeTrace({ toolCalls: [] });
  const assertions: SoftAssertion[] = [{ type: 'tool_call_count_max', max: 2, weight: 1 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, 1);
});

test('tool_call_count_max: 零调用且 max=0 score = 1', () => {
  const trace = makeTrace({ toolCalls: [] });
  const assertions: SoftAssertion[] = [{ type: 'tool_call_count_max', max: 0, weight: 1 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, 1);
});

test('tool_call_count_max: 有调用但 max=0 score = 0', () => {
  const trace = makeTrace({ toolCalls: [makeToolCall()] });
  const assertions: SoftAssertion[] = [{ type: 'tool_call_count_max', max: 0, weight: 1 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, 0);
});

// ─── duration_max ───

test('duration_max: 耗时 = ms score = 1', () => {
  const trace = makeTrace({ elapsedMs: 1000 });
  const assertions: SoftAssertion[] = [{ type: 'duration_max', ms: 1000, weight: 1 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, 1);
});

test('duration_max: 耗时是 ms 两倍 score = 0.5', () => {
  const trace = makeTrace({ elapsedMs: 2000 });
  const assertions: SoftAssertion[] = [{ type: 'duration_max', ms: 1000, weight: 1 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, 0.5);
});

test('duration_max: 比 ms 更快 score 封顶 1', () => {
  const trace = makeTrace({ elapsedMs: 500 });
  const assertions: SoftAssertion[] = [{ type: 'duration_max', ms: 2000, weight: 1 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, 1);
});

// ─── 未实现类型返回 null ───

test('llm_judge: M1 未实现 score = null', () => {
  const trace = makeTrace({ finalText: 'whatever' });
  const assertions: SoftAssertion[] = [{ type: 'llm_judge', rubric: 'any', weight: 3 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, null);
  assert.equal(r.weight, 3);
});

test('evaluateSoftWithJudge: llm_judge 接入裁判后返回非空分并包含多轮 rubric', async () => {
  const trace = makeTrace({ finalText: 'alpha', elapsedMs: 100 });
  const assertions: SoftAssertion[] = [
    { type: 'final_text_min_len', chars: 5, weight: 1 },
    { type: 'llm_judge', rubric: '必须正确回忆项目名', weight: 2 },
  ];
  let seenInput: JudgeInput | undefined;
  const stubJudge = async (input: JudgeInput): Promise<JudgeScore> => {
    seenInput = input;
    return {
      taskCompletion: 0.8,
      correctness: 0.9,
      completeness: 0.7,
      codeQuality: 0.6,
      efficiency: 1,
      noRegression: 1,
      reasoning: '保留了关键上下文',
    };
  };

  const results = await evaluateSoftWithJudge(
    assertions,
    trace,
    makeTask(),
    passingHard(),
    { model: 'judge', apiKey: 'test' },
    stubJudge
  );

  assert.equal(results[0].score, 1);
  assert.ok(Math.abs((results[1].score ?? 0) - 0.845) < 1e-9);
  assert.equal(results[1].reason, '保留了关键上下文');
  assert.ok(seenInput);
  assert.match(seenInput.prompt, /Round 0/);
  assert.match(seenInput.prompt, /alpha/);
  assert.deepEqual(seenInput.rubricPoints, [
    '必须正确回忆项目名',
    '最终回答必须遵守最新约束',
    '行为要求：信息不足时必须先提问',
    'Round 0: 应保留项目名 alpha',
  ]);
  assert.equal(seenInput.objectiveChecks[0].exitCode, 0);
});

test('evaluateSoftWithJudge: judge 失败时该项计 0 并保留原因', async () => {
  const trace = makeTrace({ finalText: 'whatever' });
  const assertions: SoftAssertion[] = [{ type: 'llm_judge', rubric: 'any', weight: 3 }];
  const results = await evaluateSoftWithJudge(
    assertions,
    trace,
    makeTask(),
    [],
    { model: 'judge', apiKey: 'test' },
    async () => {
      throw new Error('judge down');
    }
  );

  assert.equal(results[0].score, 0);
  assert.match(results[0].reason ?? '', /judge down/);
});

test('reference_match_ratio: M1 未实现 score = null', () => {
  const trace = makeTrace();
  const assertions: SoftAssertion[] = [{ type: 'reference_match_ratio', ref: 'x', weight: 2 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, null);
  assert.equal(r.weight, 2);
});

test('token_usage_max: M1 未实现 score = null', () => {
  const trace = makeTrace();
  const assertions: SoftAssertion[] = [{ type: 'token_usage_max', max: 1000, weight: 1 }];
  const [r] = evaluateSoft(assertions, trace);
  assert.equal(r.score, null);
  assert.equal(r.weight, 1);
});

// ─── 混合场景 ───

test('混合断言: 按顺序返回各自结果', () => {
  const trace = makeTrace({
    finalText: 'x'.repeat(80),
    toolCalls: [makeToolCall(), makeToolCall()],
    elapsedMs: 1000,
  });
  const assertions: SoftAssertion[] = [
    { type: 'final_text_min_len', chars: 100, weight: 1 },
    { type: 'tool_call_count_max', max: 4, weight: 1 },
    { type: 'duration_max', ms: 500, weight: 1 },
    { type: 'llm_judge', rubric: 'skip', weight: 1 },
  ];
  const results = evaluateSoft(assertions, trace);
  assert.equal(results.length, 4);
  assert.equal(results[0].score, 0.8);
  assert.equal(results[1].score, 1);
  assert.equal(results[2].score, 0.5);
  assert.equal(results[3].score, null);
});

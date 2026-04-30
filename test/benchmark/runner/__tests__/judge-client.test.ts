import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  judge,
  buildJudgePrompt,
  parseScore,
  applyPostCheckCap,
  selectJudgeModel,
  type JudgeConfig,
  type JudgeInput,
  type JudgeScore,
} from '../judge-client.js';

// ─── Factories ───

function makeInput(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    taskDescription: '修 parseConfig 对空串崩溃',
    prompt: '请修复 src/parseConfig.js 对空字符串输入抛错的问题，并补测试。',
    rubricPoints: [
      '空字符串不抛错',
      '空对象返回兜底值',
      '原有非空用例不回归',
    ],
    referenceSolution: 'diff --git a/src/parseConfig.js b/src/parseConfig.js\n...',
    workspaceDiff: 'diff --git a/src/parseConfig.js b/src/parseConfig.js\n+ if (!s) return {};',
    finalAnswer: '我已经在空串分支直接返回空对象，并加了测试。',
    objectiveChecks: [
      { command: 'npm test', exitCode: 0, stdout: '3 passing', weightInto: 'NoRegression' },
    ],
    runtimeStats: { elapsedMs: 340_000, exitCode: 0 },
    ...overrides,
  };
}

function makeConfig(
  creator: (args: unknown) => Promise<unknown>,
  overrides: Partial<JudgeConfig> = {},
): JudgeConfig {
  return {
    model: 'claude-sonnet-4-6',
    apiKey: 'sk-test',
    temperature: 0,
    openaiClient: {
      // 模拟 OpenAI 客户端形状，只实现 chat.completions.create
      chat: {
        completions: { create: creator as any },
      } as any,
    } as any,
    ...overrides,
  };
}

function makeResponse(content: string): unknown {
  return {
    choices: [{ message: { content } }],
  };
}

function validScoreJson(over: Partial<JudgeScore> = {}): string {
  const base: JudgeScore = {
    taskCompletion: 0.9,
    correctness: 0.8,
    completeness: 0.7,
    codeQuality: 0.85,
    efficiency: 0.6,
    noRegression: 1,
    reasoning: '整体完成良好，测试齐全。',
  };
  return JSON.stringify({ ...base, ...over });
}

// ─── selectJudgeModel ───

test('selectJudgeModel: claude-* 被测 → gpt-4o 裁判', () => {
  assert.equal(selectJudgeModel('claude-sonnet-4-6'), 'gpt-4o');
  assert.equal(selectJudgeModel('claude-opus-4-7'), 'gpt-4o');
});

test('selectJudgeModel: 非 claude 系 → claude-sonnet-4-6 裁判', () => {
  assert.equal(selectJudgeModel('qwen3-30b'), 'claude-sonnet-4-6');
  assert.equal(selectJudgeModel('gpt-4o'), 'claude-sonnet-4-6');
  assert.equal(selectJudgeModel(''), 'claude-sonnet-4-6');
});

// ─── parseScore ───

test('parseScore: 纯 JSON 字符串解析为 6 维分数', () => {
  const s = parseScore(validScoreJson());
  assert.equal(s.taskCompletion, 0.9);
  assert.equal(s.correctness, 0.8);
  assert.equal(s.noRegression, 1);
  assert.equal(s.reasoning, '整体完成良好，测试齐全。');
});

test('parseScore: 带 ```json 包裹也能抽出', () => {
  const wrapped = '这是我的评分：\n```json\n' + validScoreJson() + '\n```\n完毕。';
  const s = parseScore(wrapped);
  assert.equal(s.taskCompletion, 0.9);
});

test('parseScore: 分数越界会被 clamp 到 [0,1]', () => {
  const s = parseScore(validScoreJson({ taskCompletion: 1.5, efficiency: -0.2 } as any));
  assert.equal(s.taskCompletion, 1);
  assert.equal(s.efficiency, 0);
});

test('parseScore: 缺少维度字段抛错', () => {
  const bad = JSON.stringify({
    taskCompletion: 0.5,
    correctness: 0.5,
    completeness: 0.5,
    codeQuality: 0.5,
    efficiency: 0.5,
    // noRegression 缺失
    reasoning: 'x',
  });
  assert.throws(() => parseScore(bad), /noRegression/);
});

test('parseScore: 完全不是 JSON 抛错', () => {
  assert.throws(() => parseScore('这不是 json'), /JSON/);
});

// ─── applyPostCheckCap ───

test('applyPostCheckCap: 所有 check exit=0 时不改分数', () => {
  const score: JudgeScore = JSON.parse(validScoreJson());
  const capped = applyPostCheckCap(score, [
    { command: 'a', exitCode: 0, stdout: '', weightInto: 'Correctness' },
    { command: 'b', exitCode: 0, stdout: '', weightInto: 'NoRegression' },
  ]);
  assert.equal(capped.correctness, score.correctness);
});

test('applyPostCheckCap: 任一 check exitCode!=0 → correctness 上限 0.5', () => {
  const score: JudgeScore = JSON.parse(validScoreJson({ correctness: 0.9 } as any));
  const capped = applyPostCheckCap(score, [
    { command: 'ok', exitCode: 0, stdout: '', weightInto: 'NoRegression' },
    { command: 'fail', exitCode: 2, stdout: 'err', weightInto: 'Correctness' },
  ]);
  assert.equal(capped.correctness, 0.5);
  // 其他维度不变
  assert.equal(capped.taskCompletion, score.taskCompletion);
  assert.equal(capped.noRegression, score.noRegression);
});

test('applyPostCheckCap: 原 correctness 本就 ≤ 0.5 则保持原值', () => {
  const score: JudgeScore = JSON.parse(validScoreJson({ correctness: 0.3 } as any));
  const capped = applyPostCheckCap(score, [
    { command: 'fail', exitCode: 1, stdout: '', weightInto: 'Correctness' },
  ]);
  assert.equal(capped.correctness, 0.3);
});

// ─── buildJudgePrompt ───

test('buildJudgePrompt: 包含 rubric / diff / 最终回复 / 客观检查 / 运行统计', () => {
  const input = makeInput();
  const p = buildJudgePrompt(input);
  assert.match(p, /空字符串不抛错/);
  assert.match(p, /parseConfig/);
  assert.match(p, /我已经在空串分支/);
  assert.match(p, /NoRegression/);
  assert.match(p, /elapsedMs: 340000/);
  assert.match(p, /评分要点/);
  assert.match(p, /严格 JSON/);
});

test('buildJudgePrompt: 无 referenceSolution 时不渲染参考解区块', () => {
  const input = makeInput({ referenceSolution: undefined });
  const p = buildJudgePrompt(input);
  assert.doesNotMatch(p, /参考解法之一/);
});

// ─── judge() 集成：mock OpenAI ───

test('judge: 首次返回合法 JSON → 直接解析成 JudgeScore', async () => {
  let calls = 0;
  const config = makeConfig(async () => {
    calls++;
    return makeResponse(validScoreJson());
  });
  const score = await judge(makeInput(), config);
  assert.equal(calls, 1);
  assert.equal(score.taskCompletion, 0.9);
  assert.equal(score.noRegression, 1);
});

test('judge: 首次无效 JSON → 重试 1 次后成功', async () => {
  const replies = ['抱歉，不是 JSON 格式', validScoreJson()];
  let calls = 0;
  const config = makeConfig(async () => {
    const content = replies[calls] ?? '';
    calls++;
    return makeResponse(content);
  });
  const score = await judge(makeInput(), config);
  assert.equal(calls, 2);
  assert.equal(score.taskCompletion, 0.9);
});

test('judge: 连续 2 次无效 JSON → 抛错', async () => {
  let calls = 0;
  const config = makeConfig(async () => {
    calls++;
    return makeResponse('还是不是 JSON');
  });
  await assert.rejects(
    () => judge(makeInput(), config),
    /连续 2 次解析失败/,
  );
  assert.equal(calls, 2);
});

test('judge: 返回 JSON + 存在客观检查失败 → correctness 被 cap 到 0.5', async () => {
  const config = makeConfig(async () =>
    makeResponse(validScoreJson({ correctness: 0.95 } as any)),
  );
  const input = makeInput({
    objectiveChecks: [
      { command: 'npm test', exitCode: 1, stdout: 'failed', weightInto: 'Correctness' },
    ],
  });
  const score = await judge(input, config);
  assert.equal(score.correctness, 0.5);
  // 其他维度保持模型原输出
  assert.equal(score.taskCompletion, 0.9);
});

test('judge: 透传 model/temperature 到底层 chat.completions.create', async () => {
  const seen: { model?: string; temperature?: number } = {};
  const config = makeConfig(async (args: unknown) => {
    const a = args as { model: string; temperature: number };
    seen.model = a.model;
    seen.temperature = a.temperature;
    return makeResponse(validScoreJson());
  }, { model: 'gpt-4o', temperature: 0 });
  await judge(makeInput(), config);
  assert.equal(seen.model, 'gpt-4o');
  assert.equal(seen.temperature, 0);
});

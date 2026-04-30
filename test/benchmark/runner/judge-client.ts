import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// ─── Types (per W1 task brief) ───

export interface JudgeInput {
  taskDescription: string;
  prompt: string;
  rubricPoints: string[];
  referenceSolution?: string;
  workspaceDiff: string;
  finalAnswer: string;
  objectiveChecks: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    weightInto: string;
  }>;
  runtimeStats: {
    elapsedMs: number;
    exitCode: number;
  };
}

export interface JudgeScore {
  taskCompletion: number;
  correctness: number;
  completeness: number;
  codeQuality: number;
  efficiency: number;
  noRegression: number;
  reasoning: string;
}

export interface JudgeConfig {
  model: string;
  apiKey: string;
  baseURL?: string;
  temperature?: number;
  // 测试/依赖注入用：允许替换底层 OpenAI 客户端
  openaiClient?: Pick<OpenAI, 'chat'>;
}

// ─── Constants ───

const DIMENSIONS = [
  'taskCompletion',
  'correctness',
  'completeness',
  'codeQuality',
  'efficiency',
  'noRegression',
] as const;

type Dim = typeof DIMENSIONS[number];

const SYSTEM_INSTRUCTION = `你是严格的资深 code reviewer，对一份 agent 提交按 6 维各打 0 到 1 的连续分。\n只看外部可观察物（diff / 最终回复 / 客观检查结果），不猜内部过程。\n只输出一个严格 JSON 对象，不要 markdown 包裹，不要多余文本。`;

// 异源切换：claude-* 被测 → GPT-4o 裁判；其他 → Claude Sonnet 4.6
const GPT_JUDGE_MODEL = 'gpt-4o';
const CLAUDE_JUDGE_MODEL = 'claude-sonnet-4-6';

// ─── Pure helpers (exported for unit tests) ───

export function selectJudgeModel(underlyingModel: string): string {
  if (typeof underlyingModel === 'string' && underlyingModel.startsWith('claude-')) {
    return GPT_JUDGE_MODEL;
  }
  return CLAUDE_JUDGE_MODEL;
}

export function buildJudgePrompt(input: JudgeInput): string {
  const rubric = input.rubricPoints.length
    ? input.rubricPoints.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
    : '  （未提供 rubric）';

  const ref = input.referenceSolution
    ? `\n## 参考解法之一（仅供对比，不是唯一正解）\n\`\`\`\n${input.referenceSolution}\n\`\`\`\n`
    : '';

  const checks = input.objectiveChecks.length
    ? input.objectiveChecks
        .map((c) => {
          const stdoutTail = (c.stdout ?? '').slice(-400);
          return `- [${c.weightInto}] exit=${c.exitCode} cmd=${c.command}\n  stdout(tail): ${stdoutTail}`;
        })
        .join('\n')
    : '  （无客观检查）';

  return [
    `## 任务描述`,
    input.taskDescription,
    ``,
    `## 用户 Prompt`,
    input.prompt,
    ``,
    `## 评分要点 (rubric)`,
    rubric,
    ref,
    `## 被测提交：工作区 diff`,
    '```diff',
    input.workspaceDiff || '（空 diff）',
    '```',
    ``,
    `## 被测提交：最终回复`,
    input.finalAnswer || '（空）',
    ``,
    `## 客观检查结果（按绑定维度分组）`,
    checks,
    ``,
    `## 运行统计`,
    `- elapsedMs: ${input.runtimeStats.elapsedMs}`,
    `- exitCode: ${input.runtimeStats.exitCode}`,
    ``,
    `## 评分规则（每维 0-1 连续分）`,
    `- taskCompletion: rubric 要求点覆盖宽度（做到了几条）`,
    `- correctness: 已做部分的正确性（post_check 失败会被外部 cap 到 0.5）`,
    `- completeness: 代码 + 测试 + 必要文档是否齐`,
    `- codeQuality: 是否融入项目风格、无 hack`,
    `- efficiency: 耗时/调用数相对参考是否合理`,
    `- noRegression: 既有测试全过 + 未碰禁区 = 1；否则 0`,
    ``,
    `## 防偏见`,
    `- 不要使用 agent 名字、版本、模型信息做加减分（输入中也不提供）`,
    `- 不要参考任何历史分数`,
    ``,
    `## 输出格式（严格 JSON）`,
    `{`,
    `  "taskCompletion": 0.x,`,
    `  "correctness": 0.x,`,
    `  "completeness": 0.x,`,
    `  "codeQuality": 0.x,`,
    `  "efficiency": 0.x,`,
    `  "noRegression": 0.x,`,
    `  "reasoning": "一句话评语"`,
    `}`,
  ].join('\n');
}

function extractJsonBlock(text: string): string | null {
  if (!text) return null;
  // 先直接尝试整块
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  // ```json ... ``` 或 ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{')) return inner;
  }
  // 退而求其次：第一个 { 到最后一个 }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  return null;
}

function clamp01(n: unknown): number {
  const x = typeof n === 'number' && Number.isFinite(n) ? n : NaN;
  if (Number.isNaN(x)) {
    throw new Error(`字段不是有限数字: ${String(n)}`);
  }
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function parseScore(raw: string): JudgeScore {
  const block = extractJsonBlock(raw);
  if (!block) {
    throw new Error('裁判输出找不到 JSON 对象');
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(block) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`裁判输出 JSON 解析失败: ${(err as Error).message}`);
  }

  const score: Partial<JudgeScore> = {};
  for (const dim of DIMENSIONS) {
    if (!(dim in obj)) {
      throw new Error(`裁判输出缺少维度字段: ${dim}`);
    }
    (score as Record<Dim, number>)[dim] = clamp01(obj[dim]);
  }
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
  return { ...(score as Record<Dim, number>), reasoning } as JudgeScore;
}

export function applyPostCheckCap(
  score: JudgeScore,
  objectiveChecks: JudgeInput['objectiveChecks'],
  cap = 0.5,
): JudgeScore {
  const anyFailed = objectiveChecks.some((c) => c.exitCode !== 0);
  if (!anyFailed) return score;
  if (score.correctness <= cap) return score;
  return { ...score, correctness: cap };
}

// ─── Main entry ───

export async function judge(input: JudgeInput, config: JudgeConfig): Promise<JudgeScore> {
  const client =
    config.openaiClient ??
    new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });

  const userPrompt = buildJudgePrompt(input);
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_INSTRUCTION },
    { role: 'user', content: userPrompt },
  ];
  const temperature = config.temperature ?? 0;

  let lastErr: Error | undefined;
  // 最多调 2 次：首次 + 解析失败 1 次重试
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await client.chat.completions.create({
      model: config.model,
      messages,
      temperature,
      stream: false,
    });
    const content = (resp as any)?.choices?.[0]?.message?.content;
    const raw = typeof content === 'string' ? content : '';
    try {
      const parsed = parseScore(raw);
      return applyPostCheckCap(parsed, input.objectiveChecks);
    } catch (err) {
      lastErr = err as Error;
      // 继续下一次尝试
    }
  }
  throw new Error(
    `judge: 连续 2 次解析失败: ${lastErr ? lastErr.message : 'unknown'}`,
  );
}

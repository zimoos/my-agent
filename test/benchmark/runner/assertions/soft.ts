import type {
  SoftAssertion,
  SoftResult,
  RunTrace,
  TaskDef,
  HardAssertionResult,
} from '../types.js';
import { M1_SOFT_TYPES } from '../types.js';
import {
  judge,
  type JudgeConfig,
  type JudgeInput,
  type JudgeScore,
} from '../judge-client.js';

type JudgeFn = typeof judge;

export function evaluateSoft(
  assertions: SoftAssertion[],
  trace: RunTrace
): SoftResult[] {
  return assertions.map((assertion) => {
    if (!M1_SOFT_TYPES.has(assertion.type)) {
      return { assertion, score: null, weight: assertion.weight };
    }

    let score: number;

    switch (assertion.type) {
      case 'final_text_min_len': {
        const len = trace.finalText.length;
        score = assertion.chars <= 0 ? 1 : Math.min(1, len / assertion.chars);
        break;
      }
      case 'tool_call_count_max': {
        const count = trace.toolCalls.length;
        if (count <= assertion.max) score = 1;
        else score = assertion.max <= 0 ? 0 : Math.min(1, assertion.max / count);
        break;
      }
      case 'duration_max': {
        const elapsed = trace.elapsedMs;
        if (elapsed <= 0) {
          score = 1;
        } else {
          score = Math.min(1, assertion.ms / elapsed);
        }
        break;
      }
      default: {
        return { assertion, score: null, weight: assertion.weight };
      }
    }

    return { assertion, score, weight: assertion.weight };
  });
}

export async function evaluateSoftWithJudge(
  assertions: SoftAssertion[],
  trace: RunTrace,
  task: TaskDef,
  hardResults: HardAssertionResult[],
  judgeConfig?: JudgeConfig,
  judgeFn: JudgeFn = judge
): Promise<SoftResult[]> {
  const base = evaluateSoft(assertions, trace);
  if (!judgeConfig) return base;

  const out: SoftResult[] = [];
  for (let i = 0; i < assertions.length; i++) {
    const assertion = assertions[i];
    if (assertion.type !== 'llm_judge') {
      out.push(base[i]);
      continue;
    }
    try {
      const score = await judgeFn(buildJudgeInput(task, trace, hardResults, assertion.rubric), judgeConfig);
      out.push({
        assertion,
        score: l12JudgeTotal(score),
        weight: assertion.weight,
        reason: score.reasoning,
      });
    } catch (err) {
      out.push({
        assertion,
        score: 0,
        weight: assertion.weight,
        reason: `judge failed: ${(err as Error).message}`,
      });
    }
  }
  return out;
}

function buildJudgeInput(
  task: TaskDef,
  trace: RunTrace,
  hardResults: HardAssertionResult[],
  rubric: string
): JudgeInput {
  const prompt = task.rounds
    ? task.rounds.map((r, i) => `Round ${i}: ${r.user}`).join('\n')
    : task.userInput ?? '';
  const rubricPoints = [
    rubric,
    ...(task.judgeRubric ?? []),
    ...(task.behaviorExpectations ?? []).map((x) => `行为要求：${x}`),
    ...((task.rounds ?? []).flatMap((r, i) =>
      (r.judgeRubric ?? []).map((x) => `Round ${i}: ${x}`)
    )),
  ];
  return {
    taskDescription: `${task.id} - ${task.title}`,
    prompt,
    rubricPoints,
    workspaceDiff: '',
    finalAnswer: trace.finalText,
    objectiveChecks: hardResults.map((r) => ({
      command: JSON.stringify(r.assertion),
      exitCode: r.passed ? 0 : 1,
      stdout: r.reason,
      weightInto: 'correctness',
    })),
    runtimeStats: {
      elapsedMs: trace.elapsedMs,
      exitCode: trace.crashed || trace.aborted || trace.hitMaxLoops ? 1 : 0,
    },
  };
}

function l12JudgeTotal(score: JudgeScore): number {
  return (
    score.taskCompletion * 0.25 +
    score.correctness * 0.2 +
    score.completeness * 0.15 +
    score.codeQuality * 0.1 +
    score.efficiency * 0.1 +
    score.noRegression * 0.2
  );
}

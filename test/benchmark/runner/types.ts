import type { AgentEvent } from '../../../src/agent/events.js';

// Re-export for convenience
export type { AgentEvent } from '../../../src/agent/events.js';

// ─── Level ───

export type Level = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export const LEVEL_ORDER: Level[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

export const LEVEL_CONFIG: Record<Level, { cutoff: number; rate: number; weight: number }> = {
  L0: { cutoff: 1.0, rate: 1.0, weight: 0 },
  L1: { cutoff: 0.75, rate: 0.90, weight: 15 },
  L2: { cutoff: 0.65, rate: 0.80, weight: 20 },
  L3: { cutoff: 0.55, rate: 0.70, weight: 25 },
  L4: { cutoff: 0.45, rate: 0.60, weight: 25 },
  L5: { cutoff: 0.40, rate: 0.50, weight: 15 },
};

// ─── TaskDef (YAML → TS) ───

export interface TaskDef {
  id: string;
  title: string;
  level: Level;
  category: string;
  weight: number;
  fixture?: FixtureSpec;
  userInput?: string;
  attachments?: AttachmentSpec[];
  rounds?: RoundDef[];
  behaviorExpectations?: string[];
  requires?: Requirement[];
  judgeRubric?: string[];
  hardAssertions: HardAssertion[];
  softAssertions: SoftAssertion[];
  runtime: RuntimeSpec;
  reference?: ReferenceSpec;
  dimWeights?: Partial<Record<Dimension, number>>;
  sourcePath: string;
}

export interface FixtureSpec {
  project: string;
  setup?: string[];
}

export type Requirement = 'vision' | 'network' | 'write_access';

export interface AttachmentSpec {
  type: 'image';
  path: string;
  mime?: string;
}

export interface RoundDef {
  user: string;
  attachments?: AttachmentSpec[];
  judgeRubric?: string[];
  expect?: {
    toolCallsInclude?: string[];
  };
}

export interface RuntimeSpec {
  timeoutSec: number;
  runs: number;
  maxRounds: number | null;
  layer: 'L1' | 'L2';
}

export interface ReferenceSpec {
  referenceRounds?: number;
  humanTimeSec?: number;
  claudeCodeScore?: number;
}

// ─── Assertions ───

export type HardAssertion =
  | { type: 'tool_called'; tool?: string; toolMatches?: string; argsContains?: Record<string, unknown>; argsMatches?: Record<string, string> }
  | { type: 'tool_not_called'; tool?: string; toolMatches?: string }
  | { type: 'tool_retry_max'; maxSameError: number }
  | { type: 'no_orphan_tool' }
  | { type: 'compact_count_min'; min: number }
  | { type: 'compact_count_max'; max: number }
  | { type: 'context_window_min'; min: number }
  | { type: 'no_silent_tool_streak'; max: number }
  | { type: 'progress_count_min'; min: number }
  | { type: 'compact_failure_has_user_summary' }
  | { type: 'task_failure_has_actionable_summary' }
  | { type: 'tool_call_count_by_round'; round: number; min?: number; max?: number; tool?: string; toolMatches?: string }
  | { type: 'final_text_mentions_uncertainty_or_question' }
  | { type: 'no_repeat_read_same_file_after_context_available'; maxReads?: number }
  | { type: 'file_content'; path: string; contains?: string; notContains?: string; regex?: string; exact?: string }
  | { type: 'file_exists'; path: string }
  | { type: 'not_file_modified'; path: string }
  | { type: 'no_error_5xx' }
  | { type: 'final_text_contains'; contains?: string; regex?: string }
  | { type: 'final_text_min_chars'; chars: number; chinese?: boolean }
  | { type: 'event_sequence'; sequence: string[] }
  | { type: 'messages_count_max'; max: number }
  | { type: 'exit_code'; cmd: string; code: number };

export interface HardAssertionResult {
  assertion: HardAssertion;
  passed: boolean;
  reason: string;
}

export type SoftAssertion =
  | { type: 'final_text_min_len'; chars: number; weight: number }
  | { type: 'tool_call_count_max'; max: number; weight: number }
  | { type: 'duration_max'; ms: number; weight: number }
  | { type: 'llm_judge'; rubric: string; weight: number }
  | { type: 'reference_match_ratio'; ref: string; weight: number }
  | { type: 'token_usage_max'; max: number; weight: number };

export const M1_SOFT_TYPES = new Set(['final_text_min_len', 'tool_call_count_max', 'duration_max']);

export interface SoftResult {
  assertion: SoftAssertion;
  score: number | null;
  weight: number;
  reason?: string;
}

// ─── Dimensions (M1 records but doesn't score) ───

export type Dimension = 'ToolAcc' | 'TaskDone' | 'AnsQual' | 'CtxKeep' | 'ErrRec' | 'Eff';

// ─── RunTrace (event-collector output) ───

export interface RunTrace {
  taskId: string;
  runIndex: number;
  freshness?: RunFreshness;
  events: AgentEvent[];
  toolCalls: ToolCallRecord[];
  rounds?: RoundTrace[];
  finalText: string;
  messagesCount: number;
  thinkingMs: number;
  apiCalls: number;
  compactCount?: number;
  contextRecallCount?: number;
  contextWindow?: number;
  compactThreshold?: number;
  maxContextUsed?: number;
  maxSilentToolStreak?: number;
  progressCount?: number;
  failureSummary?: string;
  warningCount?: number;
  errorCount?: number;
  repeatedToolCallCount?: number;
  toolProtocol?: {
    orphanToolResults: number;
    unclosedToolCalls: number;
  };
  startedAt: number;
  elapsedMs: number;
  hitMaxLoops: boolean;
  aborted: boolean;
  crashed: boolean;
  crashReason?: string;
}

export interface RunFreshness {
  runId: string;
  seed: string;
  caseId: string;
  workspaceId: string;
  fixtureProject?: string;
  fixtureFingerprint?: string;
  promptFingerprint: string;
  mode: 'static-regression-isolated-workspace';
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  resultPreview: string;
  roundIndex?: number;
}

export interface RoundTrace {
  roundIndex: number;
  user: string;
  toolCalls: ToolCallRecord[];
  finalText: string;
  compactCount: number;
  warningCount: number;
  errorCount: number;
  elapsedMs: number;
}

// ─── Scoring ───

export interface TaskScore {
  taskId: string;
  hardPass: boolean;
  softScore: number;
  rawScore: number;
  hardResults: HardAssertionResult[];
  softResults: SoftResult[];
  trace: RunTrace;
  skipped?: boolean;
  skipReason?: string;
}

export interface TaskResult {
  taskId: string;
  level: Level;
  runs: TaskScore[];
  median: number;
  stability: number;
  passRate: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface LevelScore {
  level: Level;
  score: number;
  passRate: number;
  gateOk: boolean;
  tasks: TaskResult[];
}

export interface BenchmarkReport {
  runId: string;
  freshness?: BenchmarkFreshness;
  config: { agent: string; model: string; baseURL: string };
  totalScore: number;
  level: number;
  byLevel: Partial<Record<Level, LevelScore>>;
  weakest: Array<{ taskId: string; median: number; reason: string }>;
  startedAt: string;
  elapsedMs: number;
}

export interface BenchmarkFreshness {
  seed: string;
  mode: 'static-regression-isolated-workspace';
  taskSelectionFingerprint: string;
  semanticVariation: 'static-regression';
  notes: string[];
}

// ─── Run Options (CLI → runner) ───

export interface RunOptions {
  tasksDir: string;
  fixturesDir: string;
  reportsDir: string;
  configPath?: string;
  filterLevel?: Level;
  filterTask?: string;
  runs?: number;
  dryRun?: boolean;
}

// ─── Exit Codes ───

export const EXIT_OK = 0;
export const EXIT_GATE_FAIL = 1;
export const EXIT_L0_INVALID = 2;
export const EXIT_RUNTIME_ERROR = 99;

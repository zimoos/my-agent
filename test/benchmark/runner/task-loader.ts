import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  TaskDef,
  Level,
  HardAssertion,
  SoftAssertion,
  FixtureSpec,
  RoundDef,
  RuntimeSpec,
  ReferenceSpec,
  Dimension,
  Requirement,
  AttachmentSpec,
} from './types.js';
import { LEVEL_ORDER } from './types.js';

// ─── Known enums (mirror types.ts union literals) ───

const HARD_ASSERTION_TYPES = new Set<string>([
  'tool_called',
  'tool_not_called',
  'tool_retry_max',
  'no_orphan_tool',
  'compact_count_min',
  'compact_count_max',
  'context_window_min',
  'no_silent_tool_streak',
  'progress_count_min',
  'compact_failure_has_user_summary',
  'task_failure_has_actionable_summary',
  'tool_call_count_by_round',
  'final_text_mentions_uncertainty_or_question',
  'no_repeat_read_same_file_after_context_available',
  'file_content',
  'file_exists',
  'not_file_modified',
  'no_error_5xx',
  'final_text_contains',
  'final_text_min_chars',
  'event_sequence',
  'messages_count_max',
  'exit_code',
]);

const SOFT_ASSERTION_TYPES = new Set<string>([
  'final_text_min_len',
  'tool_call_count_max',
  'duration_max',
  'llm_judge',
  'reference_match_ratio',
  'token_usage_max',
]);

const LEVEL_SET = new Set<string>(LEVEL_ORDER);
const LAYER_SET = new Set<string>(['L1', 'L2']);
const REQUIREMENT_SET = new Set<string>(['vision', 'network', 'write_access']);
const ATTACHMENT_TYPE_SET = new Set<string>(['image']);
const DIMENSIONS: Dimension[] = ['ToolAcc', 'TaskDone', 'AnsQual', 'CtxKeep', 'ErrRec', 'Eff'];
const DIMENSION_SET = new Set<string>(DIMENSIONS);
const L0_TO_L2_LEVELS: Level[] = ['L0', 'L1', 'L2'];

const ID_REGEX = /^L[0-5]-\d{3}$/;

// ─── Loader API ───

export interface LoadTasksOptions {
  tasksDir: string;
  fixturesDir?: string;
  e2eFixturesDir?: string;
  filterLevel?: Level;
  filterTask?: string;
}

export interface LoadTasksResult {
  tasks: TaskDef[];
  errors: string[];
}

export function loadTasks(options: LoadTasksOptions): LoadTasksResult {
  const errors: string[] = [];
  const tasks: TaskDef[] = [];
  const seenIds = new Map<string, string>();

  const yamlPaths = collectYamlPaths(options.tasksDir, options.filterLevel, errors);

  for (const filePath of yamlPaths) {
    let raw: unknown;
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      raw = yaml.load(text);
    } catch (err) {
      errors.push(`[${relativize(filePath, options.tasksDir)}] YAML parse failed: ${(err as Error).message}`);
      continue;
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`[${relativize(filePath, options.tasksDir)}] top-level must be a mapping`);
      continue;
    }

    const task = parseTask(raw as Record<string, unknown>, filePath, options, errors);
    if (!task) continue;

    const prev = seenIds.get(task.id);
    if (prev) {
      errors.push(`[${relativize(filePath, options.tasksDir)}] duplicate id "${task.id}" also in ${relativize(prev, options.tasksDir)}`);
      continue;
    }
    seenIds.set(task.id, filePath);
    tasks.push(task);
  }

  const filtered = applyFilters(tasks, options);

  if (errors.length > 0) {
    return { tasks: [], errors };
  }
  return { tasks: filtered, errors: [] };
}

// ─── File discovery ───

function collectYamlPaths(tasksDir: string, filterLevel: Level | undefined, errors: string[]): string[] {
  if (!fs.existsSync(tasksDir)) {
    errors.push(`tasksDir does not exist: ${tasksDir}`);
    return [];
  }

  const levels = filterLevel ? [filterLevel] : L0_TO_L2_LEVELS;

  const out: string[] = [];
  for (const level of levels) {
    const levelDir = path.join(tasksDir, level);
    if (!fs.existsSync(levelDir)) continue;
    const entries = fs.readdirSync(levelDir);
    for (const name of entries) {
      if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue;
      out.push(path.join(levelDir, name));
    }
  }
  out.sort();
  return out;
}

function relativize(filePath: string, baseDir: string): string {
  const rel = path.relative(baseDir, filePath);
  return rel || filePath;
}

// ─── Task parse + validate ───

function parseTask(
  obj: Record<string, unknown>,
  filePath: string,
  options: LoadTasksOptions,
  errors: string[]
): TaskDef | null {
  const loc = relativize(filePath, options.tasksDir);
  const push = (msg: string) => errors.push(`[${loc}] ${msg}`);

  const id = expectString(obj, 'id', push);
  const title = expectString(obj, 'title', push);
  const level = expectString(obj, 'level', push);
  const category = expectString(obj, 'category', push);
  const weight = expectNumber(obj, 'weight', push);

  if (id !== undefined && !ID_REGEX.test(id)) {
    push(`id "${id}" must match ^L[0-5]-\\d{3}$`);
  }
  if (level !== undefined && !LEVEL_SET.has(level)) {
    push(`level "${level}" not in ${LEVEL_ORDER.join(',')}`);
  }
  if (weight !== undefined && !(weight > 0)) {
    push(`weight must be > 0 (got ${weight})`);
  }

  const userInput = optionalString(obj, 'user_input', push);
  const attachments = parseAttachments(obj['attachments'], push, 'attachments');
  const roundsRaw = obj['rounds'];
  const rounds = parseRounds(roundsRaw, push);
  const behaviorExpectations = parseStringArray(
    obj['behavior_expectations'],
    push,
    'behavior_expectations'
  );
  const requires = parseRequires(obj['requires'], push);
  const judgeRubric = parseStringArray(obj['judge_rubric'], push, 'judge_rubric');

  if (userInput === undefined && rounds === undefined) {
    push(`must define either user_input or rounds`);
  }
  if (userInput !== undefined && rounds !== undefined) {
    push(`cannot define both user_input and rounds`);
  }

  const fixture = parseFixture(obj['fixture'], push, options, loc);
  const runtime = parseRuntime(obj['runtime'], push);

  const hardAssertions = parseHardAssertions(obj['hard_assertions'], push);
  const softAssertions = parseSoftAssertions(obj['soft_assertions'], push);
  const reference = parseReference(obj['reference'], push);
  const dimWeights = parseDimWeights(obj['dim_weights'], push);

  // Gate: must have ≥1 hard assertion.
  if (hardAssertions.length < 1) {
    push(`hard_assertions must have at least 1 entry`);
  }

  // Reject unknown top-level keys we don't recognize (soft guard; ignore known allowed skip-fields).
  // Known allowed: id/title/level/category/weight/fixture/user_input/rounds/
  // hard_assertions/soft_assertions/runtime/reference/dim_weights.
  // We don't flag extras because consensus #6 says allow-but-skip for future fields.

  if (
    id === undefined ||
    title === undefined ||
    level === undefined ||
    category === undefined ||
    weight === undefined ||
    runtime === undefined
  ) {
    return null;
  }
  if (!LEVEL_SET.has(level)) return null;
  if (!ID_REGEX.test(id)) return null;

  const task: TaskDef = {
    id,
    title,
    level: level as Level,
    category,
    weight,
    fixture,
    userInput,
    attachments,
    rounds,
    behaviorExpectations,
    requires,
    judgeRubric,
    hardAssertions,
    softAssertions,
    runtime,
    reference,
    dimWeights,
    sourcePath: filePath,
  };
  return task;
}

// ─── Primitive helpers ───

function expectString(
  obj: Record<string, unknown>,
  key: string,
  push: (m: string) => void
): string | undefined {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    push(`field "${key}" must be a non-empty string`);
    return undefined;
  }
  return v;
}

function expectNumber(
  obj: Record<string, unknown>,
  key: string,
  push: (m: string) => void
): number | undefined {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    push(`field "${key}" must be a finite number`);
    return undefined;
  }
  return v;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  push: (m: string) => void
): string | undefined {
  if (!(key in obj)) return undefined;
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    push(`field "${key}" must be a non-empty string when present`);
    return undefined;
  }
  return v;
}

// ─── Sub-object parsers ───

function parseFixture(
  raw: unknown,
  push: (m: string) => void,
  options: LoadTasksOptions,
  loc: string
): FixtureSpec | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    push(`fixture must be a mapping`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const project = obj['project'];
  if (typeof project !== 'string' || project.length === 0) {
    push(`fixture.project must be a non-empty string`);
    return undefined;
  }
  const setup = obj['setup'];
  let setupArr: string[] | undefined;
  if (setup !== undefined) {
    if (!Array.isArray(setup) || !setup.every((s) => typeof s === 'string')) {
      push(`fixture.setup must be an array of strings`);
    } else {
      setupArr = setup as string[];
    }
  }

  // Resolve project directory: fixturesDir/project first, then e2eFixturesDir/project.
  const candidates: string[] = [];
  if (options.fixturesDir) candidates.push(path.join(options.fixturesDir, project));
  if (options.e2eFixturesDir) candidates.push(path.join(options.e2eFixturesDir, project));

  const hit = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
  if (!hit) {
    const searched = candidates.length > 0 ? candidates.join(', ') : '(no fixturesDir configured)';
    push(`fixture.project "${project}" not found under: ${searched}`);
  }

  return { project, setup: setupArr };
}

function parseRounds(raw: unknown, push: (m: string) => void): RoundDef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    push(`rounds must be an array`);
    return undefined;
  }
  if (raw.length === 0) {
    push(`rounds must not be empty`);
    return undefined;
  }
  const out: RoundDef[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (!r || typeof r !== 'object') {
      push(`rounds[${i}] must be a mapping`);
      continue;
    }
    const obj = r as Record<string, unknown>;
    const user = obj['user'];
    if (typeof user !== 'string' || user.length === 0) {
      push(`rounds[${i}].user must be a non-empty string`);
      continue;
    }
    const attachments = parseAttachments(
      obj['attachments'],
      push,
      `rounds[${i}].attachments`
    );
    const judgeRubric = parseStringArray(
      obj['judge_rubric'],
      push,
      `rounds[${i}].judge_rubric`
    );
    const expectRaw = obj['expect'];
    let expect: RoundDef['expect'];
    if (expectRaw !== undefined) {
      if (!expectRaw || typeof expectRaw !== 'object' || Array.isArray(expectRaw)) {
        push(`rounds[${i}].expect must be a mapping`);
      } else {
        const e = expectRaw as Record<string, unknown>;
        const tci = e['tool_calls_include'];
        if (tci !== undefined) {
          if (!Array.isArray(tci) || !tci.every((s) => typeof s === 'string')) {
            push(`rounds[${i}].expect.tool_calls_include must be string[]`);
          } else {
            expect = { toolCallsInclude: tci as string[] };
          }
        }
      }
    }
    out.push({ user, attachments, judgeRubric, expect });
  }
  return out;
}

function parseStringArray(
  raw: unknown,
  push: (m: string) => void,
  field: string
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((s) => typeof s === 'string' && s.length > 0)) {
    push(`${field} must be a non-empty string[] when present`);
    return undefined;
  }
  return raw as string[];
}

function parseRequires(raw: unknown, push: (m: string) => void): Requirement[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    push(`requires must be a string[]`);
    return undefined;
  }
  const out: Requirement[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !REQUIREMENT_SET.has(v)) {
      push(`requires contains unknown capability "${String(v)}"`);
      continue;
    }
    out.push(v as Requirement);
  }
  return out;
}

function parseAttachments(
  raw: unknown,
  push: (m: string) => void,
  field: string
): AttachmentSpec[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    push(`${field} must be an array`);
    return undefined;
  }
  const out: AttachmentSpec[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      push(`${field}[${i}] must be a mapping`);
      continue;
    }
    const obj = item as Record<string, unknown>;
    const type = obj['type'] ?? 'image';
    if (typeof type !== 'string' || !ATTACHMENT_TYPE_SET.has(type)) {
      push(`${field}[${i}].type must be "image"`);
      continue;
    }
    const p = obj['path'];
    if (typeof p !== 'string' || p.length === 0) {
      push(`${field}[${i}].path must be a non-empty string`);
      continue;
    }
    const mime = obj['mime'];
    if (mime !== undefined && typeof mime !== 'string') {
      push(`${field}[${i}].mime must be string`);
      continue;
    }
    out.push({ type: 'image', path: p, mime });
  }
  return out;
}

function parseRuntime(raw: unknown, push: (m: string) => void): RuntimeSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    push(`runtime must be a mapping`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const timeoutSec = obj['timeout_sec'];
  const runs = obj['runs'];
  const maxRoundsRaw = obj['max_rounds'];
  const layer = obj['layer'];

  if (typeof timeoutSec !== 'number' || !(timeoutSec > 0)) {
    push(`runtime.timeout_sec must be a positive number`);
  }
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 1) {
    push(`runtime.runs must be a positive integer`);
  }
  let maxRounds: number | null = null;
  if (maxRoundsRaw === null || maxRoundsRaw === undefined) {
    maxRounds = null;
  } else if (typeof maxRoundsRaw === 'number' && Number.isInteger(maxRoundsRaw) && maxRoundsRaw >= 1) {
    maxRounds = maxRoundsRaw;
  } else {
    push(`runtime.max_rounds must be a positive integer or null`);
  }
  if (typeof layer !== 'string' || !LAYER_SET.has(layer)) {
    push(`runtime.layer must be one of ${[...LAYER_SET].join(',')}`);
  }

  if (
    typeof timeoutSec !== 'number' ||
    typeof runs !== 'number' ||
    typeof layer !== 'string' ||
    !LAYER_SET.has(layer)
  ) {
    return undefined;
  }
  return { timeoutSec, runs, maxRounds, layer: layer as 'L1' | 'L2' };
}

function parseReference(raw: unknown, push: (m: string) => void): ReferenceSpec | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    push(`reference must be a mapping`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const out: ReferenceSpec = {};
  if (obj['reference_rounds'] !== undefined) {
    const v = obj['reference_rounds'];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out.referenceRounds = v;
    else push(`reference.reference_rounds must be a non-negative integer`);
  }
  if (obj['human_time_sec'] !== undefined) {
    const v = obj['human_time_sec'];
    if (typeof v === 'number' && v >= 0) out.humanTimeSec = v;
    else push(`reference.human_time_sec must be a non-negative number`);
  }
  if (obj['claude_code_score'] !== undefined) {
    const v = obj['claude_code_score'];
    if (typeof v === 'number') out.claudeCodeScore = v;
    else push(`reference.claude_code_score must be a number`);
  }
  return out;
}

function parseDimWeights(
  raw: unknown,
  push: (m: string) => void
): Partial<Record<Dimension, number>> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    push(`dim_weights must be a mapping`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<Record<Dimension, number>> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!DIMENSION_SET.has(k)) {
      push(`dim_weights.${k} is not a valid dimension`);
      continue;
    }
    if (typeof v !== 'number' || v < 0) {
      push(`dim_weights.${k} must be a non-negative number`);
      continue;
    }
    out[k as Dimension] = v;
  }
  return out;
}

// ─── Assertion parsers ───

function parseHardAssertions(raw: unknown, push: (m: string) => void): HardAssertion[] {
  if (raw === undefined) {
    push(`hard_assertions is required`);
    return [];
  }
  if (!Array.isArray(raw)) {
    push(`hard_assertions must be an array`);
    return [];
  }
  const out: HardAssertion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const parsed = parseHardAssertion(item, i, push);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseHardAssertion(
  raw: unknown,
  idx: number,
  push: (m: string) => void
): HardAssertion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    push(`hard_assertions[${idx}] must be a mapping`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const type = obj['type'];
  if (typeof type !== 'string' || !HARD_ASSERTION_TYPES.has(type)) {
    push(`hard_assertions[${idx}].type "${String(type)}" is not a known hard assertion`);
    return null;
  }

  const tagged = `hard_assertions[${idx}](${type})`;

  switch (type) {
    case 'tool_called': {
      const out: HardAssertion = { type: 'tool_called' };
      if (obj['tool'] !== undefined) {
        if (typeof obj['tool'] !== 'string') {
          push(`${tagged}.tool must be string`);
          return null;
        }
        out.tool = obj['tool'];
      }
      if (obj['tool_matches'] !== undefined) {
        if (typeof obj['tool_matches'] !== 'string') {
          push(`${tagged}.tool_matches must be string`);
          return null;
        }
        out.toolMatches = obj['tool_matches'] as string;
      }
      if (!out.tool && !out.toolMatches) {
        push(`${tagged} requires tool or tool_matches`);
        return null;
      }
      if (obj['args_contains'] !== undefined) {
        if (!isPlainObject(obj['args_contains'])) {
          push(`${tagged}.args_contains must be a mapping`);
          return null;
        }
        out.argsContains = obj['args_contains'] as Record<string, unknown>;
      }
      if (obj['args_matches'] !== undefined) {
        if (!isPlainObject(obj['args_matches'])) {
          push(`${tagged}.args_matches must be a mapping of string→string`);
          return null;
        }
        const m = obj['args_matches'] as Record<string, unknown>;
        for (const [, rv] of Object.entries(m)) {
          if (typeof rv !== 'string') {
            push(`${tagged}.args_matches values must be strings`);
            return null;
          }
        }
        out.argsMatches = m as Record<string, string>;
      }
      return out;
    }
    case 'tool_not_called': {
      const out: HardAssertion = { type: 'tool_not_called' };
      if (obj['tool'] !== undefined) {
        if (typeof obj['tool'] !== 'string') {
          push(`${tagged}.tool must be string`);
          return null;
        }
        out.tool = obj['tool'];
      }
      if (obj['tool_matches'] !== undefined) {
        if (typeof obj['tool_matches'] !== 'string') {
          push(`${tagged}.tool_matches must be string`);
          return null;
        }
        out.toolMatches = obj['tool_matches'] as string;
      }
      if (!out.tool && !out.toolMatches) {
        push(`${tagged} requires tool or tool_matches`);
        return null;
      }
      return out;
    }
    case 'tool_retry_max': {
      const v = obj['max_same_error'];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        push(`${tagged}.max_same_error must be a non-negative integer`);
        return null;
      }
      return { type: 'tool_retry_max', maxSameError: v };
    }
    case 'no_orphan_tool':
      return { type: 'no_orphan_tool' };
    case 'compact_count_min': {
      const min = obj['min'];
      if (typeof min !== 'number' || !Number.isInteger(min) || min < 0) {
        push(`${tagged}.min must be a non-negative integer`);
        return null;
      }
      return { type: 'compact_count_min', min };
    }
    case 'compact_count_max': {
      const max = obj['max'];
      if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
        push(`${tagged}.max must be a non-negative integer`);
        return null;
      }
      return { type: 'compact_count_max', max };
    }
    case 'context_window_min': {
      const min = obj['min'];
      if (typeof min !== 'number' || !Number.isInteger(min) || min < 0) {
        push(`${tagged}.min must be a non-negative integer`);
        return null;
      }
      return { type: 'context_window_min', min };
    }
    case 'no_silent_tool_streak': {
      const max = obj['max'];
      if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
        push(`${tagged}.max must be a non-negative integer`);
        return null;
      }
      return { type: 'no_silent_tool_streak', max };
    }
    case 'progress_count_min': {
      const min = obj['min'];
      if (typeof min !== 'number' || !Number.isInteger(min) || min < 0) {
        push(`${tagged}.min must be a non-negative integer`);
        return null;
      }
      return { type: 'progress_count_min', min };
    }
    case 'compact_failure_has_user_summary':
      return { type: 'compact_failure_has_user_summary' };
    case 'task_failure_has_actionable_summary':
      return { type: 'task_failure_has_actionable_summary' };
    case 'tool_call_count_by_round': {
      const round = obj['round'];
      if (typeof round !== 'number' || !Number.isInteger(round) || round < 0) {
        push(`${tagged}.round must be a non-negative integer`);
        return null;
      }
      const out: HardAssertion = { type: 'tool_call_count_by_round', round };
      if (obj['min'] !== undefined) {
        if (typeof obj['min'] !== 'number' || !Number.isInteger(obj['min']) || obj['min'] < 0) {
          push(`${tagged}.min must be a non-negative integer`);
          return null;
        }
        out.min = obj['min'];
      }
      if (obj['max'] !== undefined) {
        if (typeof obj['max'] !== 'number' || !Number.isInteger(obj['max']) || obj['max'] < 0) {
          push(`${tagged}.max must be a non-negative integer`);
          return null;
        }
        out.max = obj['max'];
      }
      if (obj['tool'] !== undefined) {
        if (typeof obj['tool'] !== 'string') {
          push(`${tagged}.tool must be string`);
          return null;
        }
        out.tool = obj['tool'];
      }
      if (obj['tool_matches'] !== undefined) {
        if (typeof obj['tool_matches'] !== 'string') {
          push(`${tagged}.tool_matches must be string`);
          return null;
        }
        out.toolMatches = obj['tool_matches'];
      }
      if (out.min === undefined && out.max === undefined) {
        push(`${tagged} requires min or max`);
        return null;
      }
      return out;
    }
    case 'final_text_mentions_uncertainty_or_question':
      return { type: 'final_text_mentions_uncertainty_or_question' };
    case 'no_repeat_read_same_file_after_context_available': {
      const rawMax = obj['max_reads'];
      if (rawMax !== undefined && (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax < 1)) {
        push(`${tagged}.max_reads must be a positive integer`);
        return null;
      }
      return {
        type: 'no_repeat_read_same_file_after_context_available',
        maxReads: rawMax as number | undefined,
      };
    }
    case 'file_content': {
      const p = obj['path'];
      if (typeof p !== 'string' || p.length === 0) {
        push(`${tagged}.path must be a non-empty string`);
        return null;
      }
      const out: HardAssertion = { type: 'file_content', path: p };
      let any = false;
      for (const [srcKey, dstKey] of [
        ['contains', 'contains'],
        ['not_contains', 'notContains'],
        ['regex', 'regex'],
        ['exact', 'exact'],
      ] as const) {
        if (obj[srcKey] !== undefined) {
          if (typeof obj[srcKey] !== 'string') {
            push(`${tagged}.${srcKey} must be string`);
            return null;
          }
          (out as Record<string, unknown>)[dstKey] = obj[srcKey];
          any = true;
        }
      }
      if (!any) {
        push(`${tagged} requires one of contains/not_contains/regex/exact`);
        return null;
      }
      return out;
    }
    case 'file_exists': {
      const p = obj['path'];
      if (typeof p !== 'string' || p.length === 0) {
        push(`${tagged}.path must be a non-empty string`);
        return null;
      }
      return { type: 'file_exists', path: p };
    }
    case 'not_file_modified': {
      const p = obj['path'];
      if (typeof p !== 'string' || p.length === 0) {
        push(`${tagged}.path must be a non-empty string`);
        return null;
      }
      return { type: 'not_file_modified', path: p };
    }
    case 'no_error_5xx':
      return { type: 'no_error_5xx' };
    case 'final_text_contains': {
      const out: HardAssertion = { type: 'final_text_contains' };
      if (obj['contains'] !== undefined) {
        if (typeof obj['contains'] !== 'string') {
          push(`${tagged}.contains must be string`);
          return null;
        }
        out.contains = obj['contains'] as string;
      }
      if (obj['regex'] !== undefined) {
        if (typeof obj['regex'] !== 'string') {
          push(`${tagged}.regex must be string`);
          return null;
        }
        out.regex = obj['regex'] as string;
      }
      if (out.contains === undefined && out.regex === undefined) {
        push(`${tagged} requires contains or regex`);
        return null;
      }
      return out;
    }
    case 'final_text_min_chars': {
      const chars = obj['chars'];
      if (typeof chars !== 'number' || !Number.isInteger(chars) || chars < 0) {
        push(`${tagged}.chars must be a non-negative integer`);
        return null;
      }
      const out: HardAssertion = { type: 'final_text_min_chars', chars };
      if (obj['chinese'] !== undefined) {
        if (typeof obj['chinese'] !== 'boolean') {
          push(`${tagged}.chinese must be boolean`);
          return null;
        }
        out.chinese = obj['chinese'] as boolean;
      }
      return out;
    }
    case 'event_sequence': {
      const seq = obj['sequence'];
      if (!Array.isArray(seq) || !seq.every((s) => typeof s === 'string') || seq.length === 0) {
        push(`${tagged}.sequence must be a non-empty string[]`);
        return null;
      }
      return { type: 'event_sequence', sequence: seq as string[] };
    }
    case 'messages_count_max': {
      const m = obj['max'];
      if (typeof m !== 'number' || !Number.isInteger(m) || m < 0) {
        push(`${tagged}.max must be a non-negative integer`);
        return null;
      }
      return { type: 'messages_count_max', max: m };
    }
    case 'exit_code': {
      const cmd = obj['cmd'];
      const code = obj['code'];
      if (typeof cmd !== 'string' || cmd.length === 0) {
        push(`${tagged}.cmd must be a non-empty string`);
        return null;
      }
      if (typeof code !== 'number' || !Number.isInteger(code)) {
        push(`${tagged}.code must be an integer`);
        return null;
      }
      return { type: 'exit_code', cmd, code };
    }
    default:
      // HARD_ASSERTION_TYPES set check above makes this unreachable, but TS exhaustiveness guard.
      push(`${tagged} unhandled type`);
      return null;
  }
}

function parseSoftAssertions(raw: unknown, push: (m: string) => void): SoftAssertion[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    push(`soft_assertions must be an array`);
    return [];
  }
  const out: SoftAssertion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const parsed = parseSoftAssertion(item, i, push);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseSoftAssertion(
  raw: unknown,
  idx: number,
  push: (m: string) => void
): SoftAssertion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    push(`soft_assertions[${idx}] must be a mapping`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const type = obj['type'];
  if (typeof type !== 'string' || !SOFT_ASSERTION_TYPES.has(type)) {
    push(`soft_assertions[${idx}].type "${String(type)}" is not a known soft assertion`);
    return null;
  }
  const weight = obj['weight'];
  if (typeof weight !== 'number' || !(weight > 0)) {
    push(`soft_assertions[${idx}].weight must be > 0`);
    return null;
  }
  const tagged = `soft_assertions[${idx}](${type})`;

  switch (type) {
    case 'final_text_min_len': {
      const chars = obj['chars'];
      if (typeof chars !== 'number' || !Number.isInteger(chars) || chars < 0) {
        push(`${tagged}.chars must be a non-negative integer`);
        return null;
      }
      return { type: 'final_text_min_len', chars, weight };
    }
    case 'tool_call_count_max': {
      const m = obj['max'];
      if (typeof m !== 'number' || !Number.isInteger(m) || m < 0) {
        push(`${tagged}.max must be a non-negative integer`);
        return null;
      }
      return { type: 'tool_call_count_max', max: m, weight };
    }
    case 'duration_max': {
      const ms = obj['ms'];
      if (typeof ms !== 'number' || !(ms > 0)) {
        push(`${tagged}.ms must be > 0`);
        return null;
      }
      return { type: 'duration_max', ms, weight };
    }
    case 'llm_judge': {
      const rubric = obj['rubric'];
      if (typeof rubric !== 'string' || rubric.length === 0) {
        push(`${tagged}.rubric must be a non-empty string`);
        return null;
      }
      return { type: 'llm_judge', rubric, weight };
    }
    case 'reference_match_ratio': {
      const ref = obj['ref'];
      if (typeof ref !== 'string' || ref.length === 0) {
        push(`${tagged}.ref must be a non-empty string`);
        return null;
      }
      return { type: 'reference_match_ratio', ref, weight };
    }
    case 'token_usage_max': {
      const m = obj['max'];
      if (typeof m !== 'number' || !(m > 0)) {
        push(`${tagged}.max must be > 0`);
        return null;
      }
      return { type: 'token_usage_max', max: m, weight };
    }
    default:
      push(`${tagged} unhandled type`);
      return null;
  }
}

// ─── Utilities ───

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function applyFilters(tasks: TaskDef[], options: LoadTasksOptions): TaskDef[] {
  let out = tasks;
  if (options.filterLevel) {
    out = out.filter((t) => t.level === options.filterLevel);
  }
  if (options.filterTask) {
    out = out.filter((t) => t.id === options.filterTask);
  }
  return out;
}

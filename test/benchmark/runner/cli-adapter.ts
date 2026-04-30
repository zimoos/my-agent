import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as yaml from 'js-yaml';

// ─── Types ───

export interface AdapterConfig {
  name: string;
  version?: string;
  underlyingModel: string;
  command: string;
  args: string[];
  timeoutSec: number;
  env?: Record<string, string>;
  finalAnswerMarker?: string;
}

export interface AdapterResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  finalAnswer: string;
  timedOut: boolean;
  elapsedMs: number;
}

// ─── Constants ───

const DEFAULT_FINAL_ANSWER_MARKER = '===FINAL_ANSWER===';
const FINAL_ANSWER_END_MARKER = '===END===';
const FINAL_ANSWER_TAIL_BYTES = 4 * 1024; // 4KB 兜底
const SIGKILL_GRACE_MS = 5_000; // SIGTERM → 5s → SIGKILL

// ─── loadAdapter ───

export function loadAdapter(yamlPath: string): AdapterConfig {
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`adapter yaml not found: ${yamlPath}`);
  }
  const text = fs.readFileSync(yamlPath, 'utf8');
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    throw new Error(`adapter yaml parse failed [${yamlPath}]: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`adapter yaml top-level must be a mapping: ${yamlPath}`);
  }
  const obj = raw as Record<string, unknown>;
  const loc = path.basename(yamlPath);

  const name = requireString(obj, 'name', loc);
  const underlyingModel = requireString(obj, 'underlying_model', loc);
  const command = requireString(obj, 'command', loc);

  const argsRaw = obj['args'];
  if (!Array.isArray(argsRaw) || !argsRaw.every((s) => typeof s === 'string')) {
    throw new Error(`[${loc}] args must be an array of strings`);
  }
  const args = argsRaw as string[];

  const timeoutRaw = obj['timeout_sec'];
  if (typeof timeoutRaw !== 'number' || !(timeoutRaw > 0)) {
    throw new Error(`[${loc}] timeout_sec must be a positive number`);
  }
  const timeoutSec = timeoutRaw;

  const config: AdapterConfig = {
    name,
    underlyingModel,
    command,
    args,
    timeoutSec,
  };

  if (obj['version'] !== undefined) {
    if (typeof obj['version'] !== 'string') {
      throw new Error(`[${loc}] version must be a string`);
    }
    config.version = obj['version'];
  }

  if (obj['env'] !== undefined) {
    const envRaw = obj['env'];
    if (!envRaw || typeof envRaw !== 'object' || Array.isArray(envRaw)) {
      throw new Error(`[${loc}] env must be a mapping of string→string`);
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`[${loc}] env.${k} must be a string`);
      }
      env[k] = v;
    }
    config.env = env;
  }

  if (obj['final_answer_marker'] !== undefined) {
    if (typeof obj['final_answer_marker'] !== 'string' || obj['final_answer_marker'].length === 0) {
      throw new Error(`[${loc}] final_answer_marker must be a non-empty string`);
    }
    config.finalAnswerMarker = obj['final_answer_marker'];
  }

  return config;
}

function requireString(obj: Record<string, unknown>, key: string, loc: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`[${loc}] field "${key}" must be a non-empty string`);
  }
  return v;
}

// ─── runAdapter ───

export async function runAdapter(
  config: AdapterConfig,
  prompt: string,
  workdir: string,
): Promise<AdapterResult> {
  const args = config.args.map((a) => substitute(a, { PROMPT: prompt, WORKDIR: workdir }));

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) {
      env[k] = substitute(v, { PROMPT: prompt, WORKDIR: workdir });
    }
  }

  const startedAt = Date.now();
  const child = spawn(config.command, args, {
    cwd: workdir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

  let timedOut = false;
  let sigkillTimer: NodeJS.Timeout | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    // SIGTERM 先给进程机会优雅退出
    child.kill('SIGTERM');
    sigkillTimer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, SIGKILL_GRACE_MS);
    if (sigkillTimer.unref) sigkillTimer.unref();
  }, config.timeoutSec * 1000);
  if (timeoutTimer.unref) timeoutTimer.unref();

  const exitCode = await new Promise<number>((resolve) => {
    // 用 close 而不是 exit,确保 stdio 流已读完
    child.once('close', (code, signal) => {
      clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (code !== null) resolve(code);
      else if (signal) resolve(128 + signalToNumber(signal));
      else resolve(-1);
    });
    child.once('error', () => {
      clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve(-1);
    });
  });

  const elapsedMs = Date.now() - startedAt;
  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  const finalAnswer = extractFinalAnswer(stdout, config.finalAnswerMarker);

  return { exitCode, stdout, stderr, finalAnswer, timedOut, elapsedMs };
}

// ─── Final answer extraction (三层策略) ───

export function extractFinalAnswer(stdout: string, marker?: string): string {
  const m = marker ?? DEFAULT_FINAL_ANSWER_MARKER;

  // 1. 标记提取:===FINAL_ANSWER===\n...\n===END===
  const startIdx = stdout.lastIndexOf(m);
  if (startIdx !== -1) {
    const afterStart = startIdx + m.length;
    const endIdx = stdout.indexOf(FINAL_ANSWER_END_MARKER, afterStart);
    const segment = endIdx !== -1 ? stdout.slice(afterStart, endIdx) : stdout.slice(afterStart);
    return segment.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  }

  // 2. 兜底:取 stdout 最后 4KB
  const buf = Buffer.from(stdout, 'utf8');
  if (buf.byteLength > FINAL_ANSWER_TAIL_BYTES) {
    return buf.subarray(buf.byteLength - FINAL_ANSWER_TAIL_BYTES).toString('utf8');
  }

  // 3. 全量
  return stdout;
}

// ─── Helpers ───

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) => {
    if (key in vars) return vars[key];
    return match;
  });
}

function signalToNumber(signal: NodeJS.Signals): number {
  // 粗略映射,超时 SIGTERM=15 / SIGKILL=9
  if (signal === 'SIGTERM') return 15;
  if (signal === 'SIGKILL') return 9;
  return 1;
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const ADAPTER_RUN_MARKER_ENV = 'MY_AGENT_ADAPTER_RUN_ID';

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
  const vars = { PROMPT: prompt, WORKDIR: workdir, REPO_ROOT };
  const args = config.args.map((a) => substitute(a, vars));

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) {
      env[k] = substitute(v, vars);
    }
  }
  const runMarker = randomUUID();
  env[ADAPTER_RUN_MARKER_ENV] = runMarker;

  const startedAt = Date.now();
  const child = spawn(config.command, args, {
    cwd: workdir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

  let timedOut = false;
  let sigkillTimer: NodeJS.Timeout | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    signalAdapterProcesses(child, runMarker, 'SIGTERM');
    sigkillTimer = setTimeout(() => {
      signalAdapterProcesses(child, runMarker, 'SIGKILL');
    }, SIGKILL_GRACE_MS);
    if (sigkillTimer.unref) sigkillTimer.unref();
  }, config.timeoutSec * 1000);
  if (timeoutTimer.unref) timeoutTimer.unref();

  const exitCode = await new Promise<number>((resolve) => {
    child.once('exit', () => {
      // Descendants can escape their parent's session before it exits.
      signalAdapterProcesses(child, runMarker, 'SIGKILL');
    });
    // 用 close 而不是 exit,确保 stdio 流已读完
    child.once('close', (code, signal) => {
      clearTimeout(timeoutTimer);
      signalAdapterProcesses(child, runMarker, 'SIGKILL');
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (code !== null) resolve(code);
      else if (signal) resolve(128 + signalToNumber(signal));
      else resolve(-1);
    });
    child.once('error', () => {
      clearTimeout(timeoutTimer);
      signalAdapterProcesses(child, runMarker, 'SIGKILL');
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
    if (process.env[key]) return process.env[key]!;
    return match;
  });
}

function signalToNumber(signal: NodeJS.Signals): number {
  // 粗略映射,超时 SIGTERM=15 / SIGKILL=9
  if (signal === 'SIGTERM') return 15;
  if (signal === 'SIGKILL') return 9;
  return 1;
}

function signalAdapterProcesses(child: ChildProcess, marker: string, signal: NodeJS.Signals): void {
  signalDirectChildAndGroup(child, signal);
  signalMarkedAdapterProcesses(marker, signal);
}

function signalDirectChildAndGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      // The detached child is its own process-group leader. This path must not
      // depend on process enumeration, which can fail when PATH is restricted.
      process.kill(-child.pid, signal);
    } catch {
      // It may have already exited or not established its group yet.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The direct child may exit between the group signal and this fallback.
  }
}

function signalMarkedAdapterProcesses(marker: string, signal: NodeJS.Signals): void {
  const markerAssignment = `${ADAPTER_RUN_MARKER_ENV}=${marker}`;
  let argvByPid: Map<number, string>;
  let environmentByPid: Map<number, string>;
  try {
    // Compare plain argv with `ps e` output. On macOS `ps e` appends the
    // environment to the command text, so a simple substring would also match
    // a marker supplied only as an argv argument.
    argvByPid = readProcessCommands(['ww', '-axo', 'pid=,command=']);
    environmentByPid = readProcessCommands(['eww', '-axo', 'pid=,command=']);
  } catch {
    return;
  }

  for (const [pid, commandWithEnvironment] of environmentByPid) {
    const argv = argvByPid.get(pid);
    if (!argv || !environmentContains(commandWithEnvironment, argv, markerAssignment)) continue;
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // Processes can exit between enumeration and signalling.
    }
  }
}

function readProcessCommands(args: string[]): Map<number, string> {
  const output = execFileSync('ps', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const commands = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid)) commands.set(pid, match[2]);
  }
  return commands;
}

function environmentContains(commandWithEnvironment: string, argv: string, markerAssignment: string): boolean {
  if (!commandWithEnvironment.startsWith(argv)) return false;
  const environment = commandWithEnvironment.slice(argv.length).trimStart();
  return environment.split(/\s+/).includes(markerAssignment);
}

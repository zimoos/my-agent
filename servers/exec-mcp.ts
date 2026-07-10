#!/usr/bin/env node
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { compressOutput } from './compress/index.js';

const MAX_OUTPUT = 200000;
const MAX_MANAGED_LOG = 1000000;
const TRUNCATE_NOTICE = '\n\n[...原始输出过长，已截断。建议用 head/tail/grep 筛选]';
const SIGKILL_DELAY_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_READY_TIMEOUT_MS = 30000;
const PROCESS_POLL_MS = 25;
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'exec-mcp', version: '3.0.0' };
const USE_PROCESS_GROUPS = process.platform !== 'win32';
const EXECUTION_SCOPE_ENV = 'MY_AGENT_EXEC_SCOPE';
type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable>;

interface JsonRpcRequest { jsonrpc: '2.0'; id?: number | string; method: string; params?: any; }
interface JsonRpcResponse { jsonrpc: '2.0'; id: number | string; result?: any; error?: { code: number; message: string; data?: any }; }

const EXECUTE_COMMAND_TOOL = {
  name: 'execute_command',
  description: 'Execute a shell command and return a structured outcome with the legacy text output',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (optional)' },
      timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
    },
    required: ['command'],
  },
};

const START_PROCESS_TOOL = {
  name: 'start_process',
  description: 'Start a managed command in an isolated process group',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to start' },
      cwd: { type: 'string', description: 'Working directory (optional)' },
      readyPattern: { type: 'string', description: 'Regular expression matched against combined output before returning' },
      readyTimeout: { type: 'number', description: 'Readiness timeout in ms (default 30000)' },
    },
    required: ['command'],
  },
};

function processIdSchema(description: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: { processId: { type: 'string', description } },
    required: ['processId'],
  };
}

const GET_PROCESS_TOOL = {
  name: 'get_process',
  description: 'Get the current state of a managed process',
  inputSchema: processIdSchema('Managed process id'),
};

const READ_PROCESS_LOGS_TOOL = {
  name: 'read_process_logs',
  description: 'Read managed process output from a monotonic cursor',
  inputSchema: {
    type: 'object',
    properties: {
      processId: { type: 'string', description: 'Managed process id' },
      cursor: { type: 'number', description: 'Absolute log cursor (default 0)' },
    },
    required: ['processId'],
  },
};

const STOP_PROCESS_TOOL = {
  name: 'stop_process',
  description: 'Stop a managed process group with SIGTERM followed by SIGKILL if needed',
  inputSchema: processIdSchema('Managed process id'),
};

const TOOLS = [
  EXECUTE_COMMAND_TOOL,
  START_PROCESS_TOOL,
  GET_PROCESS_TOOL,
  READ_PROCESS_LOGS_TOOL,
  STOP_PROCESS_TOOL,
];

function logErr(...args: unknown[]): void {
  process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
}
function send(msg: JsonRpcResponse): void { process.stdout.write(JSON.stringify(msg) + '\n'); }
function sendError(id: number | string, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGroupAlive(pid: number, proc?: SpawnedProcess): boolean {
  try {
    if (USE_PROCESS_GROUPS) process.kill(-pid, 0);
    else if (proc) process.kill(pid, 0);
    else process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(
  pid: number,
  signal: NodeJS.Signals,
  proc?: SpawnedProcess,
): boolean {
  try {
    if (USE_PROCESS_GROUPS) process.kill(-pid, signal);
    else if (proc) proc.kill(signal);
    else process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForGroupExit(
  pid: number,
  timeoutMs: number,
  proc?: SpawnedProcess,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isGroupAlive(pid, proc)) return true;
    await delay(PROCESS_POLL_MS);
  }
  return !isGroupAlive(pid, proc);
}

async function terminateGroup(
  pid: number,
  proc?: SpawnedProcess,
  forceAfterMs = SIGKILL_DELAY_MS,
): Promise<boolean> {
  if (!isGroupAlive(pid, proc)) return false;
  signalGroup(pid, 'SIGTERM', proc);
  if (await waitForGroupExit(pid, forceAfterMs, proc)) return false;
  signalGroup(pid, 'SIGKILL', proc);
  await waitForGroupExit(pid, 1000, proc);
  return true;
}

function psCommandLines(includeEnvironment: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ps',
      [includeEnvironment ? 'eww' : '-ww', '-ax', '-o', 'pid=', '-o', 'command='],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '';
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    proc.once('error', reject);
    proc.once('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`ps exited with code ${code}`));
    });
  });
}

function psCommandsByPid(output: string): Map<number, string> {
  const commands = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]);
  }
  return commands;
}

function hasEnvironmentMarker(environment: string, marker: string): boolean {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escapedMarker}(?=\\s|$)`).test(environment);
}

async function scopedProcessIds(scope: string): Promise<number[]> {
  const marker = `${EXECUTION_SCOPE_ENV}=${scope}`;
  if (process.platform === 'linux') {
    const entries = await readdir('/proc', { withFileTypes: true });
    const matches = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        try {
          const environment = await readFile(`/proc/${entry.name}/environ`, 'utf8');
          return environment.split('\0').includes(marker) ? Number(entry.name) : undefined;
        } catch {
          return undefined;
        }
      }));
    return matches.filter((pid): pid is number => pid !== undefined);
  }
  if (process.platform === 'darwin') {
    const [commandsOutput, environmentsOutput] = await Promise.all([
      psCommandLines(false),
      psCommandLines(true),
    ]);
    const commands = psCommandsByPid(commandsOutput);
    return [...psCommandsByPid(environmentsOutput)].flatMap(([pid, commandAndEnvironment]) => {
      const command = commands.get(pid);
      // `ps eww` appends the environment to argv. Match only after the exact argv prefix.
      if (!command || !commandAndEnvironment.startsWith(command)) return [];
      const environment = commandAndEnvironment.slice(command.length).trimStart();
      return hasEnvironmentMarker(environment, marker) ? [pid] : [];
    });
  }
  return [];
}

function signalProcesses(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

async function waitForScopedExit(scope: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await scopedProcessIds(scope)).length === 0) return true;
    await delay(PROCESS_POLL_MS);
  }
  return (await scopedProcessIds(scope)).length === 0;
}

interface ScopeCleanupResult {
  forced: boolean;
  scopeVerified: boolean;
  usedGroupFallback: boolean;
  error?: string;
}

function scopeCleanupMetadata(result: ScopeCleanupResult): Record<string, unknown> {
  return {
    cleanup: {
      scope: result.scopeVerified ? 'verified' : 'unverified',
      processGroupFallback: result.usedGroupFallback,
      ...(result.error ? { error: result.error } : {}),
    },
  };
}

async function terminateScopedProcesses(
  scope: string,
  fallbackPid?: number,
  fallbackProc?: SpawnedProcess,
): Promise<ScopeCleanupResult> {
  try {
    const pids = await scopedProcessIds(scope);
    if (pids.length === 0) {
      return { forced: false, scopeVerified: true, usedGroupFallback: false };
    }
    signalProcesses(pids, 'SIGTERM');
    if (await waitForScopedExit(scope, SIGKILL_DELAY_MS)) {
      return { forced: false, scopeVerified: true, usedGroupFallback: false };
    }
    signalProcesses(await scopedProcessIds(scope), 'SIGKILL');
    return {
      forced: true,
      scopeVerified: await waitForScopedExit(scope, 1000),
      usedGroupFallback: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logErr('scoped process cleanup failed:', message);
    if (fallbackPid === undefined) {
      return {
        forced: false,
        scopeVerified: false,
        usedGroupFallback: false,
        error: message,
      };
    }
    try {
      const forced = await terminateGroup(fallbackPid, fallbackProc);
      const groupStopped = !isGroupAlive(fallbackPid, fallbackProc);
      return {
        forced,
        scopeVerified: false,
        usedGroupFallback: true,
        error: groupStopped ? message : `${message}; process group is still alive`,
      };
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      logErr('process group fallback cleanup failed:', fallbackPid, fallbackMessage);
      return {
        forced: false,
        scopeVerified: false,
        usedGroupFallback: true,
        error: `${message}; process group fallback failed: ${fallbackMessage}`,
      };
    }
  }
}

interface ExecArgs { command: string; cwd?: string; timeout?: number; }
interface CommandOutcome {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  output: string;
  text: string;
  truncated: boolean;
  forced?: boolean;
  error?: string;
}

function appendLimited(current: string, chunk: string): { value: string; truncated: boolean } {
  if (current.length >= MAX_OUTPUT) return { value: current, truncated: true };
  const remaining = MAX_OUTPUT - current.length;
  return chunk.length > remaining
    ? { value: current + chunk.slice(0, remaining), truncated: true }
    : { value: current + chunk, truncated: false };
}

function parseJsonQuotedCommand(command: string): string[] | undefined {
  const args: string[] = [];
  let sawJsonString = false;
  let index = 0;
  while (index < command.length) {
    while (/\s/.test(command[index] ?? '')) index++;
    if (index >= command.length) break;
    if (command[index] === '"') {
      const start = index;
      let escaped = false;
      index++;
      while (index < command.length) {
        const char = command[index++];
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') break;
      }
      if (command[index - 1] !== '"' || (index < command.length && !/\s/.test(command[index]))) {
        return undefined;
      }
      try { args.push(JSON.parse(command.slice(start, index)) as string); }
      catch { return undefined; }
      sawJsonString = true;
      continue;
    }
    const start = index;
    while (index < command.length && !/\s/.test(command[index])) index++;
    const arg = command.slice(start, index);
    if (!arg || /["'\\|&;<>()$`*?\[\]{}~]/.test(arg)) return undefined;
    args.push(arg);
  }
  return sawJsonString && args.length > 0 ? args : undefined;
}

function spawnCommand(command: string, cwd: string, scope: string): SpawnedProcess {
  const literalArgs = parseJsonQuotedCommand(command);
  const executable = literalArgs?.[0] ?? 'bash';
  const args = literalArgs ? literalArgs.slice(1) : ['-c', command];
  return spawn(executable, args, {
    cwd,
    detached: USE_PROCESS_GROUPS,
    env: { ...process.env, LANG: 'en_US.UTF-8', [EXECUTION_SCOPE_ENV]: scope },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runCommand(args: ExecArgs): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const timeout = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS;
    const cwd = args.cwd || process.cwd();
    let stdout = '';
    let stderr = '';
    let combined = '';
    let truncated = false;
    let timedOut = false;
    let forced = false;
    let settled = false;
    let termination: Promise<boolean> | null = null;
    const scope = randomUUID();

    let proc: SpawnedProcess;
    try {
      proc = spawnCommand(args.command, cwd, scope);
    } catch (error) {
      const message = `命令启动失败: ${error instanceof Error ? error.message : String(error)}`;
      resolve({
        ok: false, exitCode: null, signal: null, timedOut: false,
        stdout: '', stderr: '', output: message, text: message, truncated: false, error: message,
      });
      return;
    }
    if (proc.pid === undefined) {
      proc.once('error', () => undefined);
      const message = '命令启动失败: child process did not receive a pid';
      resolve({
        ok: false, exitCode: null, signal: null, timedOut: false,
        stdout: '', stderr: '', output: message, text: message, truncated: false, error: message,
      });
      return;
    }
    const pid = proc.pid;

    const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const streamResult = appendLimited(stream === 'stdout' ? stdout : stderr, value);
      if (stream === 'stdout') stdout = streamResult.value;
      else stderr = streamResult.value;
      const combinedResult = appendLimited(combined, value);
      combined = combinedResult.value;
      truncated ||= streamResult.truncated || combinedResult.truncated;
    };
    proc.stdout.on('data', (chunk) => append('stdout', chunk));
    proc.stderr.on('data', (chunk) => append('stderr', chunk));

    const termTimer = setTimeout(() => {
      timedOut = true;
      termination = terminateGroup(pid, proc).then((wasForced) => {
        forced = wasForced;
        return wasForced;
      });
    }, timeout);

    const settle = async (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      if (termination) await termination;
      const scopeCleanup = await terminateScopedProcesses(scope, pid, proc);
      forced ||= scopeCleanup.forced;
      const finalCombined = truncated ? combined + TRUNCATE_NOTICE : combined;
      let legacyText: string;
      if (spawnError) {
        legacyText = `命令启动失败: ${spawnError.message}`;
      } else if (!scopeCleanup.scopeVerified) {
        const message = `命令执行完成，但进程清理未验证: ${scopeCleanup.error ?? 'scope enumeration failed'}`;
        legacyText = finalCombined.length > 0 ? `${message}\n\n${finalCombined}` : message;
      } else if (timedOut) {
        const message = forced
          ? `命令被强制终止（超时 ${timeout}ms 后未响应 SIGTERM）`
          : `命令执行超时（${timeout}ms）。建议缩小命令范围或增加超时时间。`;
        legacyText = finalCombined.length > 0 ? `${message}\n\n${finalCombined}` : message;
      } else if (code !== 0 && code !== null) {
        const snippet = finalCombined.slice(0, 200);
        legacyText = `命令失败（退出码 ${code}）\n${snippet}${finalCombined.length > 200 ? '\n...' : ''}`;
      } else if (signal) {
        legacyText = `命令被信号终止: ${signal}\n${finalCombined}`;
      } else {
        legacyText = finalCombined;
      }
      const text = compressOutput(args.command, legacyText);
      resolve({
        ok: !spawnError && scopeCleanup.scopeVerified && !timedOut && code === 0 && signal === null,
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
        output: text,
        text,
        truncated,
        ...scopeCleanupMetadata(scopeCleanup),
        ...(forced ? { forced: true } : {}),
        ...(spawnError
          ? { error: spawnError.message }
          : !scopeCleanup.scopeVerified
            ? { error: `process cleanup could not be verified: ${scopeCleanup.error ?? 'scope enumeration failed'}` }
            : {}),
      });
    };

    proc.once('error', (error) => { void settle(null, null, error); });
    proc.once('close', (code, signal) => { void settle(code, signal); });
  });
}

type ManagedStatus = 'running' | 'exited' | 'stopped';
interface ManagedProcess {
  processId: string;
  pid: number;
  command: string;
  cwd: string;
  scope: string;
  proc: SpawnedProcess;
  status: ManagedStatus;
  ready: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  endedAt: string | null;
  logs: string;
  logBaseCursor: number;
  nextCursor: number;
  stdout: string;
  stderr: string;
  stopRequested: boolean;
  stopPromise: Promise<ScopeCleanupResult> | null;
  scopeCleanup: Promise<ScopeCleanupResult> | null;
  readinessCheck?: () => void;
}

const managedProcesses = new Map<string, ManagedProcess>();

function appendManagedLog(record: ManagedProcess, stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
  const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  record.logs += value;
  record.nextCursor += value.length;
  if (record.logs.length > MAX_MANAGED_LOG) {
    const overflow = record.logs.length - MAX_MANAGED_LOG;
    record.logs = record.logs.slice(overflow);
    record.logBaseCursor += overflow;
  }
  const streamResult = appendLimited(stream === 'stdout' ? record.stdout : record.stderr, value);
  if (stream === 'stdout') record.stdout = streamResult.value;
  else record.stderr = streamResult.value;
  record.readinessCheck?.();
}

function processPayload(record: ManagedProcess): Record<string, unknown> {
  return {
    processId: record.processId,
    pid: record.pid,
    command: record.command,
    cwd: record.cwd,
    status: record.status,
    ready: record.ready,
    exitCode: record.exitCode,
    signal: record.signal,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    stdout: record.stdout,
    stderr: record.stderr,
  };
}

function actionEvidence(
  operation: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const id = randomUUID();
  return {
    id,
    evidenceId: id,
    tool: `exec-mcp__${operation}`,
    server: 'exec-mcp',
    toolName: operation,
    operation,
    status: 'verified',
    ...metadata,
  };
}

function withEvidence(
  payload: Record<string, unknown>,
  operation: string,
  metadata: Record<string, unknown> = payload,
): Record<string, unknown> {
  return {
    ...payload,
    'my-agent/evidence': actionEvidence(operation, metadata),
  };
}

function toolResult(
  payload: Record<string, unknown>,
  isError = false,
  text = JSON.stringify(payload),
): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload,
    isError,
  };
}

function errorResult(message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return toolResult({ ok: false, error: message, ...extra }, true);
}

function readProcessId(args: any): string | undefined {
  return typeof args?.processId === 'string' && args.processId.length > 0 ? args.processId : undefined;
}

async function stopManagedProcess(record: ManagedProcess): Promise<ScopeCleanupResult> {
  if (record.stopPromise) return record.stopPromise;
  record.stopRequested = true;
  record.stopPromise = (async () => {
    const forced = await terminateGroup(record.pid, record.proc);
    const scopeCleanup = await cleanupManagedScope(record);
    record.status = 'stopped';
    record.endedAt ??= new Date().toISOString();
    return { ...scopeCleanup, forced: forced || scopeCleanup.forced };
  })();
  return record.stopPromise;
}

async function cleanupManagedScope(record: ManagedProcess): Promise<ScopeCleanupResult> {
  record.scopeCleanup ??= terminateScopedProcesses(record.scope, record.pid, record.proc);
  return record.scopeCleanup;
}

function waitForReadiness(
  record: ManagedProcess,
  pattern: RegExp,
  timeoutMs: number,
): Promise<{ ready: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ready: boolean; reason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete record.readinessCheck;
      resolve(result);
    };
    record.readinessCheck = () => {
      pattern.lastIndex = 0;
      if (pattern.test(record.logs)) {
        record.ready = true;
        finish({ ready: true });
      } else if (record.status !== 'running') {
        finish({ ready: false, reason: `process exited before readiness (${record.status})` });
      }
    };
    const timer = setTimeout(
      () => finish({ ready: false, reason: `readiness pattern not observed within ${timeoutMs}ms` }),
      timeoutMs,
    );
    record.readinessCheck();
  });
}

async function startProcess(args: any): Promise<Record<string, unknown>> {
  if (!args.command || typeof args.command !== 'string' || args.command.trim().length === 0) {
    return errorResult('请提供要执行的命令，例如: start_process(command: "npm run dev")');
  }
  const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : process.cwd();
  const readyPattern = typeof args.readyPattern === 'string' && args.readyPattern.length > 0
    ? args.readyPattern
    : undefined;
  const readyTimeout = typeof args.readyTimeout === 'number' && args.readyTimeout > 0
    ? args.readyTimeout
    : DEFAULT_READY_TIMEOUT_MS;
  let pattern: RegExp | undefined;
  if (readyPattern) {
    try { pattern = new RegExp(readyPattern, 'm'); }
    catch (error) {
      return errorResult(`invalid readyPattern: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let proc: SpawnedProcess;
  const scope = randomUUID();
  try {
    proc = spawnCommand(args.command, cwd, scope);
  } catch (error) {
    return errorResult(`process failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (proc.pid === undefined) {
    proc.once('error', () => undefined);
    return errorResult('process failed to start: child process did not receive a pid');
  }
  const pid = proc.pid;

  const record: ManagedProcess = {
    processId: randomUUID(),
    pid,
    command: args.command,
    cwd,
    scope,
    proc,
    status: 'running',
    ready: !pattern,
    exitCode: null,
    signal: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    logs: '',
    logBaseCursor: 0,
    nextCursor: 0,
    stdout: '',
    stderr: '',
    stopRequested: false,
    stopPromise: null,
    scopeCleanup: null,
  };
  managedProcesses.set(record.processId, record);
  proc.stdout.on('data', (chunk) => appendManagedLog(record, 'stdout', chunk));
  proc.stderr.on('data', (chunk) => appendManagedLog(record, 'stderr', chunk));
  proc.once('error', (error) => {
    appendManagedLog(record, 'stderr', `process error: ${error.message}\n`);
    record.status = record.stopRequested ? 'stopped' : 'exited';
    record.endedAt = new Date().toISOString();
    record.readinessCheck?.();
    void cleanupManagedScope(record).catch((cleanupError) => {
      logErr('managed process scope cleanup failed:', record.processId, cleanupError);
    });
  });
  proc.once('close', (code, signal) => {
    record.exitCode = code;
    record.signal = signal;
    record.status = record.stopRequested ? 'stopped' : 'exited';
    record.endedAt = new Date().toISOString();
    record.readinessCheck?.();
    void cleanupManagedScope(record).catch((cleanupError) => {
      logErr('managed process scope cleanup failed:', record.processId, cleanupError);
    });
  });

  if (!pattern) {
    const payload = { ok: true, ...processPayload(record) };
    return toolResult(withEvidence(payload, 'start_process'));
  }
  const readiness = await waitForReadiness(record, pattern, readyTimeout);
  if (readiness.ready) {
    const payload = { ok: true, ...processPayload(record) };
    return toolResult(withEvidence(payload, 'start_process'));
  }
  const cleanup = await stopManagedProcess(record);
  return errorResult(
    readiness.reason ?? 'process did not become ready',
    { ...processPayload(record), ...scopeCleanupMetadata(cleanup) },
  );
}

async function getProcess(args: any): Promise<Record<string, unknown>> {
  const processId = readProcessId(args);
  if (!processId) return errorResult('processId is required');
  const record = managedProcesses.get(processId);
  if (!record) return errorResult(`unknown managed process: ${processId}`, { processId });
  return toolResult({ ok: true, ...processPayload(record) });
}

async function readProcessLogs(args: any): Promise<Record<string, unknown>> {
  const processId = readProcessId(args);
  if (!processId) return errorResult('processId is required');
  const record = managedProcesses.get(processId);
  if (!record) return errorResult(`unknown managed process: ${processId}`, { processId });
  const requestedCursor = typeof args.cursor === 'number' && Number.isInteger(args.cursor) && args.cursor >= 0
    ? args.cursor
    : 0;
  const effectiveCursor = Math.min(Math.max(requestedCursor, record.logBaseCursor), record.nextCursor);
  const logs = record.logs.slice(effectiveCursor - record.logBaseCursor);
  return toolResult({
    ok: true,
    processId,
    logs,
    cursor: requestedCursor,
    nextCursor: record.nextCursor,
    truncated: requestedCursor < record.logBaseCursor,
    status: record.status,
  });
}

async function stopProcess(args: any): Promise<Record<string, unknown>> {
  const processId = readProcessId(args);
  if (!processId) return errorResult('processId is required');
  const record = managedProcesses.get(processId);
  if (!record) return errorResult(`unknown managed process: ${processId}`, { processId });
  const alreadyStopped = record.stopRequested && !isGroupAlive(record.pid, record.proc);
  const cleanup = alreadyStopped
    ? await cleanupManagedScope(record)
    : await stopManagedProcess(record);
  const payload = {
    ok: cleanup.scopeVerified,
    ...processPayload(record),
    status: alreadyStopped ? 'already_stopped' : record.status,
    ...scopeCleanupMetadata(cleanup),
    ...(!cleanup.scopeVerified
      ? { error: `process cleanup could not be verified: ${cleanup.error ?? 'scope enumeration failed'}` }
      : {}),
  };
  return toolResult(
    cleanup.scopeVerified ? withEvidence(payload, 'stop_process') : payload,
    !cleanup.scopeVerified,
  );
}

async function handleToolsCall(params: any): Promise<any> {
  const name = params?.name;
  const args = params?.arguments || {};
  switch (name) {
    case 'execute_command': {
      if (!args.command || typeof args.command !== 'string' || args.command.trim().length === 0) {
        return errorResult('请提供要执行的命令，例如: execute_command(command: "ls -la")');
      }
      const outcome = await runCommand({
        command: args.command,
        cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
        timeout: typeof args.timeout === 'number' ? args.timeout : undefined,
      });
      const payload = outcome as unknown as Record<string, unknown>;
      return toolResult(
        outcome.ok ? withEvidence(payload, 'execute_command') : payload,
        !outcome.ok,
        outcome.text,
      );
    }
    case 'start_process': return startProcess(args);
    case 'get_process': return getProcess(args);
    case 'read_process_logs': return readProcessLogs(args);
    case 'stop_process': return stopProcess(args);
    default: return errorResult(`unknown tool "${name}"`);
  }
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  if (req.method === 'notifications/initialized') return;
  if (req.id === undefined) return;
  try {
    switch (req.method) {
      case 'initialize':
        send({ jsonrpc: '2.0', id: req.id, result: {
          protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO,
        }});
        return;
      case 'tools/list':
        send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
        return;
      case 'tools/call': {
        const result = await handleToolsCall(req.params);
        send({ jsonrpc: '2.0', id: req.id, result });
        return;
      }
      default:
        sendError(req.id, -32601, `Method not found: ${req.method}`);
    }
  } catch (e) {
    sendError(req.id, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function cleanupManagedProcesses(): Promise<void> {
  await Promise.all([...managedProcesses.values()].map(async (record) => {
    try { await stopManagedProcess(record); }
    catch (error) { logErr('managed process cleanup failed:', record.processId, error); }
  }));
}

function main(): void {
  const rl = createInterface({ input: process.stdin });
  let pending = 0;
  let stdinClosed = false;
  let shutdownPromise: Promise<never> | null = null;

  const shutdown = (exitCode: number): Promise<never> => {
    shutdownPromise ??= (async () => {
      await cleanupManagedProcesses();
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };
  const maybeExit = () => {
    if (stdinClosed && pending === 0) void shutdown(0);
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try { req = JSON.parse(trimmed); }
    catch (e) { logErr('parse error:', (e as Error).message); return; }
    pending++;
    handleRequest(req)
      .catch((e) => logErr('unhandled error:', e instanceof Error ? e.message : String(e)))
      .finally(() => { pending--; maybeExit(); });
  });
  rl.on('close', () => { stdinClosed = true; maybeExit(); });
  process.on('SIGTERM', () => { void shutdown(0); });
  process.on('SIGINT', () => { void shutdown(0); });
  process.on('exit', () => {
    for (const record of managedProcesses.values()) {
      if (isGroupAlive(record.pid, record.proc)) signalGroup(record.pid, 'SIGKILL', record.proc);
    }
  });
}

main();

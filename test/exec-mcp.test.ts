import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, test } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const EXEC_SERVER = join(REPO_ROOT, 'servers', 'exec-mcp.ts');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const REQUEST_TIMEOUT_MS = 5_000;

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolDefinition {
  name: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface StartedProcess {
  processId: string;
  pid?: number;
}

const liveServers = new Set<ExecMcpServer>();
const tempDirs = new Set<string>();

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail(message);
}

function killProcessGroup(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

class ExecMcpServer {
  readonly proc: ChildProcess;
  readonly stderr: string[] = [];
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(envOverrides: NodeJS.ProcessEnv = {}) {
    this.proc = spawn(process.execPath, [TSX_CLI, EXEC_SERVER], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LANG: 'en_US.UTF-8', ...envOverrides },
    });

    const lines = createInterface({ input: this.proc.stdout! });
    lines.on('line', (line) => {
      let response: RpcResponse;
      try {
        response = JSON.parse(line) as RpcResponse;
      } catch {
        return;
      }
      if (typeof response.id !== 'number') return;
      const request = this.pending.get(response.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(response.id);
      if (response.error) request.reject(new Error(response.error.message));
      else request.resolve(response.result);
    });
    this.proc.stderr!.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString('utf8')));
    this.proc.once('exit', (code, signal) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(
          new Error(`exec-mcp exited before responding (code=${code}, signal=${signal})`),
        );
      }
      this.pending.clear();
    });
  }

  request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(
          new Error(
            `Timed out waiting for ${method}; stderr=${this.stderr.join('').trim() || '<empty>'}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'exec-mcp-integration-test', version: '1.0.0' },
    });
    this.proc.stdin!.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
  }

  async tools(): Promise<ToolDefinition[]> {
    const result = (await this.request('tools/list')) as { tools: ToolDefinition[] };
    return result.tools;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    return (await this.request('tools/call', { name, arguments: args }, 10_000)) as ToolCallResult;
  }

  async close(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      await this.shutdownServerOnly(signal);
    }
    killProcessGroup(this.proc);
  }

  async shutdownServerOnly(signal: NodeJS.Signals): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    const exited = new Promise<void>((resolveExit) => this.proc.once('exit', () => resolveExit()));
    this.proc.kill(signal);
    await Promise.race([exited, delay(2_000)]);
  }
}

async function createServer(envOverrides: NodeJS.ProcessEnv = {}): Promise<ExecMcpServer> {
  const server = new ExecMcpServer(envOverrides);
  liveServers.add(server);
  await server.initialize();
  return server;
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'my-agent-exec-mcp-'));
  tempDirs.add(dir);
  return dir;
}

function textContent(result: ToolCallResult): string {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}

function structuredContent(result: ToolCallResult): Record<string, unknown> {
  assert.ok(
    result.structuredContent,
    'tool metadata must be carried by structuredContent instead of replacing human text content',
  );
  return result.structuredContent;
}

function verifiedEvidence(
  value: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  const evidence = value['my-agent/evidence'];
  assert.ok(
    evidence && typeof evidence === 'object' && !Array.isArray(evidence),
    'successful action metadata must include structuredContent["my-agent/evidence"]',
  );
  const record = evidence as Record<string, unknown>;
  assert.equal(record.operation, operation);
  assert.equal(record.status, 'verified');
  return record;
}

function readString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'string') return value[key] as string;
  }
  return undefined;
}

function readNumber(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'number') return value[key] as number;
  }
  return undefined;
}

function processIdFrom(value: Record<string, unknown>): string {
  const id = readString(value, 'processId', 'process_id', 'id');
  assert.ok(id, 'managed process result must include a stable process id');
  return id;
}

function processIdArgument(tool: ToolDefinition, processId: string): Record<string, string> {
  const properties = tool.inputSchema?.properties ?? {};
  const key = ['processId', 'process_id', 'id'].find((candidate) => candidate in properties);
  assert.ok(key, `${tool.name} schema must declare a process id argument`);
  return { [key]: processId };
}

function readinessArguments(tool: ToolDefinition, pattern: string): Record<string, unknown> {
  const properties = tool.inputSchema?.properties ?? {};
  if ('readyPattern' in properties) {
    return {
      readyPattern: pattern,
      ...('readyTimeout' in properties ? { readyTimeout: 5_000 } : {}),
    };
  }
  if ('readinessPattern' in properties) {
    return {
      readinessPattern: pattern,
      ...('readinessTimeout' in properties ? { readinessTimeout: 5_000 } : {}),
    };
  }
  if ('readiness' in properties) {
    return { readiness: { pattern, timeout: 5_000 } };
  }
  assert.fail('start_process schema must expose output-based readiness configuration');
}

function cursorArgument(tool: ToolDefinition, cursor: number): Record<string, number> {
  const properties = tool.inputSchema?.properties ?? {};
  const key = ['cursor', 'fromCursor', 'from_cursor'].find((candidate) => candidate in properties);
  assert.ok(key, 'read_process_logs schema must declare a log cursor argument');
  return { [key]: cursor };
}

function logText(value: Record<string, unknown>): string {
  const direct = readString(value, 'logs', 'text', 'output');
  if (direct !== undefined) return direct;
  return [readString(value, 'stdout') ?? '', readString(value, 'stderr') ?? ''].join('');
}

function nextCursor(value: Record<string, unknown>): number {
  const cursor = readNumber(value, 'nextCursor', 'next_cursor', 'cursor');
  assert.notEqual(cursor, undefined, 'log result must include the next cursor');
  assert.ok(Number.isInteger(cursor) && cursor! >= 0, 'log cursor must be a non-negative integer');
  return cursor!;
}

async function stopBestEffort(
  server: ExecMcpServer,
  stopTool: ToolDefinition,
  processId: string,
): Promise<void> {
  try {
    await server.call(stopTool.name, processIdArgument(stopTool, processId));
  } catch {
    // The server process group cleanup below is the final safety net.
  }
}

interface EscapedProcessReadiness {
  pid: number;
  port: number;
}

async function readEscapedReadiness(
  file: string,
  timeoutMs = 2_000,
): Promise<EscapedProcessReadiness | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<EscapedProcessReadiness>;
      if (Number.isInteger(parsed.pid) && Number.isInteger(parsed.port)) {
        return { pid: parsed.pid!, port: parsed.port! };
      }
    } catch {
      // The child writes this file only after listen() succeeds.
    }
    await delay(25);
  }
  return undefined;
}

async function canBind(port: number): Promise<boolean> {
  const server = net.createServer();
  return await new Promise<boolean>((resolveBind) => {
    server.once('error', () => resolveBind(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolveBind(true));
    });
  });
}

async function waitForPortRelease(port: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBind(port)) return true;
    await delay(25);
  }
  return canBind(port);
}

async function killEscapedBestEffort(pid: number): Promise<void> {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        // Keep cleanup best-effort: the other target may still be valid.
      }
    }
  }
}

async function writeFixedUuidPreload(dir: string, uuid: string): Promise<string> {
  const preload = join(dir, 'fixed-random-uuid.cjs');
  await writeFile(
    preload,
    [
      "const crypto = require('node:crypto');",
      `crypto.randomUUID = () => ${JSON.stringify(uuid)};`,
      "require('node:module').syncBuiltinESMExports();",
    ].join('\n'),
  );
  return preload;
}

afterEach(async () => {
  await Promise.all([...liveServers].map((server) => server.close()));
  liveServers.clear();
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

test('exec-mcp advertises synchronous and managed process tools', async () => {
  const server = await createServer();
  const names = (await server.tools()).map((tool) => tool.name).sort();

  for (const requiredName of [
    'execute_command',
    'get_process',
    'read_process_logs',
    'start_process',
    'stop_process',
  ]) {
    assert.ok(names.includes(requiredName), `tools/list must advertise ${requiredName}`);
  }
});

test('execute_command returns a structured outcome for success and command failure', async () => {
  const server = await createServer();
  const dir = await createTempDir();

  const successResult = await server.call('execute_command', {
    command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('success-out'); process.stderr.write('success-err')"`,
    cwd: dir,
  });
  const success = structuredContent(successResult);
  assert.equal(successResult.isError, false);
  assert.equal(success.ok, true);
  assert.equal(success.exitCode, 0);
  assert.equal(success.signal, null);
  assert.equal(success.timedOut, false);
  assert.equal(success.stdout, 'success-out');
  assert.equal(success.stderr, 'success-err');
  assert.equal(textContent(successResult), success.text);
  assert.match(textContent(successResult), /success-out/);
  assert.match(textContent(successResult), /success-err/);
  assert.doesNotMatch(textContent(successResult), /^\s*\{/);
  verifiedEvidence(success, 'execute_command');

  const failureResult = await server.call('execute_command', {
    command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('failure-out'); process.stderr.write('failure-err'); process.exit(7)"`,
    cwd: dir,
  });
  const failure = structuredContent(failureResult);
  assert.equal(failureResult.isError, true);
  assert.equal(failure.ok, false);
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.signal, null);
  assert.equal(failure.timedOut, false);
  assert.equal(failure.stdout, 'failure-out');
  assert.equal(failure.stderr, 'failure-err');
  assert.equal(textContent(failureResult), failure.text);
  assert.match(textContent(failureResult), /命令失败（退出码 7）/);
  assert.doesNotMatch(textContent(failureResult), /^\s*\{/);
});

test(
  'execute_command timeout still kills its process group when ps enumeration is unavailable',
  { skip: process.platform === 'win32' ? 'POSIX process group regression' : false },
  async () => {
    const serverDir = await createTempDir();
    const server = await createServer({ PATH: join(serverDir, 'no-ps-on-this-path') });
    const childPidFile = join(serverDir, 'timeout-child.pid');
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })",
      `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))`,
      'setInterval(() => {}, 60000)',
    ].join(';');
    let childPid: number | undefined;

    try {
      const startedAt = Date.now();
      const result = await server.call('execute_command', {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        cwd: serverDir,
        timeout: 400,
      });
      const elapsedMs = Date.now() - startedAt;
      const payload = structuredContent(result);
      childPid = Number(await readFile(childPidFile, 'utf8'));

      assert.equal(payload.timedOut, true);
      assert.ok(elapsedMs < 2_500, `timeout waited ${elapsedMs}ms after ps failed`);
      await waitFor(
        () => !isAlive(childPid!),
        `process-group descendant ${childPid} survived timeout when ps was unavailable`,
      );
    } finally {
      if (childPid && isAlive(childPid)) await killEscapedBestEffort(childPid);
    }
  },
);

test(
  'execute_command does not kill an unrelated process whose argv only resembles its scope marker',
  { skip: process.platform !== 'darwin' ? 'ps argv matching regression is macOS-specific' : false },
  async () => {
    const dir = await createTempDir();
    const scope = '00000000-0000-4000-8000-000000000041';
    const preload = await writeFixedUuidPreload(dir, scope);
    const inheritedNodeOptions = process.env.NODE_OPTIONS;
    const server = await createServer({
      NODE_OPTIONS: [inheritedNodeOptions, `--require=${preload}`].filter(Boolean).join(' '),
    });
    const unrelatedEnv = { ...process.env };
    delete unrelatedEnv.MY_AGENT_EXEC_SCOPE;
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 60000)', '--', `MY_AGENT_EXEC_SCOPE=${scope}`],
      { detached: true, env: unrelatedEnv, stdio: 'ignore' },
    );
    unrelated.unref();
    assert.ok(unrelated.pid, 'unrelated process must receive a pid');

    try {
      await waitFor(() => isAlive(unrelated.pid!), 'unrelated process did not start');
      const result = await server.call('execute_command', {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('done')")}`,
        cwd: dir,
      });
      assert.equal(structuredContent(result).ok, true);
      await delay(100);
      assert.equal(
        isAlive(unrelated.pid!),
        true,
        'scope cleanup must not signal a process whose marker exists only in argv text',
      );
    } finally {
      await killEscapedBestEffort(unrelated.pid!);
    }
  },
);

test(
  'execute_command cleans up detached child in new process group after parent exits 0',
  { skip: process.platform === 'win32' ? 'POSIX process group regression' : false },
  async () => {
    const server = await createServer();
    const dir = await createTempDir();
    const readinessFile = join(dir, 'escaped-child.json');
    const childScript = [
      "const fs = require('node:fs')",
      "const net = require('node:net')",
      'const server = net.createServer(() => {})',
      "server.listen(0, '127.0.0.1', () => {",
      `  fs.writeFileSync(${JSON.stringify(readinessFile)}, JSON.stringify({ pid: process.pid, port: server.address().port }))`,
      '})',
      'setInterval(() => {}, 60_000)',
    ].join(';');
    const parentScript = [
      "const { spawn } = require('node:child_process')",
      "const fs = require('node:fs')",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: 'ignore' })`,
      'child.unref()',
      `while (!fs.existsSync(${JSON.stringify(readinessFile)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)`,
      "console.log('ESCAPED_PID=' + child.pid)",
      'process.exit(0)',
    ].join(';');

    let escaped: EscapedProcessReadiness | undefined;
    try {
      const result = await server.call('execute_command', {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`,
        cwd: dir,
        timeout: 5_000,
      });
      const payload = structuredContent(result);
      assert.equal(payload.ok, true);
      escaped = await readEscapedReadiness(readinessFile);
      assert.ok(escaped, `escaped child did not write readiness file: ${textContent(result)}`);

      const pidGoneBeforeCleanup = !isAlive(escaped.pid);
      const portReleasedBeforeCleanup = await canBind(escaped.port);
      assert.equal(pidGoneBeforeCleanup, true, `escaped child pid ${escaped.pid} survived`);
      assert.equal(portReleasedBeforeCleanup, true, `escaped child kept port ${escaped.port}`);
    } finally {
      escaped ??= await readEscapedReadiness(readinessFile).catch(() => undefined);
      if (escaped) {
        await killEscapedBestEffort(escaped.pid);
        await waitFor(() => !isAlive(escaped!.pid), 'escaped child survived emergency cleanup');
        assert.equal(
          await waitForPortRelease(escaped.port),
          true,
          `escaped child port ${escaped.port} stayed bound after emergency cleanup`,
        );
      }
    }
  },
);

test('managed process tools support readiness, cursored logs, status, and idempotent group stop', async () => {
  const server = await createServer();
  const dir = await createTempDir();
  const tools = await server.tools();
  const startTool = tools.find((tool) => tool.name === 'start_process');
  const getTool = tools.find((tool) => tool.name === 'get_process');
  const logsTool = tools.find((tool) => tool.name === 'read_process_logs');
  const stopTool = tools.find((tool) => tool.name === 'stop_process');
  assert.ok(startTool && getTool && logsTool && stopTool, 'all managed process tools are required');

  const grandchildPidFile = join(dir, 'grandchild.pid');
  const script = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const http = require('node:http')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid))`,
    "console.log('booting')",
    "const httpServer = http.createServer((_req, res) => res.end('ok'))",
    "httpServer.listen(0, '127.0.0.1', () => {",
    "  console.log(`READY:${httpServer.address().port}`)",
    "  setTimeout(() => console.log('after-ready'), 150)",
    "})",
    "setInterval(() => {}, 1000)",
  ].join(';');

  let started: StartedProcess | undefined;
  let grandchildPid: number | undefined;
  try {
    const startResult = await server.call('start_process', {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      cwd: dir,
      ...readinessArguments(startTool, 'READY:(\\d+)'),
    });
    assert.equal(startResult.isError, false);
    const start = structuredContent(startResult);
    started = { processId: processIdFrom(start), pid: readNumber(start, 'pid') };
    assert.equal(start.ready, true, 'start_process must wait for the readiness pattern');
    assert.equal(readString(start, 'status'), 'running');

    const statusResult = await server.call(
      getTool.name,
      processIdArgument(getTool, started.processId),
    );
    const status = structuredContent(statusResult);
    assert.equal(processIdFrom(status), started.processId);
    assert.equal(readString(status, 'status'), 'running');
    assert.equal(status.ready, true);

    const firstLogsResult = await server.call(logsTool.name, {
      ...processIdArgument(logsTool, started.processId),
      ...cursorArgument(logsTool, 0),
    });
    const firstLogs = structuredContent(firstLogsResult);
    assert.match(logText(firstLogs), /booting[\s\S]*READY:\d+/);
    const firstCursor = nextCursor(firstLogs);
    assert.ok(firstCursor > 0);

    let secondLogs!: Record<string, unknown>;
    await waitFor(async () => {
      const result = await server.call(logsTool.name, {
        ...processIdArgument(logsTool, started!.processId),
        ...cursorArgument(logsTool, firstCursor),
      });
      secondLogs = structuredContent(result);
      return logText(secondLogs).includes('after-ready');
    }, 'read_process_logs did not return output written after the first cursor');
    assert.doesNotMatch(logText(secondLogs), /booting|READY:/, 'cursor must not replay old logs');
    assert.ok(nextCursor(secondLogs) > firstCursor, 'log cursor must advance monotonically');

    grandchildPid = Number(await readFile(grandchildPidFile, 'utf8'));
    assert.ok(Number.isInteger(grandchildPid) && isAlive(grandchildPid));
    const observedGrandchildPid = grandchildPid;

    const firstStop = await server.call(
      stopTool.name,
      processIdArgument(stopTool, started.processId),
    );
    assert.equal(firstStop.isError, false);
    const firstStopPayload = structuredContent(firstStop);
    assert.equal(processIdFrom(firstStopPayload), started.processId);
    assert.match(readString(firstStopPayload, 'status') ?? '', /^(stopped|exited|already_stopped)$/);

    await waitFor(
      () => !isAlive(observedGrandchildPid) && (!started!.pid || !isAlive(started!.pid)),
      'stop_process left a process from the managed process group running',
    );

    const secondStop = await server.call(
      stopTool.name,
      processIdArgument(stopTool, started.processId),
    );
    assert.equal(secondStop.isError, false, 'stopping an already stopped process must be idempotent');
    const secondStopPayload = structuredContent(secondStop);
    assert.equal(processIdFrom(secondStopPayload), started.processId);
    assert.match(readString(secondStopPayload, 'status') ?? '', /^(stopped|exited|already_stopped)$/);
  } finally {
    if (started) await stopBestEffort(server, stopTool, started.processId);
    if (!grandchildPid) {
      grandchildPid = Number(await readFile(grandchildPidFile, 'utf8').catch(() => '')) || undefined;
    }
    if (grandchildPid && isAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid, 'SIGKILL');
      } catch {
        // The process may exit between the liveness check and the signal.
      }
    }
    if (started?.pid) {
      try {
        process.kill(-started.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(started.pid, 'SIGKILL');
        } catch {
          // Already stopped by the managed process implementation.
        }
      }
    }
  }
});

test('exec-mcp shutdown terminates every managed process group', async () => {
  const server = await createServer();
  const dir = await createTempDir();
  const tools = await server.tools();
  const startTool = tools.find((tool) => tool.name === 'start_process');
  const stopTool = tools.find((tool) => tool.name === 'stop_process');
  assert.ok(startTool && stopTool);

  const grandchildPidFile = join(dir, 'shutdown-grandchild.pid');
  const script = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid))`,
    "console.log('READY')",
    "setInterval(() => {}, 1000)",
  ].join(';');

  const startResult = await server.call('start_process', {
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    cwd: dir,
    ...readinessArguments(startTool, '^READY$'),
  });
  const start = structuredContent(startResult);
  const managedPid = readNumber(start, 'pid');
  assert.ok(managedPid && isAlive(managedPid));
  const grandchildPid = Number(await readFile(grandchildPidFile, 'utf8'));
  assert.ok(Number.isInteger(grandchildPid) && isAlive(grandchildPid));

  try {
    await server.shutdownServerOnly('SIGTERM');
    assert.ok(
      server.proc.exitCode !== null || server.proc.signalCode !== null,
      'exec-mcp must exit after SIGTERM',
    );
    await waitFor(
      () => !isAlive(managedPid) && !isAlive(grandchildPid),
      'exec-mcp shutdown left managed child processes running',
    );
  } finally {
    for (const pid of [managedPid, grandchildPid]) {
      if (!isAlive(pid)) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already exited after the assertion sampled process state.
        }
      }
    }
  }
});

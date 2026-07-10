import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  loadAdapter,
  runAdapter,
  extractFinalAnswer,
  type AdapterConfig,
} from '../cli-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ADAPTERS_DIR = path.resolve(__dirname, '..', '..', 'adapters');
const CLI_ADAPTER = path.resolve(__dirname, '..', 'cli-adapter.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeYaml(dir: string, name: string, body: string): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, body, 'utf8');
  return full;
}

// ─── loadAdapter ───

test('loadAdapter: 解析最小合法 YAML', () => {
  const dir = mkTmpDir('adapter-load-');
  try {
    const p = writeYaml(
      dir,
      'min.yaml',
      `name: minimal
underlying_model: qwen3-30b
command: /bin/echo
args: ["hi"]
timeout_sec: 30
`,
    );
    const cfg = loadAdapter(p);
    assert.equal(cfg.name, 'minimal');
    assert.equal(cfg.underlyingModel, 'qwen3-30b');
    assert.equal(cfg.command, '/bin/echo');
    assert.deepEqual(cfg.args, ['hi']);
    assert.equal(cfg.timeoutSec, 30);
    assert.equal(cfg.version, undefined);
    assert.equal(cfg.env, undefined);
    assert.equal(cfg.finalAnswerMarker, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAdapter: 完整字段(version/env/final_answer_marker)', () => {
  const dir = mkTmpDir('adapter-load-');
  try {
    const p = writeYaml(
      dir,
      'full.yaml',
      `name: claude-code
version: 1.2.0
underlying_model: claude-sonnet-4-6
command: claude
args:
  - "-p"
  - \${PROMPT}
env:
  ANTHROPIC_API_KEY: key-from-env
timeout_sec: 900
final_answer_marker: "===FINAL==="
`,
    );
    const cfg = loadAdapter(p);
    assert.equal(cfg.version, '1.2.0');
    assert.equal(cfg.finalAnswerMarker, '===FINAL===');
    assert.deepEqual(cfg.env, { ANTHROPIC_API_KEY: 'key-from-env' });
    assert.deepEqual(cfg.args, ['-p', '${PROMPT}']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAdapter: 缺少 name 应抛错', () => {
  const dir = mkTmpDir('adapter-load-');
  try {
    const p = writeYaml(
      dir,
      'bad.yaml',
      `underlying_model: x
command: /bin/echo
args: []
timeout_sec: 10
`,
    );
    assert.throws(() => loadAdapter(p), /name.*non-empty string/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAdapter: timeout_sec 非正数应抛错', () => {
  const dir = mkTmpDir('adapter-load-');
  try {
    const p = writeYaml(
      dir,
      'bad.yaml',
      `name: x
underlying_model: x
command: /bin/echo
args: []
timeout_sec: 0
`,
    );
    assert.throws(() => loadAdapter(p), /timeout_sec.*positive/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAdapter: 文件不存在应抛错', () => {
  assert.throws(() => loadAdapter('/nonexistent/adapter.yaml'), /not found/);
});

test('loadAdapter: 项目内示例 YAML 全部可加载', () => {
  for (const name of ['ma.yaml', 'claude-code.yaml', 'codex.yaml', 'echo-mock.yaml']) {
    const p = path.join(ADAPTERS_DIR, name);
    const cfg = loadAdapter(p);
    assert.ok(cfg.name.length > 0, `${name} name`);
    assert.ok(cfg.command.length > 0, `${name} command`);
    assert.ok(cfg.timeoutSec > 0, `${name} timeout`);
  }
});

// ─── extractFinalAnswer ───

test('extractFinalAnswer: 命中 ===FINAL_ANSWER=== / ===END=== 标记', () => {
  const stdout = [
    'some log line',
    'another line',
    '===FINAL_ANSWER===',
    'the real answer',
    'spanning two lines',
    '===END===',
    'trailing',
  ].join('\n');
  const answer = extractFinalAnswer(stdout);
  assert.equal(answer, 'the real answer\nspanning two lines');
});

test('extractFinalAnswer: 只有 START 标记没有 END → 取到末尾', () => {
  const stdout = 'noise\n===FINAL_ANSWER===\nhello\nworld';
  const answer = extractFinalAnswer(stdout);
  assert.equal(answer, 'hello\nworld');
});

test('extractFinalAnswer: 自定义 marker', () => {
  const stdout = 'x\n===MY_MARK===\nfinal\n===END===\n';
  const answer = extractFinalAnswer(stdout, '===MY_MARK===');
  assert.equal(answer, 'final');
});

test('extractFinalAnswer: 无标记 + 短 stdout → 返回全量', () => {
  const stdout = 'hello world';
  assert.equal(extractFinalAnswer(stdout), 'hello world');
});

test('extractFinalAnswer: 无标记 + 超过 4KB → 返回末尾 4KB', () => {
  const filler = 'A'.repeat(5000);
  const tailMarker = 'TAIL';
  const stdout = filler + tailMarker;
  const answer = extractFinalAnswer(stdout);
  assert.ok(answer.endsWith(tailMarker), 'should contain tail marker');
  assert.equal(Buffer.from(answer, 'utf8').byteLength, 4 * 1024);
});

// ─── runAdapter: 基本 spawn + stdout 收集 ───

test('runAdapter: 用 echo-mock adapter 跑通基本 spawn + stdout', async () => {
  const cfg = loadAdapter(path.join(ADAPTERS_DIR, 'echo-mock.yaml'));
  const workdir = mkTmpDir('adapter-run-');
  try {
    const res = await runAdapter(cfg, 'hello from prompt', workdir);
    assert.equal(res.exitCode, 0);
    assert.equal(res.timedOut, false);
    assert.match(res.stdout, /hello from prompt/);
    assert.equal(res.stderr, '');
    assert.ok(res.elapsedMs >= 0);
    // echo-mock 没配 marker,走兜底 → 返回全量(< 4KB)
    assert.match(res.finalAnswer, /hello from prompt/);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('runAdapter: ${WORKDIR} 占位被替换', async () => {
  const cfg: AdapterConfig = {
    name: 'pwd-check',
    underlyingModel: 'mock',
    command: 'node',
    args: ['-e', 'console.log(process.cwd())'],
    timeoutSec: 10,
  };
  const workdir = mkTmpDir('adapter-wd-');
  try {
    const res = await runAdapter(cfg, 'x', workdir);
    assert.equal(res.exitCode, 0);
    // macOS 的 /tmp 有 symlink → /private/tmp,用 realpath 对齐
    const expected = fs.realpathSync(workdir);
    const actual = res.stdout.trim();
    assert.ok(
      actual === workdir || actual === expected,
      `cwd mismatch: actual=${actual} expected=${workdir}|${expected}`,
    );
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('runAdapter: ${PROMPT} 占位被替换进 args', async () => {
  const cfg: AdapterConfig = {
    name: 'prompt-sub',
    underlyingModel: 'mock',
    command: 'node',
    args: ['-e', 'console.log(process.argv[1])', '--', '${PROMPT}'],
    timeoutSec: 10,
  };
  const workdir = mkTmpDir('adapter-prompt-');
  try {
    const res = await runAdapter(cfg, 'injected-value', workdir);
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /injected-value/);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('runAdapter: FINAL_ANSWER 标记提取', async () => {
  const cfg: AdapterConfig = {
    name: 'marker-test',
    underlyingModel: 'mock',
    command: 'node',
    args: [
      '-e',
      "process.stdout.write('log1\\nlog2\\n===FINAL_ANSWER===\\nthe answer\\n===END===\\ntrailing\\n')",
    ],
    timeoutSec: 10,
  };
  const workdir = mkTmpDir('adapter-marker-');
  try {
    const res = await runAdapter(cfg, 'x', workdir);
    assert.equal(res.exitCode, 0);
    assert.equal(res.finalAnswer, 'the answer');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('runAdapter: 超时 → SIGTERM → timedOut=true', async () => {
  const cfg: AdapterConfig = {
    name: 'sleep-forever',
    underlyingModel: 'mock',
    command: 'node',
    // 长睡眠,保证超时触发
    args: ['-e', 'setTimeout(() => {}, 60000)'],
    timeoutSec: 1,
  };
  const workdir = mkTmpDir('adapter-timeout-');
  try {
    const start = Date.now();
    const res = await runAdapter(cfg, 'x', workdir);
    const elapsed = Date.now() - start;
    assert.equal(res.timedOut, true);
    assert.notEqual(res.exitCode, 0);
    // 超时后 5s grace 内被 kill,总时间应该小于 10s
    assert.ok(elapsed < 10_000, `expected kill within 10s, got ${elapsed}ms`);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('runAdapter: stderr 被收集', async () => {
  const cfg: AdapterConfig = {
    name: 'stderr-test',
    underlyingModel: 'mock',
    command: 'node',
    args: ['-e', "process.stderr.write('err-line'); process.exit(2)"],
    timeoutSec: 10,
  };
  const workdir = mkTmpDir('adapter-stderr-');
  try {
    const res = await runAdapter(cfg, 'x', workdir);
    assert.equal(res.exitCode, 2);
    assert.match(res.stderr, /err-line/);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('runAdapter: env 变量被传递', async () => {
  const cfg: AdapterConfig = {
    name: 'env-test',
    underlyingModel: 'mock',
    command: 'node',
    args: ['-e', 'console.log(process.env.MY_TEST_VAR || "missing")'],
    env: { MY_TEST_VAR: 'custom-value' },
    timeoutSec: 10,
  };
  const workdir = mkTmpDir('adapter-env-');
  try {
    const res = await runAdapter(cfg, 'x', workdir);
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /custom-value/);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

async function allocatePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
  return port;
}

async function canBind(port: number): Promise<boolean> {
  const server = net.createServer();
  return await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForPortRelease(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBind(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return canBind(port);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function waitForExit(proc: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  return new Promise((resolve) => {
    proc.once('exit', (code) => resolve({ code, stderr }));
  });
}

async function killEscapedBestEffort(pid: number): Promise<void> {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // The process may have already exited after the assertion.
    }
  }
}

test('runAdapter: timeout kills escaped process-group descendant and releases its port', async () => {
  const port = await allocatePort();
  const workdir = mkTmpDir('adapter-process-tree-');
  const readinessFile = path.join(workdir, 'escaped-descendant.json');
  const descendantScript = [
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `net.createServer(() => {}).listen(${port}, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(readinessFile)}, JSON.stringify({ pid: process.pid, port: ${port} })))`,
    'setInterval(() => {}, 60_000)',
  ].join(';');
  const parentScript = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'ignore' })`,
    'child.unref()',
    `while (!fs.existsSync(${JSON.stringify(readinessFile)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)`,
    "console.log('DESCENDANT_PID=' + child.pid)",
    'setInterval(() => {}, 60_000)',
  ].join(';');
  const cfg: AdapterConfig = {
    name: 'process-tree-timeout',
    underlyingModel: 'test-only',
    command: process.execPath,
    args: ['-e', parentScript],
    timeoutSec: 0.5,
  };
  let descendantPid: number | undefined;

  try {
    const result = await runAdapter(cfg, 'x', workdir);
    assert.equal(result.timedOut, true);
    const match = result.stdout.match(/DESCENDANT_PID=(\d+)/);
    assert.ok(match, `descendant did not start before timeout: ${result.stdout}`);
    descendantPid = Number(match[1]);

    assert.equal(isAlive(descendantPid), false, `escaped descendant pid ${descendantPid} survived`);
    const releasedByAdapter = await waitForPortRelease(port, 2_000);
    assert.equal(releasedByAdapter, true, `descendant kept port ${port} after timeout`);
  } finally {
    if (descendantPid) {
      await killEscapedBestEffort(descendantPid);
      await waitForPortRelease(port, 2_000);
    }
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('runAdapter: normal parent exit also kills descendants and releases their port', async () => {
  const port = await allocatePort();
  const workdir = mkTmpDir('adapter-normal-exit-tree-');
  const descendantScript = [
    "const net = require('node:net')",
    `net.createServer(() => {}).listen(${port}, '127.0.0.1', () => console.log('READY'))`,
    'setInterval(() => {}, 60_000)',
  ].join(';');
  const parentScript = [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
    "child.stdout.once('data', () => { console.log(`DESCENDANT_PID=${child.pid}`); process.exit(0) })",
  ].join(';');
  const cfg: AdapterConfig = {
    name: 'process-tree-normal-exit',
    underlyingModel: 'test-only',
    command: process.execPath,
    args: ['-e', parentScript],
    timeoutSec: 5,
  };
  let descendantPid: number | undefined;

  try {
    const result = await runAdapter(cfg, 'x', workdir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    const match = result.stdout.match(/DESCENDANT_PID=(\d+)/);
    assert.ok(match, `descendant did not start before normal exit: ${result.stdout}`);
    descendantPid = Number(match[1]);

    const releasedByAdapter = await waitForPortRelease(port, 2_000);
    if (!releasedByAdapter && descendantPid) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        // It exited between the port probe and cleanup.
      }
      await waitForPortRelease(port, 2_000);
    }
    assert.equal(releasedByAdapter, true, `descendant kept port ${port} after normal exit`);
  } finally {
    if (descendantPid) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        // Already reaped by the adapter implementation.
      }
    }
    await waitForPortRelease(port, 2_000);
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('runAdapter: timeout returns promptly and kills its direct child when ps is unavailable', async () => {
  const workdir = mkTmpDir('adapter-no-ps-timeout-');
  const originalPath = process.env.PATH;
  process.env.PATH = path.join(workdir, 'no-ps-on-this-path');
  const cfg: AdapterConfig = {
    name: 'no-ps-timeout',
    underlyingModel: 'test-only',
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(0), 2500)'],
    timeoutSec: 0.2,
  };

  try {
    const startedAt = Date.now();
    const result = await runAdapter(cfg, 'x', workdir);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.timedOut, true);
    assert.ok(elapsedMs < 1_500, `timeout waited ${elapsedMs}ms after ps failed`);
    assert.ok(result.exitCode !== 0, 'direct child should be terminated instead of exiting naturally');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test(
  'runAdapter does not kill an unrelated process whose argv only resembles its run marker',
  { skip: process.platform !== 'darwin' ? 'ps argv matching regression is macOS-specific' : false },
  async () => {
    const workdir = mkTmpDir('adapter-argv-marker-');
    const marker = '00000000-0000-4000-8000-000000000042';
    const preload = path.join(workdir, 'fixed-random-uuid.cjs');
    const runner = path.join(workdir, 'run-adapter.mts');
    fs.writeFileSync(
      preload,
      [
        "const crypto = require('node:crypto');",
        `crypto.randomUUID = () => ${JSON.stringify(marker)};`,
        "require('node:module').syncBuiltinESMExports();",
      ].join('\n'),
    );
    fs.writeFileSync(
      runner,
      [
        `import { runAdapter } from ${JSON.stringify(CLI_ADAPTER)};`,
        'void (async () => {',
        `  const result = await runAdapter({ name: 'marker-cleanup', underlyingModel: 'test-only', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSec: 5 }, 'x', ${JSON.stringify(workdir)});`,
        '  process.stdout.write(JSON.stringify(result));',
        '})().catch((error) => { console.error(error); process.exitCode = 1; });',
      ].join('\n'),
    );
    const unrelatedEnv = { ...process.env };
    delete unrelatedEnv.MY_AGENT_ADAPTER_RUN_ID;
    const unrelated = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 60000)', '--', `MY_AGENT_ADAPTER_RUN_ID=${marker}`],
      { detached: true, env: unrelatedEnv, stdio: 'ignore' },
    );
    unrelated.unref();
    assert.ok(unrelated.pid, 'unrelated process must receive a pid');

    try {
      const inheritedNodeOptions = process.env.NODE_OPTIONS;
      const runnerProcess = spawn(process.execPath, [TSX_CLI, runner], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          NODE_OPTIONS: [inheritedNodeOptions, `--require=${preload}`].filter(Boolean).join(' '),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const runnerResult = await waitForExit(runnerProcess);
      assert.equal(runnerResult.code, 0, runnerResult.stderr);
      assert.equal(
        isAlive(unrelated.pid!),
        true,
        'adapter cleanup must not signal a process whose marker exists only in argv text',
      );
    } finally {
      await killEscapedBestEffort(unrelated.pid!);
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  },
);

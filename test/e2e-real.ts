import test, { type TestContext } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultE2ECwd,
  e2eConfigSkipReason,
  REPO_ROOT,
  resolveE2EConfigPath,
} from './e2e/helpers/real-env.js';
import { countChinese, hasLlmError, runMaPrompt } from './e2e/helpers/cli-runner.js';
import { runAgent } from './e2e/helpers/agent-runner.js';
import {
  canSpawnPty,
  killMa,
  sendLine,
  spawnMa,
  stripAnsi,
  waitFor,
} from './e2e/helpers/pty.js';

function requireConfig(t: TestContext): string | null {
  const configPath = resolveE2EConfigPath();
  if (!configPath) {
    t.skip(e2eConfigSkipReason());
    return null;
  }
  return configPath;
}

async function waitReady(proc: ReturnType<typeof spawnMa>): Promise<void> {
  await waitFor(
    proc,
    (out) => {
      const clean = stripAnsi(out);
      return clean.includes('session') && clean.includes('MA');
    },
    30000
  );
}

test('real ma run smoke: simple provider response completes', { timeout: 300000 }, async (t) => {
  const configPath = requireConfig(t);
  if (!configPath) return;

  const result = await runMaPrompt({
    configPath,
    prompt: '你好，用一句中文回答你是谁',
    timeoutMs: 240000,
  });
  const combined = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.timedOut, false, `ma run timed out. Tail: ${combined.slice(-800)}`);
  assert.equal(result.exitCode, 0, `ma run exited ${result.exitCode}. Tail: ${combined.slice(-800)}`);
  assert.match(result.stdout, /===FINAL_ANSWER===/);
  assert.ok(!hasLlmError(combined), `unexpected LLM error. Tail: ${combined.slice(-800)}`);
  assert.ok(countChinese(result.stdout) >= 2, `expected Chinese answer. Tail: ${combined.slice(-800)}`);
});

test('real ma run smoke: tool call path lists project files', { timeout: 360000 }, async (t) => {
  const configPath = requireConfig(t);
  if (!configPath) return;

  const result = await runMaPrompt({
    configPath,
    prompt: '请查看当前目录，列出最多5个顶层文件或目录，并说明你是通过工具看到的',
    timeoutMs: 300000,
  });
  const combined = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.timedOut, false, `tool smoke timed out. Tail: ${combined.slice(-1000)}`);
  assert.equal(result.exitCode, 0, `tool smoke exited ${result.exitCode}. Tail: ${combined.slice(-1000)}`);
  assert.match(result.stderr, /\[tool\]\s+fs__list_directory/, `expected fs list tool. Tail: ${combined.slice(-1000)}`);
  assert.match(result.stdout, /===FINAL_ANSWER===/);
  assert.ok(!hasLlmError(combined), `unexpected LLM error. Tail: ${combined.slice(-1000)}`);
});

test('real remote provider: bounded read receipts complete two large files without duplicate pages', { timeout: 420000 }, async (t) => {
  const baseConfigPath = requireConfig(t);
  if (!baseConfigPath) return;
  const baseConfig = JSON.parse(fs.readFileSync(baseConfigPath, 'utf8'));
  if (String(baseConfig.model?.provider ?? '').toLowerCase() === 'agora') {
    t.skip('requires a real remote OpenAI-compatible provider config');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-issue42-remote-read-'));
  const configPath = path.join(tmp, 'config.json');
  try {
    const writeFixture = (name: string, lineCount: number, marker: string): void => {
      const lines = Array.from({ length: lineCount }, (_, index) =>
        `export const ${name}${index + 1} = ${JSON.stringify(`${name}-${index + 1}-${'x'.repeat(24)}`)};`
      );
      lines[lineCount - 1] = `// ${marker}`;
      fs.writeFileSync(path.join(tmp, `${name}.ts`), lines.join('\n'), 'utf8');
    };
    writeFixture('alpha', 198, 'ALPHA_END_198');
    writeFixture('beta', 212, 'BETA_END_212');
    baseConfig.defaultProfile = '';
    baseConfig.mcpServers = {
      fs: {
        command: process.execPath,
        args: ['--import', 'tsx', path.join(REPO_ROOT, 'servers', 'fs-mcp.ts')],
        cwd: REPO_ROOT,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(baseConfig), 'utf8');

    const result = await runAgent(
      [
        '完整阅读当前目录的 alpha.ts 和 beta.ts，必须按 read_file receipt 的 next_cursor 逐页继续到 complete=true。',
        '不要用 execute_command、cat、sed、head 或 tail 读取。',
        '最后分别报告两个文件最后一行的标记。',
      ].join(''),
      { cwd: tmp, configPath, timeout: 360000 },
    );
    const reads = result.toolCalls.filter((call) => call.name === 'fs__read_file' && call.ok);
    assert.ok(reads.length >= 4, `expected paginated reads, got ${JSON.stringify(reads)}`);
    const cursors = new Set<string>();
    for (const read of reads) {
      const file = path.resolve(tmp, String(read.args.path));
      const cursor = String(read.args.cursor ?? `${read.args.offset ?? 1}:0`);
      const key = `${file}:${cursor}`;
      assert.equal(cursors.has(key), false, `duplicate page reached model context: ${key}`);
      cursors.add(key);
    }
    assert.match(result.finalText, /ALPHA_END_198/);
    assert.match(result.finalText, /BETA_END_212/);
    assert.ok(reads.some((call) => path.resolve(tmp, String(call.args.path)).endsWith('alpha.ts')));
    assert.ok(reads.some((call) => path.resolve(tmp, String(call.args.path)).endsWith('beta.ts')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('real TUI PTY smoke: starts, accepts input, completes, exits', { timeout: 360000 }, async (t) => {
  const configPath = requireConfig(t);
  if (!configPath) return;

  const ptyProbe = await canSpawnPty();
  if (!ptyProbe.ok) {
    t.skip(`node-pty unavailable: ${ptyProbe.reason}`);
    return;
  }

  const proc = spawnMa(defaultE2ECwd(), { configPath });
  let exited = false;
  let exitCode: number | undefined;
  proc.onExit((event) => {
    exited = true;
    exitCode = event.exitCode;
  });

  try {
    await waitReady(proc);
    await sendLine(proc, '你好，用一句中文回答你是谁');
    const out = await waitFor(
      proc,
      (raw) => {
        const clean = stripAnsi(raw);
        return clean.includes('完成') || hasLlmError(clean);
      },
      240000
    );
    const clean = stripAnsi(out);
    assert.ok(clean.includes('完成'), `TUI did not complete. Tail: ${clean.slice(-1000)}`);
    assert.ok(!hasLlmError(clean), `unexpected TUI error. Tail: ${clean.slice(-1000)}`);
    assert.ok(
      !clean.includes('MaxListenersExceededWarning'),
      `MaxListeners warning leaked. Tail: ${clean.slice(-1000)}`
    );

    await sendLine(proc, '/quit');
    const start = Date.now();
    while (!exited && Date.now() - start < 15000) {
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(exited, '/quit did not exit within 15s');
    assert.ok(
      exitCode === 0 || exitCode === undefined,
      `/quit should exit 0, got ${exitCode}`
    );
  } finally {
    if (!exited) await killMa(proc);
  }
});

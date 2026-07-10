import test, { type TestContext } from 'node:test';
import assert from 'node:assert';
import {
  defaultE2ECwd,
  e2eConfigSkipReason,
  resolveE2EConfigPath,
} from './e2e/helpers/real-env.js';
import { countChinese, hasLlmError, runMaPrompt } from './e2e/helpers/cli-runner.js';
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

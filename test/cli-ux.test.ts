import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

test('CLI UX PTY: DeepSeek status bar uses provider capability instead of 33k fallback', async (t) => {
  if (process.env.MA_RUN_PTY_TESTS !== '1') {
    t.skip('PTY UI verification runs only in the explicit MA_RUN_PTY_TESTS E2E lane');
    return;
  }
  if (!canSpawnPty()) {
    t.skip('node-pty cannot spawn a basic /bin/echo process in this environment');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cli-ux-'));
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        defaultProfile: '',
        model: {
          provider: 'deepseek',
          baseURL: 'http://127.0.0.1:9/v1',
          model: 'deepseek-v4-flash',
          apiKey: 'test',
        },
        mcpServers: {},
      },
      null,
      2
    ),
    'utf8'
  );

  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = pty.spawn(process.execPath, [tsxCli, 'src/cli/index.tsx', 'chat', '--config', configPath], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
  });

  let output = '';
  child.onData((data) => {
    output += data;
  });

  try {
    await waitFor(() => /win\s+1m\s+registry/.test(stripAnsi(output)), 10_000);
    const plain = stripAnsi(output);
    assert.match(plain, /ctx:/);
    assert.match(plain, /trigger/);
    assert.match(plain, /win 1m registry/);
    assert.doesNotMatch(plain, /33k/);
  } finally {
    child.kill('SIGINT');
  }
});

test('CLI UX PTY: Agora keeps context usage and memory activity on separate readable lines', async (t) => {
  if (process.env.MA_RUN_PTY_TESTS !== '1') {
    t.skip('PTY UI verification runs only in the explicit MA_RUN_PTY_TESTS E2E lane');
    return;
  }
  if (!canSpawnPty()) {
    t.skip('node-pty cannot spawn a basic /bin/echo process in this environment');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cli-agora-ux-'));
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    defaultProfile: '',
    model: {
      provider: 'agora',
      baseURL: 'mcp-stdio://agora',
      model: 'qwen3.6-35b-a3b-q4',
      apiKey: 'agora-mcp',
    },
    mcpServers: {},
  }, null, 2));
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = pty.spawn(process.execPath, [tsxCli, 'src/cli/index.tsx', 'chat', '--config', configPath], {
    name: 'xterm-256color',
    cols: 80,
    rows: 30,
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
  });
  let output = '';
  child.onData((data) => { output += data; });
  try {
    await waitFor(() => /Memory:\s+未选择 Profile/.test(stripAnsi(output)), 10_000);
    const plain = stripAnsi(output);
    assert.match(plain, /ctx:/);
    assert.match(plain, /trigger/);
    assert.match(plain, /Memory:\s+未选择 Profile/);
    assert.doesNotMatch(plain, /sess\s/);
  } finally {
    child.kill('SIGINT');
  }
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for PTY output');
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function canSpawnPty(): boolean {
  try {
    const child = pty.spawn('/bin/echo', ['ok'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: repoRoot,
      env: process.env,
    });
    child.kill();
    return true;
  } catch {
    return false;
  }
}

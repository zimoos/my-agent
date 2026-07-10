import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

test('ma run SIGTERM closes a provider-owned Agora MCP child', { timeout: 15_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-signal-cleanup-'));
  const pidFile = path.join(dir, 'agora-mcp.pid');
  const fakeAgora = path.join(dir, 'fake-agora.mjs');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    fakeAgora,
    `import fs from 'node:fs';
fs.writeFileSync(process.env.FAKE_AGORA_PID_FILE, String(process.pid));
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\\n');
    if (idx < 0) return;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'notifications/initialized') continue;
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
      continue;
    }
    if (request.method === 'tools/list') {
      const names = ['doctor', 'models_list', 'chat_complete'];
      const tools = names.map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools } }) + '\\n');
      continue;
    }
    if (request.method === 'resources/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { resources: [] } }) + '\\n');
      continue;
    }
    if (request.method === 'tools/call' && request.params.name === 'doctor') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: '{"status":"ok"}' }] } }) + '\\n');
      continue;
    }
    if (request.method === 'tools/call' && request.params.name === 'models_list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: '{"models":[{"id":"fake"}]}' }] } }) + '\\n');
      continue;
    }
    // chat_complete deliberately never resolves; the parent must clean us up.
  }
});
`,
    'utf8',
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultProfile: '',
      model: {
        provider: 'agora',
        baseURL: 'mcp-stdio://agora',
        model: 'fake',
        apiKey: 'fake',
        requestTimeoutMs: 60_000,
        agoraRuntime: { command: process.execPath, args: [fakeAgora] },
      },
      mcpServers: {},
    }),
    'utf8',
  );

  const cli = path.resolve('node_modules/.bin/tsx');
  const proc = spawn(process.execPath, [cli, 'src/cli/index.tsx', 'run', '--config', configPath, '--prompt', 'hello'], {
    cwd: path.resolve('.'),
    env: { ...process.env, FAKE_AGORA_PID_FILE: pidFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk) => { stdout += chunk; });
  proc.stderr?.on('data', (chunk) => { stderr += chunk; });

  try {
    await waitFor(
      () => fs.existsSync(pidFile) || proc.exitCode !== null,
      5_000,
      'fake Agora MCP did not start',
    );
    assert.ok(
      fs.existsSync(pidFile),
      `fake Agora MCP did not start; exit=${String(proc.exitCode)} stdout=${stdout} stderr=${stderr}`,
    );
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(childPid) && isAlive(childPid), 'fake Agora MCP must be alive before SIGTERM');

    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    await waitFor(() => !isAlive(childPid), 5_000, 'provider-owned Agora MCP survived ma run SIGTERM');
  } finally {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    const childPid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '0');
    if (Number.isInteger(childPid) && childPid > 0 && isAlive(childPid)) {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already exited */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

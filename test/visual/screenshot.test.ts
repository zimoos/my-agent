import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.join(__dirname, 'screenshots');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEST_CWD = process.env.TEST_CWD ?? PROJECT_ROOT;

let server: ChildProcess | null = null;
let fixtureRoot: string | null = null;

function fakeAgoraSource(): string {
  const names = ['doctor', 'runtime_capabilities', 'models_list', 'chat_complete'];
  return `let buffer = '';
const names = ${JSON.stringify(names)};
const contract = { runtime_version: '0.2.1', host_protocol_major: 1, capabilities: {} };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const index = buffer.indexOf('\\n');
    if (index < 0) return;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'notifications/initialized') continue;
    let result = {};
    if (request.method === 'initialize') {
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'visual-agora', version: '0.2.1' } };
    } else if (request.method === 'tools/list') {
      result = { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) };
    } else if (request.method === 'resources/list') {
      result = { resources: [] };
    } else if (request.method === 'tools/call') {
      const name = request.params.name;
      const payload = name === 'doctor' ? { status: 'ok', version: '0.2.1', contract }
        : name === 'runtime_capabilities' ? { status: 'ok', contract }
        : name === 'models_list' ? { models: [{ id: 'visual-model', name: 'Visual Model', status: 'available' }] }
        : { status: 'completed', output_text: 'visual-response', message: { role: 'assistant', content: 'visual-response' }, active_memory_patch_ids: [], metadata: { memory_runtime: { patchset_revision: 1 } } };
      result = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
    const send = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    if (request.method === 'initialize') setTimeout(send, 1500); else send();
  }
});
`;
}

async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok) return;
    } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error(`server not ready on port ${port}`);
}

test.beforeAll(async () => {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-visual-'));
  const fakeAgora = path.join(fixtureRoot, 'fake-agora.mjs');
  const configPath = path.join(fixtureRoot, 'config.json');
  fs.writeFileSync(fakeAgora, fakeAgoraSource(), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    defaultProfile: '',
    model: {
      provider: 'agora', baseURL: 'mcp-stdio://agora', model: 'visual-model', apiKey: 'agora-mcp',
      agoraRuntime: { command: process.execPath, args: [fakeAgora] },
    },
    mcpServers: {},
  }), 'utf8');
  server = spawn('npx', ['tsx', path.join(__dirname, 'server.ts')], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      TEST_CWD,
      VISUAL_PORT: '3456',
      VISUAL_ARGS_JSON: JSON.stringify([
        path.join(PROJECT_ROOT, 'dist', 'src', 'cli', 'index.js'),
        'chat', '--config', configPath,
      ]),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForPort(3456, 15_000);
});

test.afterAll(async () => {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await sleep(500);
  }
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('ma startup screenshot', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__wsReady === true, { timeout: 10_000 });
  await page.waitForFunction(
    () => (window as any).__getText().includes('runtime 连接中'),
    { timeout: 2_000 },
  );
  const shotPath = path.join(SHOTS_DIR, 'startup.png');
  await page.screenshot({ path: shotPath, fullPage: true });
  expect(fs.existsSync(shotPath)).toBe(true);
  const text = await page.evaluate(() => (window as any).__getText());
  expect(text).toContain('MA · 可输入 · runtime 连接中');
  expect(text).toContain('❯');
  console.log('[test] terminal text (startup) first 500 chars:\n', text.slice(0, 500));
});

test('ma ask a simple question', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__wsReady === true, { timeout: 10_000 });
  await page.waitForFunction(() => (window as any).__getText().includes('runtime ready'), { timeout: 10_000 });

  // xterm must be focused to receive keyboard events
  await page.locator('#terminal').click();
  await page.waitForTimeout(300);

  // Type question
  await page.keyboard.type('这个项目怎么样？简单评价', { delay: 30 });
  await page.waitForTimeout(500);
  const shotTyped = path.join(SHOTS_DIR, 'after-type.png');
  await page.screenshot({ path: shotTyped, fullPage: true });

  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const text = (window as any).__getText();
    return text.includes('visual-response')
      && text.includes('输入消息或 /help 查看命令')
      && !text.includes('thinking...');
  }, { timeout: 10_000 });

  const shotPath = path.join(SHOTS_DIR, 'response.png');
  await page.screenshot({ path: shotPath, fullPage: true });
  expect(fs.existsSync(shotPath)).toBe(true);
  const text = await page.evaluate(() => (window as any).__getText());
  console.log('[test] terminal text (response) last 1000 chars:\n', text.slice(-1000));
});

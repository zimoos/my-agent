import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.join(__dirname, 'screenshots');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEST_CWD = process.env.TEST_CWD ?? PROJECT_ROOT;

let server: ChildProcess | null = null;

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
  server = spawn('npx', ['tsx', path.join(__dirname, 'server.ts')], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, TEST_CWD, VISUAL_PORT: '3456' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForPort(3456, 15_000);
});

test.afterAll(async () => {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await sleep(500);
  }
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
  await page.waitForTimeout(5_000);

  // xterm must be focused to receive keyboard events
  await page.locator('#terminal').click();
  await page.waitForTimeout(300);

  // Type question
  await page.keyboard.type('这个项目怎么样？简单评价', { delay: 30 });
  await page.waitForTimeout(500);
  const shotTyped = path.join(SHOTS_DIR, 'after-type.png');
  await page.screenshot({ path: shotTyped, fullPage: true });

  await page.keyboard.press('Enter');
  // Wait for response
  await page.waitForTimeout(30_000);

  const shotPath = path.join(SHOTS_DIR, 'response.png');
  await page.screenshot({ path: shotPath, fullPage: true });
  expect(fs.existsSync(shotPath)).toBe(true);
  const text = await page.evaluate(() => (window as any).__getText());
  console.log('[test] terminal text (response) last 1000 chars:\n', text.slice(-1000));
});

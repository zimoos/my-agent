import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

import {
  loadL3Task,
  runL3Task,
  type L3TaskDef,
} from '../l3-task-runner.js';
import type { AdapterConfig } from '../cli-adapter.js';
import type { JudgeConfig } from '../judge-client.js';

const PERFECT_SCORE = JSON.stringify({
  taskCompletion: 1,
  correctness: 1,
  completeness: 1,
  codeQuality: 1,
  efficiency: 1,
  noRegression: 1,
  reasoning: 'perfect judge response',
});

function makeFixtureRoot(): { root: string; projectDir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'ma-l3-runner-test-'));
  const projectDir = path.join(root, 'fixture');
  mkdirSync(projectDir);
  writeFileSync(path.join(projectDir, 'README.md'), 'fixture\n');
  return {
    root,
    projectDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeTask(overrides: Partial<L3TaskDef> = {}): L3TaskDef {
  return {
    id: 'L3-HARD-GATE',
    title: 'hard gate contract',
    level: 'L3',
    category: 'test',
    weight: 1,
    fixture: { project: 'fixture', setup: [] },
    prompt: 'perform the task',
    rubricPoints: ['complete the task'],
    noModifyFiles: [],
    objectiveChecks: [],
    runtime: { timeoutSec: 10, runs: 1 },
    ...overrides,
  };
}

function makeAdapter(args: string[], timeoutSec = 10): AdapterConfig {
  return {
    name: 'deterministic-test-adapter',
    underlyingModel: 'test-only',
    command: process.execPath,
    args,
    timeoutSec,
  };
}

function perfectJudgeConfig(): JudgeConfig {
  return {
    model: 'deterministic-test-judge',
    apiKey: 'unused',
    openaiClient: {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: PERFECT_SCORE } }],
          }),
        },
      },
    } as unknown as NonNullable<JudgeConfig['openaiClient']>,
  };
}

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
  return new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function waitForPortRelease(port: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBind(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return canBind(port);
}

function browserSpec(port: number): NonNullable<L3TaskDef['browserVerification']> {
  return {
    entrypoint: 'public/index.html',
    requiredEvidence: [
      'canvas_render',
      'keyboard_input',
      'movement',
      'hit',
      'collision',
      'persistence',
      'responsive',
      'console_clean',
    ],
    viewports: [
      { name: 'desktop', width: 1280, height: 720 },
      { name: 'mobile', width: 390, height: 844 },
    ],
    server: { host: '127.0.0.1', port },
    controls: {
      movementKey: 'KeyW',
      collisionKey: 'KeyD',
      saveKey: 'KeyP',
      hitSelector: 'canvas',
    },
    hook: {
      global: '__MA_BENCHMARK__',
      version: 1,
      snapshotMethod: 'snapshot',
    },
    persistence: {
      storageKey: 'ma-open-world-save',
      observedStatePaths: ['player', 'target', 'collision'],
    },
  } as NonNullable<L3TaskDef['browserVerification']>;
}

function completeSelfAuthoredEvidence(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    entrypoint: 'public/index.html',
    canvas: {
      selector: 'canvas', width: 1280, height: 720, nonBlankPixels: 100,
      screenshotPath: 'artifacts/canvas.png',
    },
    input: { events: [{ type: 'keydown', code: 'KeyW' }] },
    movement: { before: { x: 0, y: 4, z: 0 }, after: { x: 1, y: 4, z: 0 } },
    hit: { targetId: 'target', healthBefore: 2, healthAfter: 1 },
    collision: {
      obstacleId: 'wall', attempted: { x: 2, y: 4, z: 0 },
      before: { x: 1, y: 4, z: 0 }, after: { x: 1, y: 4, z: 0 }, blocked: true,
    },
    persistence: {
      storageKey: 'ma-open-world-save', beforeReload: { x: 1, y: 4, z: 0 },
      afterReload: { x: 1, y: 4, z: 0 }, reloaded: true,
    },
    responsive: {
      viewports: [
        { name: 'desktop', width: 1280, height: 720, screenshotPath: 'artifacts/desktop.png', horizontalOverflow: false },
        { name: 'mobile', width: 390, height: 844, screenshotPath: 'artifacts/mobile.png', horizontalOverflow: false },
      ],
    },
    console: { errors: [], pageErrors: [] },
  };
}

function interactiveDemoHtml(): string {
  return `<!doctype html>
<html><body><canvas id="game" width="320" height="180"></canvas><script>
const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
const saved = JSON.parse(localStorage.getItem('ma-open-world-save') || 'null');
const state = saved || {
  player: { x: 20, y: 4, z: 20 },
  target: { id: 'target-1', health: 2 },
  collision: { obstacleId: 'wall-1', blocked: false, attempted: null, before: null, after: null }
};
function paint() {
  ctx.fillStyle = '#1a8f4c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f4d35e'; ctx.fillRect(state.player.x, 80, 16, 16);
  ctx.fillStyle = state.target.health > 0 ? '#d7263d' : '#222'; ctx.fillRect(220, 70, 24, 24);
}
window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyW') state.player.x += 20;
  if (event.code === 'KeyD') {
    const before = { ...state.player };
    state.collision = { obstacleId: 'wall-1', blocked: true,
      attempted: { ...before, x: before.x + 20 }, before, after: { ...state.player } };
  }
  if (event.code === 'KeyP') localStorage.setItem('ma-open-world-save', JSON.stringify(state));
  paint();
});
canvas.addEventListener('click', () => { state.target.health = Math.max(0, state.target.health - 1); paint(); });
window.__MA_BENCHMARK__ = { version: 1, snapshot: () => JSON.parse(JSON.stringify(state)) };
paint();
</script></body></html>`;
}

function adversarialPersistenceHtml(): string {
  return `<!doctype html>
<html><body><canvas id="game" width="320" height="180"></canvas><script>
const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
const isReload = sessionStorage.getItem('ma-adversarial-reloaded') === '1';
const state = {
  player: { x: 20, y: 4, z: 20 },
  target: { id: 'target-1', health: 2 },
  collision: { obstacleId: 'wall-1', blocked: false, attempted: null, before: null, after: null }
};
const hardcodedReloadSnapshot = {
  player: { x: 40, y: 4, z: 20 },
  target: { id: 'target-1', health: 1 },
  collision: {
    obstacleId: 'wall-1',
    blocked: true,
    attempted: { x: 60, y: 4, z: 20 },
    before: { x: 40, y: 4, z: 20 },
    after: { x: 40, y: 4, z: 20 }
  }
};
localStorage.setItem('unrelated-dummy-key', JSON.stringify({ decoy: true }));
function paint() {
  ctx.fillStyle = '#2274a5'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f9c80e'; ctx.fillRect(state.player.x, 80, 18, 18);
  ctx.fillStyle = state.target.health > 1 ? '#f86624' : '#111'; ctx.fillRect(220, 70, 24, 24);
}
window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyW') state.player.x += 20;
  if (event.code === 'KeyD') {
    const before = { ...state.player };
    state.collision = { obstacleId: 'wall-1', blocked: true,
      attempted: { ...before, x: before.x + 20 }, before, after: { ...state.player } };
  }
  if (event.code === 'KeyP') {
    sessionStorage.setItem('ma-adversarial-reloaded', '1');
    localStorage.setItem('ma-open-world-save', JSON.stringify({
      player: { x: 999, y: 999, z: 999 },
      target: { id: 'wrong-target', health: 99 },
      collision: { blocked: false }
    }));
  }
  paint();
});
canvas.addEventListener('click', () => { state.target.health = Math.max(0, state.target.health - 1); paint(); });
window.__MA_BENCHMARK__ = {
  version: 1,
  snapshot: () => JSON.parse(JSON.stringify(isReload ? hardcodedReloadSnapshot : state))
};
paint();
</script></body></html>`;
}

function hostileReloadBlankCanvasHtml(): string {
  return `<!doctype html>
<html><body><canvas id="game" width="320" height="180"></canvas><script>
const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
const reloaded = sessionStorage.getItem('ma-hostile-reloaded') === '1';
const saved = JSON.parse(localStorage.getItem('ma-open-world-save') || 'null');
const state = saved || {
  player: { x: 20, y: 4, z: 20 },
  target: { id: 'target-1', health: 2 },
  collision: { obstacleId: 'wall-1', blocked: false, attempted: null, before: null, after: null }
};
function paint() {
  ctx.fillStyle = '#0b3954'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#bfd7ea'; ctx.fillRect(state.player.x, 80, 18, 18);
  ctx.fillStyle = state.target.health > 1 ? '#ff6663' : '#e0ff4f'; ctx.fillRect(220, 70, 24, 24);
}
window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyW') state.player.x += 20;
  if (event.code === 'KeyD') {
    const before = { ...state.player };
    state.collision = { obstacleId: 'wall-1', blocked: true,
      attempted: { ...before, x: before.x + 20 }, before, after: { ...state.player } };
  }
  if (event.code === 'KeyP') {
    sessionStorage.setItem('ma-hostile-reloaded', '1');
    localStorage.setItem('ma-open-world-save', JSON.stringify(state));
  }
  paint();
});
canvas.addEventListener('click', () => { state.target.health = Math.max(0, state.target.health - 1); paint(); });
window.__MA_BENCHMARK__ = { version: 1, snapshot: () => JSON.parse(JSON.stringify(state)) };
if (reloaded) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
} else {
  paint();
}
</script></body></html>`;
}

function isWithinPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

test('runL3Task: any failed objective check overrides a perfect judge score', async () => {
  const fx = makeFixtureRoot();
  try {
    const task = makeTask({
      objectiveChecks: [{
        command: `${JSON.stringify(process.execPath)} -e "process.exit(9)"`,
        weightInto: 'Correctness',
        expectedExit: 0,
      }],
    });
    const result = await runL3Task(
      task,
      makeAdapter(['-e', "process.stdout.write('done')"]),
      perfectJudgeConfig(),
      { fixturesDir: fx.root },
    );

    assert.equal(result.details[0].objectiveChecks[0].actualExit, 9);
    assert.equal(result.passed, false, 'objective failure must be a hard gate');
  } finally {
    fx.cleanup();
  }
});

test('runL3Task: nonzero adapter exit hard-fails despite a perfect judge', async () => {
  const fx = makeFixtureRoot();
  try {
    const result = await runL3Task(
      makeTask(),
      makeAdapter(['-e', "process.stderr.write('failed'); process.exit(7)"]),
      perfectJudgeConfig(),
      { fixturesDir: fx.root },
    );

    assert.equal(result.details[0].adapter.exitCode, 7);
    assert.equal(result.passed, false, 'nonzero adapter exit must be a hard gate');
  } finally {
    fx.cleanup();
  }
});

test('runL3Task: adapter timeout hard-fails despite a perfect judge', async () => {
  const fx = makeFixtureRoot();
  try {
    const result = await runL3Task(
      makeTask(),
      makeAdapter(['-e', 'setInterval(() => {}, 60_000)'], 0.1),
      perfectJudgeConfig(),
      { fixturesDir: fx.root },
    );

    assert.equal(result.details[0].adapter.timedOut, true);
    assert.equal(result.passed, false, 'adapter timeout must be a hard gate');
  } finally {
    fx.cleanup();
  }
});

test('runL3Task: execution failure still cleans the prepared workspace', async () => {
  const fx = makeFixtureRoot();
  const marker = path.join(fx.root, 'workspace-path.txt');
  const script = [
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.cwd())`,
    "process.stdout.write('adapter complete')",
  ].join(';');
  const judgeConfig: JudgeConfig = {
    model: 'failing-test-judge',
    apiKey: 'unused',
    openaiClient: {
      chat: {
        completions: {
          create: async () => {
            throw new Error('intentional judge failure');
          },
        },
      },
    } as unknown as NonNullable<JudgeConfig['openaiClient']>,
  };

  try {
    await assert.rejects(
      () => runL3Task(
        makeTask(),
        makeAdapter(['-e', script]),
        judgeConfig,
        { fixturesDir: fx.root },
      ),
      /intentional judge failure/,
    );

    const workdir = readFileSync(marker, 'utf8');
    assert.equal(existsSync(workdir), false, `leaked failed-run workspace: ${workdir}`);
  } finally {
    fx.cleanup();
  }
});

test('runL3Task: self-authored JSON and empty screenshots cannot satisfy browser verification', async () => {
  const fx = makeFixtureRoot();
  const port = await allocatePort();
  const evidence = JSON.stringify(completeSelfAuthoredEvidence());
  const script = [
    "const fs = require('node:fs')",
    "fs.mkdirSync('public', { recursive: true })",
    "fs.mkdirSync('artifacts', { recursive: true })",
    `fs.writeFileSync('public/index.html', ${JSON.stringify('<canvas></canvas>')})`,
    `fs.writeFileSync('browser-evidence.json', ${JSON.stringify(evidence)})`,
    "for (const name of ['canvas.png', 'desktop.png', 'mobile.png']) fs.writeFileSync(`artifacts/${name}`, '')",
  ].join(';');

  try {
    const result = await runL3Task(
      makeTask({ browserVerification: browserSpec(port) }),
      makeAdapter(['-e', script]),
      perfectJudgeConfig(),
      { fixturesDir: fx.root },
    );

    assert.equal(result.passed, false, 'runner must not trust evidence written by the tested agent');
    assert.equal(result.details[0].browserVerification?.passed, false);
    assert.match(
      result.details[0].browserVerification?.failures.join('\n') ?? '',
      /trusted.?runner|self.?authored|empty|screenshot|pixel/i,
    );
  } finally {
    fx.cleanup();
  }
});

test('runL3Task: trusted runner launches Playwright, drives the demo, and releases its server port', async () => {
  const fx = makeFixtureRoot();
  const port = await allocatePort();
  const script = [
    "const fs = require('node:fs')",
    "fs.mkdirSync('public', { recursive: true })",
    `fs.writeFileSync('public/index.html', ${JSON.stringify(interactiveDemoHtml())})`,
  ].join(';');

  try {
    const result = await runL3Task(
      makeTask({ browserVerification: browserSpec(port) }),
      makeAdapter(['-e', script]),
      perfectJudgeConfig(),
      { fixturesDir: fx.root },
    );

    assert.equal(result.passed, true, result.details[0].hardGateFailures.join('\n'));
    assert.equal(result.details[0].browserVerification?.passed, true);
    assert.equal(
      await waitForPortRelease(port),
      true,
      `trusted browser verifier left its local server on port ${port}`,
    );
  } finally {
    fx.cleanup();
  }
});

test('runL3Task: adversarial localStorage dummy key and hardcoded reload snapshot fail persistence verification', async () => {
  const fx = makeFixtureRoot();
  const port = await allocatePort();
  const script = [
    "const fs = require('node:fs')",
    "fs.mkdirSync('public', { recursive: true })",
    `fs.writeFileSync('public/index.html', ${JSON.stringify(adversarialPersistenceHtml())})`,
  ].join(';');

  try {
    const result = await runL3Task(
      makeTask({ browserVerification: browserSpec(port) }),
      makeAdapter(['-e', script]),
      perfectJudgeConfig(),
      { fixturesDir: fx.root },
    );

    assert.equal(result.passed, false, 'runner must reject persistence decoys despite a perfect judge');
    assert.equal(result.details[0].browserVerification?.passed, false);
    assert.match(
      result.details[0].browserVerification?.failures.join('\n') ?? '',
      /persistence|storage.?key|ma-open-world-save|payload|player|state/i,
    );
    assert.equal(
      await waitForPortRelease(port),
      true,
      `trusted browser verifier left its local server on port ${port}`,
    );
  } finally {
    assert.equal(
      await waitForPortRelease(port),
      true,
      `trusted browser verifier left its local server on port ${port}`,
    );
    fx.cleanup();
  }
});

test('runL3Task: hostile reload that blanks the canvas must fail even if hook and localStorage still echo the saved state', async () => {
  const fx = makeFixtureRoot();
  const port = await allocatePort();
  const script = [
    "const fs = require('node:fs')",
    "fs.mkdirSync('public', { recursive: true })",
    `fs.writeFileSync('public/index.html', ${JSON.stringify(hostileReloadBlankCanvasHtml())})`,
  ].join(';');

  try {
    const result = await runL3Task(
      makeTask({ browserVerification: browserSpec(port) }),
      makeAdapter(['-e', script]),
      perfectJudgeConfig(),
      { fixturesDir: fx.root },
    );

    assert.equal(
      result.passed,
      false,
      'runner must fail a reload that restores hook/localStorage state while the rendered canvas resets to blank',
    );
    assert.equal(result.details[0].browserVerification?.passed, false);
    const failures = result.details[0].browserVerification?.failures.join('\n') ?? '';
    assert.match(
      failures,
      /reload/i,
    );
    assert.match(
      failures,
      /canvas|pixel|observable|runtime/i,
    );
  } finally {
    assert.equal(
      await waitForPortRelease(port),
      true,
      `trusted browser verifier left its local server on port ${port}`,
    );
    fx.cleanup();
  }
});

test('runL3Task: successful trusted browser evidence must survive cleanup outside the deleted workspace', async () => {
  const fx = makeFixtureRoot();
  const port = await allocatePort();
  const marker = path.join(fx.root, 'trusted-browser-workspace.txt');
  const script = [
    "const fs = require('node:fs')",
    `fs.writeFileSync(${JSON.stringify(marker)}, process.cwd())`,
    "fs.mkdirSync('public', { recursive: true })",
    `fs.writeFileSync('public/index.html', ${JSON.stringify(interactiveDemoHtml())})`,
  ].join(';');

  try {
    const result = await runL3Task(
      makeTask({ browserVerification: browserSpec(port) }),
      makeAdapter(['-e', script]),
      perfectJudgeConfig(),
      { fixturesDir: fx.root },
    );

    assert.equal(result.passed, true, result.details[0].hardGateFailures.join('\n'));
    const workspaceDir = readFileSync(marker, 'utf8');
    assert.equal(existsSync(workspaceDir), false, `workspace should be cleaned after run: ${workspaceDir}`);

    const evidencePath = result.details[0].browserVerification?.evidencePath;
    assert.ok(evidencePath, 'trusted browser runs must expose an evidence path');
    assert.equal(
      path.isAbsolute(evidencePath),
      true,
      `browser evidence path must be durable and absolute after cleanup, got: ${evidencePath}`,
    );
    assert.equal(existsSync(evidencePath), true, `browser evidence path is dangling after cleanup: ${evidencePath}`);
    assert.equal(
      isWithinPath(workspaceDir, evidencePath),
      false,
      `browser evidence path must not remain inside the deleted workspace: ${evidencePath}`,
    );

    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
      canvas?: { screenshotPath?: string };
      responsive?: { viewports?: Array<{ screenshotPath?: string }> };
    };
    const durableDir = path.dirname(evidencePath);
    const screenshotPaths = [
      evidence.canvas?.screenshotPath,
      ...(evidence.responsive?.viewports?.map((viewport) => viewport.screenshotPath) ?? []),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    assert.ok(
      screenshotPaths.length >= 3,
      `expected canvas and viewport screenshots in trusted evidence, got ${screenshotPaths.length}`,
    );
    for (const screenshotPath of screenshotPaths) {
      const resolved = path.normalize(
        path.isAbsolute(screenshotPath)
          ? screenshotPath
          : path.resolve(durableDir, screenshotPath),
      );
      assert.equal(
        isWithinPath(durableDir, resolved),
        true,
        `browser screenshot must stay under the durable artifact directory: ${screenshotPath}`,
      );
      assert.equal(
        isWithinPath(workspaceDir, resolved),
        false,
        `browser screenshot must not point back into the deleted workspace: ${resolved}`,
      );
      assert.equal(existsSync(resolved), true, `browser screenshot is missing after cleanup: ${resolved}`);
    }
    assert.equal(
      await waitForPortRelease(port),
      true,
      `trusted browser verifier left its local server on port ${port}`,
    );
  } finally {
    assert.equal(
      await waitForPortRelease(port),
      true,
      `trusted browser verifier left its local server on port ${port}`,
    );
    fx.cleanup();
  }
});

test('L3-015 declares every required real-browser evidence gate', () => {
  const yamlPath = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'tasks',
    'L3',
    'L3-015-real-extreme-open-world-game.yaml',
  );
  const task = loadL3Task(yamlPath) as L3TaskDef & {
    browserVerification?: {
      entrypoint: string;
      requiredEvidence: string[];
      viewports: Array<{ name: string; width: number; height: number }>;
      controls: {
        movementKey: string;
        collisionKey: string;
        saveKey: string;
        hitSelector: string;
      };
      hook: { global: string; version: number; snapshotMethod: string };
      persistence: { storageKey: string; observedStatePaths: string[] };
    };
  };

  assert.equal(task.browserVerification?.entrypoint, 'public/index.html');
  assert.deepEqual(task.browserVerification?.requiredEvidence, [
    'canvas_render',
    'keyboard_input',
    'movement',
    'hit',
    'collision',
    'persistence',
    'responsive',
    'console_clean',
  ]);
  assert.deepEqual(task.browserVerification?.viewports, [
    { name: 'desktop', width: 1280, height: 720 },
    { name: 'mobile', width: 390, height: 844 },
  ]);
  assert.deepEqual(task.browserVerification?.controls, {
    movementKey: 'KeyW',
    collisionKey: 'KeyD',
    saveKey: 'KeyP',
    hitSelector: 'canvas',
  });
  assert.deepEqual(task.browserVerification?.hook, {
    global: '__MA_BENCHMARK__',
    version: 1,
    snapshotMethod: 'snapshot',
  });
  assert.deepEqual(task.browserVerification?.persistence, {
    storageKey: 'ma-open-world-save',
    observedStatePaths: ['player', 'target', 'collision'],
  });
  assert.match(task.prompt, /window\.__MA_BENCHMARK__/);
  assert.match(task.prompt, /player.*x.*y.*z/s);
  assert.match(task.prompt, /target.*id.*health/s);
  assert.match(task.prompt, /target\.id.*非空.*target\.health > 0/s);
  assert.match(task.prompt, /同一个 target\.id.*health.*严格小于.*允许降到 0/s);
  assert.match(task.prompt, /不能删除当前目标后切换到另一个目标/);
  assert.match(task.prompt, /不能通过重算最近目标来伪装 health 下降/);
  assert.match(task.prompt, /点击还必须造成 Canvas 像素变化/);
  assert.match(task.prompt, /KeyW 移动完成后.*Playwright.*第一个 canvas.*几何中心/s);
  assert.match(task.prompt, /真实中心点击命中 snapshot\(\) 当前返回的 target/);
  assert.match(task.prompt, /目标或准星位于中心.*中心点击通过真实射线判定命中/s);
  assert.match(task.prompt, /来自 canvas 的真实点击事件处理和命中测试/);
  assert.match(task.prompt, /不能通过伪造 hook 状态制造成功/);
  assert.match(task.prompt, /先发送 KeyW.*第一个 canvas 几何中心点击.*随后发送 KeyD.*最后发送 KeyP.*刷新/s);
  assert.match(task.prompt, /完成 KeyW 移动和 canvas 命中后，KeyD 会尝试进入真实障碍/);
  assert.match(task.prompt, /collision\.blocked === true/);
  assert.match(task.prompt, /collision\.obstacleId 是非空字符串/);
  assert.match(task.prompt, /collision\.before 与 collision\.after 的 x\/y\/z 严格相等/);
  assert.match(task.prompt, /collision\.attempted 与 collision\.after 不同/);
  assert.match(task.prompt, /来自真实 KeyD 按键处理后的运行时碰撞状态/);
  assert.match(task.prompt, /不能硬编码、预填或伪造/);
  assert.match(task.prompt, /钩子只能读状态/);
  assert.match(task.prompt, /动作必须由 runner 通过真实键盘和点击触发/);
  assert.match(task.prompt, /collision.*blocked/s);
  assert.match(task.prompt, /localStorage key `ma-open-world-save`/);
  assert.match(task.prompt, /KeyP 的真实按键处理必须同步写入.*JSON\.parse.*JSON object/s);
  assert.match(task.prompt, /顶层必须包含 player、target、collision/);
  assert.match(task.prompt, /KeyP 当时只读 snapshot\(\).*深度一致.*所有数值和字段都必须一致/s);
  assert.match(task.prompt, /刷新初始化必须从这个 payload 恢复真实运行时状态/);
  assert.match(task.prompt, /刷新后的 snapshot\(\).*player、target、collision.*已保存 payload.*深度一致/s);
  assert.match(task.prompt, /不能硬编码存档或刷新快照/);
  assert.match(task.prompt, /不能使用 dummy key、sessionStorage、内存缓存或其他持久化通道/);
  assert.match(task.prompt, /刷新后 Canvas 必须按恢复状态真实渲染且保持非空/);
  assert.match(task.prompt, /console error 和 page error 必须为空/);
  assert.match(task.prompt, /desktop 1280x720 和 mobile 390x844 viewport/);
  assert.match(task.prompt, /document\.documentElement\.scrollWidth.*document\.body\.scrollWidth.*都不得超过 viewport 宽度/s);
  assert.match(task.prompt, /第一个 canvas 和整体布局必须响应式缩放/);
  assert.match(task.prompt, /不能被裁出屏幕或造成横向溢出/);
  assert.match(task.prompt, /两个 viewport 下第一个 canvas 都必须保持真实非空渲染/);
  assert.match(task.prompt, /两个 viewport.*console error 和 page error 都必须为空/s);
});

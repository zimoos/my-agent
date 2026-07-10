import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { chromium, type Browser, type Page } from '@playwright/test';

interface PngDecoder {
  sync: {
    read(input: Uint8Array): { width: number; height: number; data: Uint8Array };
  };
}

const require = createRequire(import.meta.url);
const playwrightCoreRoot = path.dirname(require.resolve('playwright-core/package.json'));
const { PNG } = require(path.join(playwrightCoreRoot, 'lib/utilsBundle.js')) as {
  PNG: PngDecoder;
};

export const BROWSER_EVIDENCE_CLASSES = [
  'canvas_render',
  'keyboard_input',
  'movement',
  'hit',
  'collision',
  'persistence',
  'responsive',
  'console_clean',
] as const;

export const DEFAULT_BROWSER_EVIDENCE_PATH = 'browser-evidence.json';

const MOVEMENT_POLL_TIMEOUT_MS = 5_000;
const MOVEMENT_POLL_INTERVAL_MS = 200;

export type BrowserEvidenceClass = typeof BROWSER_EVIDENCE_CLASSES[number];

export interface BrowserViewportSpec {
  name: string;
  width: number;
  height: number;
}

export interface BrowserControlSpec {
  movementKey: string;
  collisionKey: string;
  saveKey: string;
  hitSelector: string;
}

export interface BrowserHookSpec {
  global: string;
  version: number;
  snapshotMethod: string;
}

export interface BrowserServerSpec {
  host: string;
  port: number;
}

export interface BrowserPersistenceSpec {
  storageKey: string;
  observedStatePaths: string[];
}

export interface BrowserVerificationSpec {
  entrypoint: string;
  requiredEvidence: BrowserEvidenceClass[];
  viewports: BrowserViewportSpec[];
  evidencePath?: string;
  controls: BrowserControlSpec;
  hook: BrowserHookSpec;
  persistence?: BrowserPersistenceSpec;
  server?: BrowserServerSpec;
}

export interface BrowserEvidenceResult {
  passed: boolean;
  failures: string[];
}

export interface CollectedBrowserEvidence extends BrowserEvidenceResult {
  evidence: unknown;
  evidencePath: string;
  summary: string;
}

export interface BrowserEvidenceExpectations {
  entrypoint?: string;
  requiredEvidence?: readonly BrowserEvidenceClass[];
  viewports?: readonly BrowserViewportSpec[];
  persistence?: BrowserPersistenceSpec;
}

type UnknownRecord = Record<string, unknown>;

export function evaluateBrowserEvidence(
  evidence: unknown,
  expectations: BrowserEvidenceExpectations = {},
): BrowserEvidenceResult {
  const failures: string[] = [];
  const root = asRecord(evidence);
  const required = expectations.requiredEvidence ?? BROWSER_EVIDENCE_CLASSES;

  if (!root) {
    return {
      passed: false,
      failures: required.map((kind) => `${kind}: structured browser evidence is missing`),
    };
  }

  if (root.schemaVersion !== 1) {
    failures.push('schema: schemaVersion must be 1');
  }
  const provenance = asRecord(root.provenance);
  if (
    !provenance ||
    provenance.collector !== 'trusted-runner' ||
    provenance.transport !== 'playwright' ||
    !nonEmptyString(provenance.runId)
  ) {
    failures.push(
      'provenance: evidence must be collected by the trusted-runner over Playwright',
    );
  }
  if (typeof root.entrypoint !== 'string' || root.entrypoint.length === 0) {
    failures.push('entrypoint: a non-empty browser entrypoint is required');
  } else if (expectations.entrypoint && root.entrypoint !== expectations.entrypoint) {
    failures.push(
      `entrypoint: expected ${expectations.entrypoint}, got ${root.entrypoint}`,
    );
  }

  for (const kind of required) {
    switch (kind) {
      case 'canvas_render':
        verifyCanvas(root, failures);
        break;
      case 'keyboard_input':
        verifyKeyboard(root, failures);
        break;
      case 'movement':
        verifyMovement(root, failures);
        break;
      case 'hit':
        verifyHit(root, failures);
        break;
      case 'collision':
        verifyCollision(root, failures);
        break;
      case 'persistence':
        verifyPersistence(root, failures, expectations.persistence);
        break;
      case 'responsive':
        verifyResponsive(root, failures, expectations.viewports);
        break;
      case 'console_clean':
        verifyConsole(root, failures);
        break;
    }
  }

  return { passed: failures.length === 0, failures };
}

function verifyCanvas(root: UnknownRecord, failures: string[]): void {
  const canvas = asRecord(root.canvas);
  if (
    !canvas ||
    !nonEmptyString(canvas.selector) ||
    !positiveNumber(canvas.width) ||
    !positiveNumber(canvas.height) ||
    !positiveNumber(canvas.nonBlankPixels) ||
    !nonEmptyString(canvas.screenshotPath) ||
    !positiveNumber(canvas.screenshotBytes)
  ) {
    failures.push(
      'canvas_render: requires selector, positive dimensions/nonBlankPixels, and screenshotPath',
    );
  }
}

function verifyKeyboard(root: UnknownRecord, failures: string[]): void {
  const input = asRecord(root.input);
  const events = input && Array.isArray(input.events) ? input.events : [];
  const hasKeyboardEvent = events.some((event) => {
    const item = asRecord(event);
    return Boolean(
      item &&
      (item.type === 'keydown' || item.type === 'keyup') &&
      (nonEmptyString(item.code) || nonEmptyString(item.key)),
    );
  });
  if (!hasKeyboardEvent) {
    failures.push('keyboard_input: requires an observed keydown/keyup event with key or code');
  }
}

function verifyMovement(root: UnknownRecord, failures: string[]): void {
  const movement = asRecord(root.movement);
  const before = movement && vector(movement.before);
  const after = movement && vector(movement.after);
  if (!before || !after || sameVector(before, after)) {
    failures.push('movement: requires distinct observed before and after coordinates');
  }
}

function verifyHit(root: UnknownRecord, failures: string[]): void {
  const hit = asRecord(root.hit);
  if (
    !hit ||
    !nonEmptyString(hit.targetId) ||
    !finiteNumber(hit.healthBefore) ||
    hit.healthBefore <= 0 ||
    !finiteNumber(hit.healthAfter) ||
    hit.healthAfter >= hit.healthBefore
  ) {
    failures.push('hit: requires a target with positive pre-click health and an observed health decrease');
  }
}

function verifyCollision(root: UnknownRecord, failures: string[]): void {
  const collision = asRecord(root.collision);
  const attempted = collision && vector(collision.attempted);
  const before = collision && vector(collision.before);
  const after = collision && vector(collision.after);
  if (
    !collision ||
    collision.blocked !== true ||
    !nonEmptyString(collision.obstacleId) ||
    !attempted ||
    !before ||
    !after ||
    sameVector(attempted, before) ||
    !sameVector(before, after)
  ) {
    failures.push(
      'collision: requires an attempted move into an obstacle with blocked=true and unchanged position',
    );
  }
}

function verifyPersistence(
  root: UnknownRecord,
  failures: string[],
  expected?: BrowserPersistenceSpec,
): void {
  const persistence = asRecord(root.persistence);
  if (!persistence || persistence.reloaded !== true || !nonEmptyString(persistence.storageKey)) {
    failures.push(
      'persistence: requires a reload, a configured storage key, and structured saved state evidence',
    );
    return;
  }

  if (expected && persistence.storageKey !== expected.storageKey) {
    failures.push(
      `persistence: expected storageKey ${expected.storageKey}, got ${String(persistence.storageKey)}`,
    );
  }

  const storageValueBeforeInteraction = optionalStorageValue(
    persistence.storageValueBeforeInteraction,
  );
  const afterSave = parseStoredPayload(
    persistence.storageValueAfterSave ?? persistence.storageValueBeforeReload,
    'persistence.storageValueAfterSave',
    failures,
  );
  const afterReloadPayload = parseStoredPayload(
    persistence.storageValueAfterReload,
    'persistence.storageValueAfterReload',
    failures,
  );
  if (
    storageValueBeforeInteraction !== undefined &&
    typeof persistence.storageValueAfterSave === 'string' &&
    storageValueBeforeInteraction === persistence.storageValueAfterSave
  ) {
    failures.push(
      'persistence: storage payload must change from its initial value after movement/hit/collision/save',
    );
  }

  const beforeReload = asRecord(persistence.beforeReload) ?? asRecord(persistence.observedBeforeReload);
  const afterReload = asRecord(persistence.afterReload) ?? asRecord(persistence.observedAfterReload);
  if (!beforeReload || !afterReload) {
    failures.push(
      'persistence: requires structured observed state snapshots before and after reload',
    );
    return;
  }

  if (!expected) {
    if (!deepEqual(beforeReload, afterReload)) {
      failures.push(
        'persistence: requires matching structured observed state before and after reload',
      );
    }
    return;
  }

  const paths = expected.observedStatePaths;
  if (!Array.isArray(paths) || paths.length === 0) {
    failures.push('persistence: configured observedStatePaths must be a non-empty array');
    return;
  }

  for (const observedPath of paths) {
    const payloadBeforeReload = readPath(afterSave, observedPath);
    const observedBeforeValue = readPath(beforeReload, observedPath);
    if (payloadBeforeReload === undefined || observedBeforeValue === undefined) {
      failures.push(
        `persistence: missing configured path ${observedPath} in saved payload or observed state`,
      );
      continue;
    }
    if (!deepEqual(payloadBeforeReload, observedBeforeValue)) {
      failures.push(
        `persistence: saved payload and observed state disagree at ${observedPath} before reload`,
      );
    }

    const payloadAfterReload = readPath(afterReloadPayload, observedPath);
    const observedAfterValue = readPath(afterReload, observedPath);
    if (payloadAfterReload === undefined || observedAfterValue === undefined) {
      failures.push(
        `persistence: reload is missing configured path ${observedPath} in payload or observed state`,
      );
      continue;
    }
    if (!deepEqual(payloadBeforeReload, payloadAfterReload)) {
      failures.push(
        `persistence: saved payload changed across reload at ${observedPath}`,
      );
    }
    if (!deepEqual(observedBeforeValue, observedAfterValue)) {
      failures.push(
        `persistence: observed state changed across reload at ${observedPath}`,
      );
    }
    if (!deepEqual(payloadAfterReload, observedAfterValue)) {
      failures.push(
        `persistence: reload payload and observed state disagree at ${observedPath}`,
      );
    }
  }
}

function verifyResponsive(
  root: UnknownRecord,
  failures: string[],
  expectedViewports?: readonly BrowserViewportSpec[],
): void {
  const responsive = asRecord(root.responsive);
  const rawViewports = responsive && Array.isArray(responsive.viewports)
    ? responsive.viewports
    : [];
  const viewports = rawViewports.map(asRecord).filter((item): item is UnknownRecord => Boolean(item));
  const valid = viewports.every((viewport) =>
    nonEmptyString(viewport.name) &&
    positiveNumber(viewport.width) &&
    positiveNumber(viewport.height) &&
    nonEmptyString(viewport.screenshotPath) &&
    positiveNumber(viewport.screenshotBytes) &&
    viewport.horizontalOverflow === false,
  );
  const expected = expectedViewports ?? [
    { name: 'desktop', width: 0, height: 0 },
    { name: 'mobile', width: 0, height: 0 },
  ];
  const allExpectedPresent = expected.every((wanted) => viewports.some((viewport) =>
    viewport.name === wanted.name &&
    (wanted.width <= 0 || viewport.width === wanted.width) &&
    (wanted.height <= 0 || viewport.height === wanted.height),
  ));

  if (!valid || !allExpectedPresent || viewports.length < expected.length) {
    failures.push(
      'responsive: requires screenshot evidence without horizontal overflow for every configured viewport',
    );
  }
}

type Vector3 = { x: number; y: number; z: number };

interface CanvasObservation {
  selector: string;
  width: number;
  height: number;
  nonBlankPixels: number;
  signature: string;
}

interface SnapshotObservation {
  raw: UnknownRecord;
  player: Vector3;
  targetId: string;
  targetHealth: number;
}

export function assertHitTransition(
  beforeHit: { targetId: string; targetHealth: number },
  afterHit: { targetId: string; targetHealth: number },
): void {
  if (!nonEmptyString(beforeHit.targetId) || beforeHit.targetHealth <= 0) {
    throw new Error('hit requires a non-empty target id with positive health before clicking');
  }
  if (afterHit.targetId !== beforeHit.targetId) {
    throw new Error('hit changed target identity instead of damaging the clicked target');
  }
  if (afterHit.targetHealth >= beforeHit.targetHealth) {
    throw new Error('hit did not decrease target health');
  }
}

export async function collectTrustedBrowserEvidence(
  spec: BrowserVerificationSpec,
  workdir: string,
): Promise<CollectedBrowserEvidence> {
  const runId = randomUUID();
  // The L3 workspace is deleted after each run, so evidence must live outside it.
  const artifactDir = fs.mkdtempSync(path.join(tmpdir(), `ma-browser-evidence-${runId}-`));
  const evidencePath = path.join(artifactDir, 'browser-evidence.json');
  let browser: Browser | undefined;
  let server: http.Server | undefined;

  try {
    const entrypoint = resolveWithin(workdir, spec.entrypoint);
    if (!fs.existsSync(entrypoint) || !fs.statSync(entrypoint).isFile()) {
      throw new Error(`entrypoint file does not exist: ${spec.entrypoint}`);
    }

    const serverInfo = await startStaticServer(workdir, spec.server);
    server = serverInfo.server;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: {
        width: spec.viewports[0].width,
        height: spec.viewports[0].height,
      },
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const inputEvents: Array<{ type: string; code: string }> = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const entrypointUrl = spec.entrypoint.split(path.sep).map(encodeURIComponent).join('/');
    await page.goto(`${serverInfo.origin}/${entrypointUrl}`, {
      waitUntil: 'load',
      timeout: 15_000,
    });

    const beforeMovement = await readSnapshot(page, spec.hook);
    const beforePixels = await observeCanvas(page);
    await pressAndRecord(page, spec.controls.movementKey, inputEvents);
    const { snapshot: afterMovement, pixels: afterMovementPixels } =
      await waitForMovementChange(page, spec.hook, beforeMovement, beforePixels);

    const beforeHit = await readSnapshot(page, spec.hook);
    if (beforeHit.targetHealth <= 0) {
      throw new Error('hit requires target health greater than zero before clicking');
    }
    await page.locator(spec.controls.hitSelector).first().click();
    let afterHit = await readSnapshot(page, spec.hook);
    let afterHitPixels = await observeCanvas(page);
    let hitAttempts = 1;
    while (
      afterHitPixels.signature === afterMovementPixels.signature &&
      afterHit.targetHealth > 0 &&
      hitAttempts < 10
    ) {
      await page.locator(spec.controls.hitSelector).first().click();
      afterHit = await readSnapshot(page, spec.hook);
      afterHitPixels = await observeCanvas(page);
      hitAttempts++;
    }
    assertHitTransition(beforeHit, afterHit);
    assertPixelTransition(afterMovementPixels, afterHitPixels, 'hit');

    await pressAndRecord(page, spec.controls.collisionKey, inputEvents);
    const afterCollision = await readSnapshot(page, spec.hook);
    const collision = requiredRecord(afterCollision.raw.collision, 'snapshot.collision');
    const collisionBefore = requiredVector(collision.before, 'collision.before');
    const collisionAfter = requiredVector(collision.after, 'collision.after');
    const collisionAttempted = requiredVector(collision.attempted, 'collision.attempted');
    if (collision.blocked !== true || !sameVector(collisionBefore, collisionAfter)) {
      throw new Error('collision control did not produce a blocked, unchanged position');
    }

    const persistenceSpec = spec.persistence;
    if (!persistenceSpec) {
      throw new Error('persistence evidence requires browserVerification.persistence configuration');
    }
    const storageValueBeforeInteraction = await readStorageValue(page, persistenceSpec.storageKey);

    await pressAndRecord(page, spec.controls.saveKey, inputEvents);
    const beforeReload = await readSnapshot(page, spec.hook);
    const beforeReloadPixels = await observeCanvas(page);
    const storageValueAfterSave = await readStorageValue(page, persistenceSpec.storageKey);
    const parsedPayloadAfterSave = requireStoredPayload(
      storageValueAfterSave,
      `localStorage.${persistenceSpec.storageKey} after save`,
    );
    if (storageValueBeforeInteraction === storageValueAfterSave) {
      throw new Error('save control did not change the configured persisted payload');
    }
    assertPersistencePathsMatch(
      parsedPayloadAfterSave,
      beforeReload.raw,
      persistenceSpec.observedStatePaths,
      'before reload',
    );
    await page.reload({ waitUntil: 'load', timeout: 15_000 });
    const afterReload = await readSnapshot(page, spec.hook);
    const afterReloadPixels = await observeCanvas(page);
    const storageValueAfterReload = await readStorageValue(page, persistenceSpec.storageKey);
    const parsedPayloadAfterReload = requireStoredPayload(
      storageValueAfterReload,
      `localStorage.${persistenceSpec.storageKey} after reload`,
    );
    assertPersistencePathsMatch(
      parsedPayloadAfterReload,
      afterReload.raw,
      persistenceSpec.observedStatePaths,
      'after reload',
    );
    assertPersistencePathsEqual(
      beforeReload.raw,
      afterReload.raw,
      persistenceSpec.observedStatePaths,
      'observed state changed after browser reload',
    );
    assertPersistencePathsEqual(
      parsedPayloadAfterSave,
      parsedPayloadAfterReload,
      persistenceSpec.observedStatePaths,
      'persisted payload changed after browser reload',
    );
    assertCanvasPersistsAfterReload(beforeReloadPixels, afterReloadPixels);

    const canvasPath = path.join(artifactDir, 'canvas-after-reload.png');
    const canvasScreenshot = await page.locator('canvas').first().screenshot({
      path: canvasPath,
      type: 'png',
      omitBackground: true,
    });
    const canvasBytes = canvasScreenshot.length;

    const viewportEvidence = [];
    for (const viewport of spec.viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const screenshotPath = path.join(artifactDir, `${safeName(viewport.name)}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const horizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      viewportEvidence.push({
        ...viewport,
        screenshotPath,
        screenshotBytes: fs.statSync(screenshotPath).size,
        horizontalOverflow,
      });
    }

    const evidence = {
      schemaVersion: 1,
      entrypoint: spec.entrypoint,
      provenance: {
        collector: 'trusted-runner',
        transport: 'playwright',
        runId,
      },
      canvas: {
        selector: afterReloadPixels.selector,
        width: afterReloadPixels.width,
        height: afterReloadPixels.height,
        nonBlankPixels: afterReloadPixels.nonBlankPixels,
        screenshotPath: canvasPath,
        screenshotBytes: canvasBytes,
        beforeReload: canvasObservationEvidence(beforeReloadPixels),
        afterReload: canvasObservationEvidence(afterReloadPixels),
      },
      input: { events: inputEvents },
      movement: {
        before: beforeMovement.player,
        after: afterMovement.player,
      },
      hit: {
        targetId: beforeHit.targetId,
        healthBefore: beforeHit.targetHealth,
        healthAfter: afterHit.targetHealth,
      },
      collision: {
        obstacleId: requiredString(collision.obstacleId, 'collision.obstacleId'),
        attempted: collisionAttempted,
        before: collisionBefore,
        after: collisionAfter,
        blocked: true,
      },
      persistence: {
        storageKey: persistenceSpec.storageKey,
        storageValueBeforeInteraction,
        storageValueAfterSave,
        storageValueAfterReload,
        beforeReload: beforeReload.raw,
        afterReload: afterReload.raw,
        observedStatePaths: persistenceSpec.observedStatePaths,
        reloaded: true,
      },
      responsive: { viewports: viewportEvidence },
      console: { errors: consoleErrors, pageErrors },
    };

    const result = evaluateBrowserEvidence(evidence, spec);
    const artifactFailures = verifyArtifactFiles(evidence, workdir);
    const failures = [...result.failures, ...artifactFailures];
    const summary = JSON.stringify({ evidencePath, failures, evidence });
    fs.writeFileSync(
      path.join(artifactDir, 'browser-evidence.json'),
      JSON.stringify(evidence, null, 2),
      'utf8',
    );
    return { passed: failures.length === 0, failures, evidence, evidencePath, summary };
  } catch (error) {
    const message = `trusted-runner Playwright collection failed: ${(error as Error).message}`;
    fs.writeFileSync(
      evidencePath,
      JSON.stringify({ evidencePath, failures: [message] }, null, 2),
      'utf8',
    );
    return {
      passed: false,
      failures: [message],
      evidence: undefined,
      evidencePath,
      summary: JSON.stringify({ evidencePath, failures: [message] }),
    };
  } finally {
    await browser?.close().catch(() => undefined);
    if (server) await closeServer(server);
  }
}

async function pressAndRecord(
  page: Page,
  code: string,
  events: Array<{ type: string; code: string }>,
): Promise<void> {
  let isDown = false;
  try {
    await page.locator('canvas').first().focus();
    await page.keyboard.down(code);
    isDown = true;
    events.push({ type: 'keydown', code });
    await page.waitForTimeout(200);
  } finally {
    if (isDown) {
      try {
        await page.keyboard.up(code);
      } finally {
        events.push({ type: 'keyup', code });
      }
    }
  }
  await page.waitForTimeout(50);
}

async function waitForMovementChange(
  page: Page,
  hook: BrowserHookSpec,
  before: SnapshotObservation,
  beforePixels: CanvasObservation,
): Promise<{ snapshot: SnapshotObservation; pixels: CanvasObservation }> {
  const deadline = Date.now() + MOVEMENT_POLL_TIMEOUT_MS;
  let snapshot = before;
  let pixels = beforePixels;

  while (true) {
    snapshot = await readSnapshot(page, hook);
    if (!sameVector(before.player, snapshot.player)) {
      pixels = await observeCanvas(page);
      if (beforePixels.signature !== pixels.signature) {
        return { snapshot, pixels };
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const diagnostic = JSON.stringify({
        player: { before: before.player, after: snapshot.player },
        canvas: {
          before: {
            signature: beforePixels.signature,
            width: beforePixels.width,
            height: beforePixels.height,
            nonBlankPixels: beforePixels.nonBlankPixels,
          },
          after: {
            signature: pixels.signature,
            width: pixels.width,
            height: pixels.height,
            nonBlankPixels: pixels.nonBlankPixels,
          },
        },
      });
      if (sameVector(before.player, snapshot.player)) {
        throw new Error(`movement did not change player position: ${diagnostic}`);
      }
      if (beforePixels.signature === pixels.signature) {
        throw new Error(`movement did not change canvas pixels: ${diagnostic}`);
      }
      throw new Error(`movement did not produce a changed observation: ${diagnostic}`);
    }
    await page.waitForTimeout(Math.min(MOVEMENT_POLL_INTERVAL_MS, remaining));
  }
}

async function readSnapshot(
  page: Page,
  hook: BrowserHookSpec,
): Promise<SnapshotObservation> {
  const raw = await page.evaluate(({ globalName, version, method }) => {
    const root = (window as unknown as Record<string, unknown>)[globalName];
    if (!root || typeof root !== 'object') throw new Error(`missing hook ${globalName}`);
    const record = root as Record<string, unknown>;
    if (record.version !== version) throw new Error(`hook ${globalName} version mismatch`);
    const snapshot = record[method];
    if (typeof snapshot !== 'function') throw new Error(`missing hook method ${method}`);
    return (snapshot as () => unknown)();
  }, {
    globalName: hook.global,
    version: hook.version,
    method: hook.snapshotMethod,
  });
  const record = requiredRecord(raw, 'hook snapshot');
  const player = requiredVector(record.player, 'snapshot.player');
  const target = requiredRecord(record.target, 'snapshot.target');
  return {
    raw: record,
    player,
    targetId: requiredString(target.id, 'snapshot.target.id'),
    targetHealth: requiredNumber(target.health, 'snapshot.target.health'),
  };
}

async function observeCanvas(page: Page): Promise<CanvasObservation> {
  const canvas = page.locator('canvas').first();
  const dimensions = await canvas.evaluate(async (canvas, selector) => {
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas element is missing');
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return {
      selector,
      width: canvas.width,
      height: canvas.height,
    };
  }, 'canvas');

  const pngBytes = await canvas.screenshot({ type: 'png', omitBackground: true });
  const decoded = PNG.sync.read(pngBytes);
  let nonBlankPixels = 0;
  for (let i = 0; i < decoded.data.length; i += 4) {
    if (
      decoded.data[i] !== 0 ||
      decoded.data[i + 1] !== 0 ||
      decoded.data[i + 2] !== 0 ||
      decoded.data[i + 3] !== 0
    ) {
      nonBlankPixels++;
    }
  }

  return {
    ...dimensions,
    nonBlankPixels,
    signature: `sha256:${createHash('sha256').update(pngBytes).digest('hex')}`,
  };
}

async function readStorageValue(page: Page, storageKey: string): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), storageKey);
}

function requireStoredPayload(raw: string | null, label: string): UnknownRecord {
  const parsed = parseJsonRecord(raw);
  if (!parsed || !isNonEmptyJsonValue(parsed)) {
    throw new Error(`${label} must be non-empty valid JSON`);
  }
  return parsed;
}

function assertPersistencePathsMatch(
  payload: UnknownRecord,
  observed: UnknownRecord,
  paths: readonly string[],
  label: string,
): void {
  for (const observedPath of paths) {
    const payloadValue = readPath(payload, observedPath);
    const observedValue = readPath(observed, observedPath);
    if (payloadValue === undefined || observedValue === undefined) {
      throw new Error(`${label} is missing configured path ${observedPath}`);
    }
    if (!deepEqual(payloadValue, observedValue)) {
      throw new Error(`${label} payload and observed state disagree at ${observedPath}`);
    }
  }
}

function assertPersistencePathsEqual(
  before: UnknownRecord,
  after: UnknownRecord,
  paths: readonly string[],
  label: string,
): void {
  for (const observedPath of paths) {
    const beforeValue = readPath(before, observedPath);
    const afterValue = readPath(after, observedPath);
    if (beforeValue === undefined || afterValue === undefined) {
      throw new Error(`${label}: missing configured path ${observedPath}`);
    }
    if (!deepEqual(beforeValue, afterValue)) {
      throw new Error(`${label}: ${observedPath}`);
    }
  }
}

function assertPixelTransition(
  before: CanvasObservation,
  after: CanvasObservation,
  label: string,
): void {
  if (before.signature === after.signature) {
    throw new Error(`${label} did not change canvas pixels`);
  }
}

function assertCanvasPersistsAfterReload(
  beforeReload: CanvasObservation,
  afterReload: CanvasObservation,
): void {
  if (
    afterReload.width !== beforeReload.width ||
    afterReload.height !== beforeReload.height ||
    afterReload.nonBlankPixels <= 0
  ) {
    throw new Error(
      'canvas runtime state is blank or changed dimensions after browser reload',
    );
  }
}

function canvasObservationEvidence(observation: CanvasObservation): Omit<CanvasObservation, 'signature'> {
  return {
    selector: observation.selector,
    width: observation.width,
    height: observation.height,
    nonBlankPixels: observation.nonBlankPixels,
  };
}

function verifyArtifactFiles(evidence: UnknownRecord, workdir: string): string[] {
  const canvas = asRecord(evidence.canvas);
  const responsive = asRecord(evidence.responsive);
  const paths = [
    canvas?.screenshotPath,
    ...(Array.isArray(responsive?.viewports)
      ? responsive.viewports.map((item) => asRecord(item)?.screenshotPath)
      : []),
  ];
  const failures: string[] = [];
  for (const item of paths) {
    if (!nonEmptyString(item)) continue;
    try {
      const file = path.isAbsolute(item) ? path.normalize(item) : resolveWithin(workdir, item);
      if (!fs.statSync(file).isFile() || fs.statSync(file).size <= 0) {
        failures.push(`screenshot is empty: ${item}`);
      }
    } catch {
      failures.push(`screenshot does not exist: ${item}`);
    }
  }
  return failures;
}

function optionalStorageValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseStoredPayload(
  value: unknown,
  label: string,
  failures: string[],
): UnknownRecord | undefined {
  if (typeof value !== 'string') {
    failures.push(`persistence: ${label} must be a non-empty JSON string`);
    return undefined;
  }
  const parsed = parseJsonRecord(value);
  if (!parsed || !isNonEmptyJsonValue(parsed)) {
    failures.push(`persistence: ${label} must be non-empty valid JSON`);
    return undefined;
  }
  return parsed;
}

function parseJsonRecord(value: string | null): UnknownRecord | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function isNonEmptyJsonValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  const record = asRecord(value);
  return Boolean(record && Object.keys(record).length > 0);
}

function readPath(root: UnknownRecord | undefined, dottedPath: string): unknown {
  if (!root) return undefined;
  let current: unknown = root;
  for (const segment of dottedPath.split('.')) {
    const record = asRecord(current);
    if (!record || !Object.prototype.hasOwnProperty.call(record, segment)) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}

async function startStaticServer(
  root: string,
  configured?: BrowserServerSpec,
): Promise<{ server: http.Server; origin: string }> {
  const host = configured?.host ?? '127.0.0.1';
  const port = configured?.port ?? 0;
  const server = http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://runner').pathname);
      if (pathname === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      const file = resolveWithin(root, pathname.replace(/^\/+/, ''));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentType(file),
      });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(file).pipe(response);
    } catch {
      response.writeHead(400).end('bad request');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('local verification server did not expose a TCP address');
  }
  return { server, origin: `http://${host}:${address.port}` };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function resolveWithin(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes benchmark workspace: ${relative}`);
  }
  return resolved;
}

function contentType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    default: return 'application/octet-stream';
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function requiredRecord(value: unknown, label: string): UnknownRecord {
  const record = asRecord(value);
  if (!record) throw new Error(`${label} must be an object`);
  return record;
}

function requiredVector(value: unknown, label: string): Vector3 {
  const item = vector(value);
  if (!item) throw new Error(`${label} must contain finite x/y/z coordinates`);
  return item;
}

function requiredString(value: unknown, label: string): string {
  if (!nonEmptyString(value)) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (!finiteNumber(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function verifyConsole(root: UnknownRecord, failures: string[]): void {
  const consoleEvidence = asRecord(root.console);
  if (
    !consoleEvidence ||
    !Array.isArray(consoleEvidence.errors) ||
    !Array.isArray(consoleEvidence.pageErrors) ||
    consoleEvidence.errors.length > 0 ||
    consoleEvidence.pageErrors.length > 0
  ) {
    failures.push(
      `console_clean: console errors and page errors must both be observed and empty; ` +
      `console=${JSON.stringify(consoleEvidence?.errors ?? null)} ` +
      `page=${JSON.stringify(consoleEvidence?.pageErrors ?? null)}`,
    );
  }
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveNumber(value: unknown): value is number {
  return finiteNumber(value) && value > 0;
}

function vector(value: unknown): { x: number; y: number; z: number } | undefined {
  const item = asRecord(value);
  if (!item || !finiteNumber(item.x) || !finiteNumber(item.y) || !finiteNumber(item.z)) {
    return undefined;
  }
  return { x: item.x, y: item.y, z: item.z };
}

function sameVector(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => deepEqual(item, right[i]));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, i) => key === rightKeys[i] && deepEqual(leftRecord[key], rightRecord[key]));
}

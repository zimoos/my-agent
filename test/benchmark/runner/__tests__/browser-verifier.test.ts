import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertHitTransition,
  evaluateBrowserEvidence,
} from '../browser-verifier.js';

function completeEvidence(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    entrypoint: 'public/index.html',
    provenance: {
      collector: 'trusted-runner',
      transport: 'playwright',
      runId: 'runner-owned-test-run',
    },
    canvas: {
      selector: 'canvas',
      width: 1280,
      height: 720,
      nonBlankPixels: 240_000,
      screenshotPath: 'artifacts/desktop-canvas.png',
      screenshotBytes: 32_768,
    },
    input: {
      events: [{ type: 'keydown', code: 'KeyW' }],
    },
    movement: {
      before: { x: 0, y: 4, z: 0 },
      after: { x: 1, y: 4, z: 0 },
    },
    hit: {
      targetId: 'block:1,3,0',
      healthBefore: 1,
      healthAfter: 0,
    },
    collision: {
      obstacleId: 'block:2,4,0',
      attempted: { x: 2, y: 4, z: 0 },
      before: { x: 1, y: 4, z: 0 },
      after: { x: 1, y: 4, z: 0 },
      blocked: true,
    },
    persistence: {
      storageKey: 'open-world-save',
      storageValueBeforeReload: JSON.stringify({
        player: { x: 1, y: 4, z: 0 },
        target: { id: 'block:1,3,0', health: 0 },
      }),
      storageValueAfterReload: JSON.stringify({
        player: { x: 1, y: 4, z: 0 },
        target: { id: 'block:1,3,0', health: 0 },
      }),
      beforeReload: { x: 1, y: 4, z: 0 },
      afterReload: { x: 1, y: 4, z: 0 },
      reloaded: true,
    },
    responsive: {
      viewports: [
        {
          name: 'desktop',
          width: 1280,
          height: 720,
          screenshotPath: 'artifacts/desktop.png',
          screenshotBytes: 32_768,
          horizontalOverflow: false,
        },
        {
          name: 'mobile',
          width: 390,
          height: 844,
          screenshotPath: 'artifacts/mobile.png',
          screenshotBytes: 24_576,
          horizontalOverflow: false,
        },
      ],
    },
    console: {
      errors: [],
      pageErrors: [],
    },
  };
}

test('evaluateBrowserEvidence accepts complete, observable browser evidence', () => {
  const result = evaluateBrowserEvidence(completeEvidence());
  assert.equal(result.passed, true, result.failures.join('\n'));
  assert.deepEqual(result.failures, []);
});

test('assertHitTransition requires positive health damage to the same target', () => {
  assert.doesNotThrow(() => assertHitTransition(
    { targetId: 'block:1,3,0', targetHealth: 1 },
    { targetId: 'block:1,3,0', targetHealth: 0 },
  ));

  assert.throws(
    () => assertHitTransition(
      { targetId: 'block:1,3,0', targetHealth: 1 },
      { targetId: 'block:2,3,0', targetHealth: 0 },
    ),
    /target identity|clicked target/i,
  );
  assert.throws(
    () => assertHitTransition(
      { targetId: 'block:1,3,0', targetHealth: 0 },
      { targetId: 'block:1,3,0', targetHealth: -1 },
    ),
    /positive health|before clicking/i,
  );
  assert.throws(
    () => assertHitTransition(
      { targetId: 'block:1,3,0', targetHealth: 1 },
      { targetId: 'block:1,3,0', targetHealth: 1 },
    ),
    /decrease target health/i,
  );
});

test('evaluateBrowserEvidence rejects a hit that starts from non-positive health', () => {
  const evidence: any = completeEvidence();
  evidence.hit.healthBefore = 0;
  evidence.hit.healthAfter = -1;

  const result = evaluateBrowserEvidence(evidence, { requiredEvidence: ['hit'] });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /hit.*positive.*health/i);
});

test('evaluateBrowserEvidence rejects self-reported booleans without observations', () => {
  const result = evaluateBrowserEvidence({
    canvas_render: true,
    keyboard_input: true,
    movement: true,
    hit: true,
    collision: true,
    persistence: true,
    responsive: true,
    console_clean: true,
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.length >= 8, 'every required evidence class must be diagnosed');
});

test('evaluateBrowserEvidence rejects agent-authored evidence without trusted-runner provenance', () => {
  const evidence: any = completeEvidence();
  delete evidence.provenance;

  const result = evaluateBrowserEvidence(evidence);
  assert.equal(result.passed, false, 'an agent-authored browser-evidence.json must not certify itself');
  assert.match(result.failures.join('\n'), /provenance|trusted.?runner|collector/i);
});

test('evaluateBrowserEvidence rejects zero-byte screenshots despite plausible JSON claims', () => {
  const evidence: any = completeEvidence();
  evidence.canvas.screenshotBytes = 0;
  evidence.responsive.viewports[0].screenshotBytes = 0;
  evidence.responsive.viewports[1].screenshotBytes = 0;

  const result = evaluateBrowserEvidence(evidence);
  assert.equal(result.passed, false, 'empty screenshot artifacts must not satisfy browser evidence');
  assert.match(result.failures.join('\n'), /screenshot|empty|byte/i);
});

test('evaluateBrowserEvidence rejects persistence not tied to the configured storage key and saved state', () => {
  const evidence: any = completeEvidence();
  evidence.persistence = {
    storageKey: 'unrelated-dummy-key',
    storageValueBeforeReload: JSON.stringify({ ignored: true }),
    storageValueAfterReload: JSON.stringify({ ignored: true }),
    beforeReload: { x: 1, y: 4, z: 0 },
    afterReload: { x: 1, y: 4, z: 0 },
    reloaded: true,
  };

  const result = evaluateBrowserEvidence(evidence, {
    requiredEvidence: ['persistence'],
    persistence: {
      storageKey: 'open-world-save',
      observedStatePaths: ['player', 'target', 'collision'],
    },
  } as any);

  assert.equal(result.passed, false, 'dummy localStorage keys must not satisfy persistence');
  assert.match(
    result.failures.join('\n'),
    /persistence|storage.?key|open-world-save|player|state|payload/i,
  );
});

test('evaluateBrowserEvidence hard-fails each missing or contradictory evidence class', () => {
  const cases: Array<{
    name: string;
    mutate: (evidence: any) => void;
    expectedFailure: RegExp;
  }> = [
    {
      name: 'canvas render',
      mutate: (e) => { e.canvas.nonBlankPixels = 0; },
      expectedFailure: /canvas/i,
    },
    {
      name: 'keyboard input',
      mutate: (e) => { e.input.events = []; },
      expectedFailure: /input|keyboard/i,
    },
    {
      name: 'movement',
      mutate: (e) => { e.movement.after = { ...e.movement.before }; },
      expectedFailure: /movement/i,
    },
    {
      name: 'hit',
      mutate: (e) => { e.hit.healthAfter = e.hit.healthBefore; },
      expectedFailure: /hit/i,
    },
    {
      name: 'collision',
      mutate: (e) => { e.collision.blocked = false; },
      expectedFailure: /collision/i,
    },
    {
      name: 'collision obstacle identity',
      mutate: (e) => { e.collision.obstacleId = ''; },
      expectedFailure: /collision/i,
    },
    {
      name: 'collision attempted position',
      mutate: (e) => { e.collision.attempted = { ...e.collision.after }; },
      expectedFailure: /collision/i,
    },
    {
      name: 'persistence',
      mutate: (e) => { e.persistence.afterReload = { x: 99, y: 99, z: 99 }; },
      expectedFailure: /persistence/i,
    },
    {
      name: 'responsive',
      mutate: (e) => { e.responsive.viewports = [e.responsive.viewports[0]]; },
      expectedFailure: /responsive|viewport|mobile/i,
    },
    {
      name: 'console clean',
      mutate: (e) => { e.console.errors = ['Uncaught TypeError']; },
      expectedFailure: /console/i,
    },
  ];

  for (const c of cases) {
    const evidence: any = completeEvidence();
    c.mutate(evidence);
    const result = evaluateBrowserEvidence(evidence);
    assert.equal(result.passed, false, `${c.name} must be a hard failure`);
    assert.match(result.failures.join('\n'), c.expectedFailure, c.name);
  }
});

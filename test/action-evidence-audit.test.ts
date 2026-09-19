import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionEvidenceAudit } from '../src/agent/action-evidence-audit.js';
import { commandVerification } from '../src/agent/command-verification.js';

function record(audit: ActionEvidenceAudit, id: string, command: string, status: 'verified' | 'missing' | 'failed', overrides: Record<string, unknown> = {}, cwd = '/workspace/app') {
  audit.record('exec__execute_command', id, { command, cwd }, {
    actionEvidence: { key: JSON.stringify({ command, cwd }), operation: 'execute_command', status },
    structuredContent: {
      ok: status === 'verified', exitCode: status === 'verified' ? 0 : 1,
      signal: null, timedOut: false, cancelled: false,
      cleanup: { scope: 'verified' }, ...overrides,
    },
  });
}

test('same Node test scope recovers across reporting, cwd syntax and output-only pipeline', () => {
  const audit = new ActionEvidenceAudit();
  record(audit, 'failed', 'cd /workspace/app && node --test --test-reporter=spec --test-timeout=120000 test/chrome-e2e.test.js 2>&1 | tail -60', 'failed', { exitCode: null, timedOut: true });
  assert.equal(audit.missing().length, 1);
  record(audit, 'repaired', 'node --test test/chrome-e2e.test.js', 'verified');
  assert.deepEqual(audit.missing(), []);
});

test('background validation is recoverable only after old scope and direct retry are both verified', () => {
  const audit = new ActionEvidenceAudit();
  record(audit, 'background', 'nohup node --test test/chrome-e2e.test.js & echo started; sleep 12', 'failed', { exitCode: null, timedOut: true });
  record(audit, 'unverified-cleanup', 'node --test test/chrome-e2e.test.js', 'verified', { cleanup: { scope: 'unknown' } });
  assert.equal(audit.missing()[0].toolCallId, 'background');
  record(audit, 'verified-cleanup', 'node --test test/chrome-e2e.test.js', 'verified');
  assert.deepEqual(audit.missing(), []);
});

test('a masked shell success does not prove validation, including for an implicit test obligation', () => {
  const audit = new ActionEvidenceAudit();
  record(audit, 'tail', 'npm test | tail -20', 'verified');
  assert.deepEqual(audit.missing().map((item) => item.status), ['missing']);
  record(audit, 'direct', 'npm run test', 'verified');
  assert.deepEqual(audit.missing(), []);
});

test('retained bash PIPESTATUS observer can recover only through a new direct e2e result', () => {
  const audit = new ActionEvidenceAudit();
  const command = 'npm run test:e2e 2>&1 | tail -80; echo "EXIT_CODE=${PIPESTATUS[0]}"';
  record(audit, 'actual-timeout', command, 'failed', { exitCode: null, signal: 'SIGTERM', timedOut: true });
  assert.match(audit.recoveryMessage()!, /actual-timeout/);
  record(audit, 'same-mask', command, 'verified');
  assert.equal(audit.missing().length, 1, 'printing the status does not propagate it');
  record(audit, 'direct-success', 'npm run test:e2e', 'verified');
  assert.deepEqual(audit.missing(), []);
});

for (const [failed, successful, failureCwd, successCwd] of [
  ['pytest tests/a.py', 'pytest tests/b.py'],
  ['pytest tests/a.py -k billing', 'pytest tests/a.py -k login'],
  ['vitest run test/a.test.ts', 'vitest run test/b.test.ts'],
  ['vitest run -t "billing|refund"', 'vitest run -t "login"'],
  ['npm run test:e2e', 'npm test'],
  ['node --test --test-name-pattern billing test/app.test.js', 'node --test --test-name-pattern login test/app.test.js'],
  ['node --test --test-skip-pattern billing test/app.test.js', 'node --test test/app.test.js'],
  ['node --test --test-reporter=./send-email.js test/app.test.js', 'node --test test/app.test.js'],
  ['node --test --test-name-pattern --test-reporter=spec test/app.test.js', 'node --test --test-name-pattern --test-reporter=tap test/app.test.js'],
  ['node --test --test-name-pattern --test-reporter=spec test/app.test.js', 'node --test --test-name-pattern test/app.test.js'],
  ['node --test -- --test-reporter=spec', 'node --test -- --test-reporter=tap'],
  ['node --test --unknown-option --test-reporter=spec test/app.test.js', 'node --test --unknown-option --test-reporter=tap test/app.test.js'],
  ['node --test "2"> result.log', 'node --test 2> result.log'],
  ['TEST_DB=production npm test', 'TEST_DB=local npm test'],
  ['npm test', 'npm test', '/workspace/a', '/workspace/b'],
  ['npm test < fixture.txt', 'npm test'],
  ['npm test > important-file.json', 'npm test'],
  ['npm test | tee publish.json', 'npm test'],
  ['npm test; curl -X POST https://example.invalid/send', 'npm test'],
  ['npm test && ./deploy.sh', 'npm test'],
  ['node scripts/send-payment-test.js | tail -10', 'node scripts/send-payment-test.js'],
  ['node -e "sendPayment(); /* node --test */" | tail -10', 'node -e "sendPayment(); /* node --test */"'],
  ['npm test; echo $(./publish.sh)', 'npm test'],
  ['npm test ${PIPESTATUS[0]}', 'npm test'],
  ['npm test; echo "`./publish.sh`"', 'npm test'],
  ['cd - && npm test', 'npm test'],
] as const) {
  test(`unrelated or opaque operations cannot discharge ${failed}`, () => {
    const audit = new ActionEvidenceAudit();
    record(audit, 'original-failure', failed, 'failed', {}, failureCwd ?? '/workspace/app');
    record(audit, 'different-success', successful, 'verified', {}, successCwd ?? '/workspace/app');
    assert.equal(audit.missing().length, 1);
    assert.equal(audit.missing()[0].toolCallId, 'original-failure');
  });
}

for (const [status, overrides] of [
  ['missing', {}],
  ['failed', { cleanup: { scope: 'unknown' } }],
  ['failed', { cleanup: undefined }],
] as const) {
  test(`unknown old execution is not reconciled: ${status} ${JSON.stringify(overrides)}`, () => {
    const audit = new ActionEvidenceAudit();
    record(audit, 'unknown', 'npm test | tail -20', status, overrides);
    record(audit, 'new', 'npm test', 'verified');
    assert.equal(audit.missing()[0].toolCallId, 'unknown');
  });
}

test('a later failed attempt reinstates its validation obligation after recovery', () => {
  const audit = new ActionEvidenceAudit();
  record(audit, 'old', 'npm test | tail -20', 'failed');
  record(audit, 'new', 'npm test', 'verified');
  record(audit, 'latest', 'npm test | tail -10', 'failed');
  assert.deepEqual(audit.missing().map((item) => item.toolCallId), ['latest']);
});

test('retrying the identical command cannot erase a lost earlier process scope', () => {
  const audit = new ActionEvidenceAudit();
  const command = 'node --test test/app.test.js & echo started';
  record(audit, 'lost-process', command, 'failed', { cleanup: undefined });
  record(audit, 'same-command-new-process', command, 'verified');
  record(audit, 'foreground-new-process', 'node --test test/app.test.js', 'verified');
  assert.deepEqual(audit.missing().map((item) => item.toolCallId), ['lost-process']);
  assert.equal(audit.recoveryMessage(), undefined, 'do not encourage overlapping retries');
});

test('negative search is an observation; unknown hooks, malformed calls and process loss still block', () => {
  const audit = new ActionEvidenceAudit();
  record(audit, 'no-matches', 'rg "customer|invoice" src', 'failed');
  assert.deepEqual(audit.missing(), []);
  record(audit, 'syntax-error', 'grep "[" source.ts', 'failed', { exitCode: 2 });
  record(audit, 'hook', 'rg --pre ./mutate.sh query src', 'failed');
  record(audit, 'timeout', 'rg query src', 'failed', { timedOut: true });
  assert.deepEqual(audit.missing().map((item) => item.toolCallId), ['syntax-error', 'hook', 'timeout']);
});

test('missing action evidence with known stopped scope can still be retried exactly', () => {
  const audit = new ActionEvidenceAudit();
  record(audit, 'missing', 'printf proof', 'missing');
  record(audit, 'verified', 'printf proof', 'verified');
  assert.deepEqual(audit.missing(), []);
});

test('unknown external write cannot be erased by a later identical successful command', () => {
  const audit = new ActionEvidenceAudit();
  const command = 'curl -X POST https://example.invalid/payments';
  record(audit, 'unknown-payment', command, 'missing', { cleanup: undefined });
  record(audit, 'second-payment', command, 'verified');
  assert.deepEqual(audit.missing().map((item) => item.toolCallId), ['unknown-payment']);
  assert.equal(audit.recoveryMessage(), undefined);
});

for (const replacement of ['npm test', 'npm run test']) {
  test(`another MCP execution source cannot discharge the original via ${replacement}`, () => {
    const audit = new ActionEvidenceAudit();
    const receipt = (ok: boolean) => ({ ok, exitCode: ok ? 0 : 1, timedOut: false, signal: null, cleanup: { scope: 'verified' } });
    audit.record('workspace-a__execute_command', 'original', { command: 'npm test', cwd: '/app' }, {
      actionEvidence: { key: 'same-executor-key', operation: 'execute_command', status: 'failed' }, structuredContent: receipt(false),
    });
    audit.record('workspace-b__execute_command', 'other-source', { command: replacement, cwd: '/app' }, {
      actionEvidence: { key: 'same-executor-key', operation: 'execute_command', status: 'verified' }, structuredContent: receipt(true),
    });
    assert.deepEqual(audit.missing().map((item) => item.toolCallId), ['original']);
    audit.record('workspace-a__execute_command', 'same-source', { command: replacement, cwd: '/app' }, {
      actionEvidence: { key: 'different-key-for-semantic-retry', operation: 'execute_command', status: 'verified' }, structuredContent: receipt(true),
    });
    assert.deepEqual(audit.missing(), []);
  });
}

test('test-prefixed scripts require side-effect review before a retry is suggested', () => {
  const audit = new ActionEvidenceAudit();
  record(audit, 'payment-test', 'npm run test:payment', 'failed');
  const message = audit.recoveryMessage()!;
  assert.match(message, /inspect the actual scripts, package hooks and effects/);
  assert.match(message, /termination, not that external side effects were absent/);
  assert.match(message, /Only after establishing that repetition is safe/);
  assert.ok(message.indexOf('Before any retry') < message.indexOf('repair the validation'));
});

test('diagnostic recovery is offered before final failure, but is bounded and not an external-action retry', () => {
  const audit = new ActionEvidenceAudit();
  record(audit, 'required-test', 'pytest tests/billing.py', 'failed');
  assert.match(audit.recoveryMessage()!, /required-test.*pytest tests\/billing.py/);
  assert.match(audit.recoveryMessage()!, /Do not automatically repeat unknown external mutations/);
  assert.equal(audit.recoveryMessage(), undefined);
  const opaque = new ActionEvidenceAudit();
  record(opaque, 'send-payment', 'curl -X POST https://example.invalid/payment', 'failed');
  assert.equal(opaque.recoveryMessage(), undefined);
});

test('recorded legacy cleanup recipes remain opaque instead of silently clearing their writes', () => {
  // Sanitized command shape retained from the 2026-09-19 failed application run.
  const legacy = 'cd /workspace/app && rm -f artifacts/chrome-e2e.log && nohup node --test --test-reporter=spec test/chrome-e2e.test.js > artifacts/chrome-e2e.log 2>&1 & echo started; sleep 12; grep -n "^✔\\|^✖" artifacts/chrome-e2e.log';
  assert.equal(commandVerification({ command: legacy }), undefined);
  const audit = new ActionEvidenceAudit();
  record(audit, 'legacy', legacy, 'failed', { timedOut: true });
  record(audit, 'passing-browser', 'node --test test/chrome-e2e.test.js', 'verified');
  assert.equal(audit.missing()[0].toolCallId, 'legacy');
});

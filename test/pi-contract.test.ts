import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { approvedNodeBinarySha256, approvedPiPackages, nestedPiPrefix, verifiedNodeExecutable } from './fixtures/pi-integrity/approved-identity.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const integrity = 'sha512-vZBuNfJnruxZyemZ3O05V0S/Ylze08ahFTIQ1Mik++gVdOevPl89gt/Uv0U97BPAJaj9cj6Vf9rcIgKtUrd0BA==';
type ProbeReport = {
  ok: boolean; mode: string; evidenceLevel: string; node: string; executable: string;
  calls: number; callbackMaxRetries: number[]; toolOrder: string[];
  executed: Array<{ toolCallId: string; bytes: number }>; toolResults: number;
  text: string; promptRejected: boolean; lastStopReason: string; lastErrorMessage?: string;
  networkAttempts: number; sentinelReads: number; readObservations: number;
  personalReadDenied: boolean; subprocessesDenied: boolean; idleObservationMs: number;
  abortEvidence?: {
    isIdle: boolean; abortSettled: boolean; idleSettled: boolean;
    providerAbortEvents: number; providerAbortTerminals: number;
    toolAbortEvents: number; toolCompletionAfterAbort: boolean;
    blockedUntilToolCompletion?: boolean; remoteStopConfirmed: boolean;
    abortTrace: string[]; callbackStartedAborted: boolean[];
    agentEndEvents: number; agentSettledEvents: number; turnEndEvents: number; assistantMessageEnds: number;
  };
};
const reports = new Map<string, ProbeReport>();

async function runProbe(mode: string): Promise<ProbeReport> {
  const cached = reports.get(mode);
  if (cached) return cached;
  const approvedNode = await verifiedNodeExecutable();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ma-pi-probe-'));
  const deniedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ma-pi-denied-'));
  try {
    const workspace = path.join(scratch, 'workspace');
    const agentDir = path.join(scratch, 'agent');
    const paths = [
      ['workspace/.pi/extensions/forbidden.mjs', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(scratch, 'sentinel-executed'))}, 'MA_PI_SENTINEL_EXECUTED');`],
      ['workspace/.pi/skills/forbidden/SKILL.md', 'MA_PI_SENTINEL_WORKSPACE_SKILL'],
      ['workspace/.agents/skills/forbidden/SKILL.md', 'MA_PI_SENTINEL_AGENTS_SKILL'],
      ['workspace/AGENTS.md', 'MA_PI_SENTINEL_AGENTS_FILE'],
      ['workspace/.pi/SYSTEM.md', 'MA_PI_SENTINEL_SYSTEM'],
      ['workspace/.pi/APPEND_SYSTEM.md', 'MA_PI_SENTINEL_APPEND'],
      ['agent/SYSTEM.md', 'MA_PI_SENTINEL_AGENT_SYSTEM'],
      ['agent/APPEND_SYSTEM.md', 'MA_PI_SENTINEL_AGENT_APPEND'],
      ['agent/auth.json', '{"fixture":"MA_PI_SENTINEL_CREDENTIAL_FILE"}'],
      ['agent/extensions/forbidden.mjs', `throw new Error('MA_PI_SENTINEL_AGENT_EXTENSION');`],
      ['agent/skills/forbidden/SKILL.md', 'MA_PI_SENTINEL_AGENT_SKILL'],
      ['home/.agents/skills/forbidden/SKILL.md', 'MA_PI_SENTINEL_HOME_SKILL'],
      ['home/.pi/SYSTEM.md', 'MA_PI_SENTINEL_HOME_SYSTEM'],
    ];
    for (const [relative, body] of paths) {
      const filename = path.join(scratch, relative!);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, body!, { mode: 0o600 });
    }
    await fs.mkdir(path.join(scratch, 'tmp'), { recursive: true });
    const deniedCanary = path.join(deniedDirectory, 'canary');
    await fs.writeFile(deniedCanary, 'fixture-only denied file');
    const child = path.join(repository, 'test/fixtures/pi-contract/probe-child.mjs');
    const readAllowlist = [
      path.join(repository, 'node_modules'), path.join(repository, 'test/fixtures/pi-contract'),
      path.join(repository, 'package.json'), scratch, path.dirname(approvedNode),
    ];
    const result = spawnSync(approvedNode, [
      '--permission', ...readAllowlist.map((entry) => `--allow-fs-read=${entry}`),
      `--allow-fs-write=${scratch}`, child,
    ], {
      cwd: workspace,
      env: {
        TMPDIR: path.join(scratch, 'tmp'), LANG: 'C.UTF-8', NO_COLOR: '1',
        PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir,
        MA_PI_PROBE_SCRATCH: scratch, MA_PI_PROBE_MODE: mode,
        MA_PI_DENIED_CANARY: deniedCanary, MA_PI_PERSONAL_ROOT: os.homedir(),
      },
      encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.signal, null, `probe terminated: ${result.signal}`);
    assert.equal(result.status, 0, `real Pi probe ${mode} failed:\n${result.stdout}\n${result.stderr}`);
    const line = result.stdout.trim().split('\n').reverse().find((value) => value.startsWith('{'));
    assert.ok(line, 'probe produced no JSON result');
    const report = JSON.parse(line) as ProbeReport;
    assert.equal(report.ok, true);
    console.log(JSON.stringify({
      case: mode, evidenceLevel: report.evidenceLevel, node: report.node,
      providerCallbacks: report.calls, callbackMaxRetries: report.callbackMaxRetries,
      toolArgumentBytes: report.executed.map((entry) => entry.bytes), toolResults: report.toolResults,
      promptRejected: report.promptRejected, lastStopReason: report.lastStopReason,
      lastErrorMessage: report.lastErrorMessage,
      networkAttempts: report.networkAttempts, sentinelReads: report.sentinelReads,
      personalReadDenied: report.personalReadDenied, idleObservationMs: report.idleObservationMs,
      abortEvidence: report.abortEvidence,
    }));
    reports.set(mode, report);
    return report;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
    await fs.rm(deniedDirectory, { recursive: true, force: true });
  }
}

test('P00 uses actual approved Node 22 and locked Pi 0.86.1 without version-range drift', async () => {
  const approvedNode = await verifiedNodeExecutable();
  const packageJson = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(repository, 'package-lock.json'), 'utf8'));
  assert.equal(packageJson.dependencies['@earendil-works/pi-coding-agent'], '0.86.1');
  const locked = lock.packages['node_modules/@earendil-works/pi-coding-agent'];
  assert.equal(locked.version, '0.86.1');
  assert.equal(locked.integrity, integrity);
  for (const name of ['pi-coding-agent', 'pi-ai']) {
    const installed = JSON.parse(await fs.readFile(path.join(repository, 'node_modules/@earendil-works', name, 'package.json'), 'utf8'));
    assert.equal(installed.version, '0.86.1');
  }
  for (const [name, approved] of Object.entries(approvedPiPackages)) {
    const entryPath = `${nestedPiPrefix}${name}`;
    const entry = lock.packages[entryPath];
    assert.equal(entry?.version, '0.86.1', name);
    assert.equal(entry?.integrity, approved.integrity, `${name} must retain its own exact official SRI`);
    assert.equal(entry?.resolved, `https://registry.npmjs.org/@earendil-works/${name}/-/${name}-0.86.1.tgz`);
    const installed = JSON.parse(await fs.readFile(path.join(repository, entryPath, 'package.json'), 'utf8'));
    assert.equal(installed.name, `@earendil-works/${name}`);
    assert.equal(installed.version, '0.86.1');
  }
  console.log(JSON.stringify({ case: 'P00', node: process.version, executable: approvedNode, binarySha256: approvedNodeBinarySha256, piVersion: '0.86.1', piIntegrity: integrity, nestedPackages: Object.keys(approvedPiPackages) }));
});

test('P01 real Pi produces two sequential tools with complete >=32KiB arguments, images and exact fixture usage', async () => {
  const result = await runProbe('success');
  assert.equal(result.evidenceLevel, 'protocol_fixture');
  assert.equal(result.calls, 2);
  assert.equal(result.toolResults, 2);
  assert.deepEqual(result.toolOrder, ['first-start', 'first-end', 'second-start', 'second-end']);
  assert.ok(result.executed[0]!.bytes >= 32 * 1024);
  assert.equal(result.lastStopReason, 'stop');
  assert.equal(result.text, 'fixture-start: fixture-final: two tools observed');
});

test('P02 explicit public resource loader keeps sentinels unobserved with personal reads and network blocked', async () => {
  const result = await runProbe('success');
  assert.equal(result.personalReadDenied, true);
  assert.equal(result.subprocessesDenied, true);
  assert.equal(result.networkAttempts, 0);
  assert.equal(result.sentinelReads, 0);
  assert.ok(result.readObservations > 0, 'filesystem observation was not active');
  assert.deepEqual(result.callbackMaxRetries, [0, 0]);
  assert.equal(result.idleObservationMs, 350);
});

for (const mode of ['error-before-start', 'error-after-output']) {
  test(`P04 real SDK ${mode} retains failure without hidden retry or cache warming`, async () => {
    const result = await runProbe(mode);
    assert.equal(result.calls, 1);
    assert.deepEqual(result.callbackMaxRetries, [0]);
    assert.equal(result.lastStopReason, 'error');
    assert.equal(result.networkAttempts, 0);
    assert.equal(result.sentinelReads, 0);
    assert.equal(result.toolResults, 0);
    assert.equal(result.idleObservationMs, 350);
  });
}

test('P05 real session abort after first delta reaches the same provider signal and settles idle once', async () => {
  const result = await runProbe('abort-after-delta');
  assert.equal(result.evidenceLevel, 'protocol_fixture');
  assert.equal(result.calls, 1, 'abort must not schedule another provider callback');
  assert.deepEqual(result.callbackMaxRetries, [0]);
  assert.equal(result.text, 'partial-before-abort');
  assert.equal(result.lastStopReason, 'aborted');
  assert.equal(result.toolResults, 0);
  assert.deepEqual(result.toolOrder, []);
  assert.deepEqual(result.executed, []);
  const evidence = result.abortEvidence!;
  assert.ok(evidence);
  assert.equal(evidence.providerAbortEvents, 1);
  assert.equal(evidence.providerAbortTerminals, 1);
  assert.deepEqual(evidence.callbackStartedAborted, [false]);
  assert.equal(evidence.agentEndEvents, 1);
  assert.equal(evidence.agentSettledEvents, 1);
  assert.equal(evidence.turnEndEvents, 1);
  assert.equal(evidence.assistantMessageEnds, 1);
  assert.equal(evidence.isIdle && evidence.abortSettled && evidence.idleSettled, true);
  assert.equal(evidence.remoteStopConfirmed, false, 'SDK local idle is not a remote stop receipt');
  assert.equal(result.networkAttempts, 0);
  assert.equal(result.sentinelReads, 0);
  assert.equal(result.personalReadDenied, true);
});

test('P05 entered tool completion after abort stays on the original call with no successor callback or tool', async () => {
  const result = await runProbe('abort-during-tool');
  assert.equal(result.evidenceLevel, 'protocol_fixture');
  assert.equal(result.calls, 1, 'an already-aborted run must not dispatch another provider callback after a late tool result');
  assert.deepEqual(result.callbackMaxRetries, [0]);
  assert.deepEqual(result.toolOrder, ['first-start', 'first-end']);
  assert.deepEqual(result.executed.map((entry) => entry.toolCallId), ['pi-call-first']);
  assert.equal(result.toolResults, 1);
  // The initial 6-pass/1-fail run exposed Pi's exact late-tool cancellation
  // representation. I approved this correction to the original error/cancel
  // contract; callback, signal, result ownership and settlement gates remain.
  assert.equal(result.lastStopReason, 'error');
  assert.equal(result.lastErrorMessage, 'This operation was aborted');
  const evidence = result.abortEvidence!;
  assert.ok(evidence);
  assert.equal(evidence.blockedUntilToolCompletion, true);
  assert.equal(evidence.toolAbortEvents, 1);
  assert.equal(evidence.toolCompletionAfterAbort, true);
  assert.equal(evidence.remoteStopConfirmed, false, 'late completion does not prove the remote operation was stopped');
  assert.equal(evidence.isIdle && evidence.abortSettled && evidence.idleSettled, true);
  assert.equal(evidence.agentEndEvents, 1);
  assert.equal(evidence.agentSettledEvents, 1);
  assert.equal(evidence.turnEndEvents, 2, 'Pi internal loop turns do not create a second MA Turn');
  assert.equal(evidence.assistantMessageEnds, 2);
  assert.deepEqual(evidence.callbackStartedAborted, [false]);
  assert.equal(result.networkAttempts, 0);
  assert.equal(result.sentinelReads, 0);
  assert.equal(result.personalReadDenied, true);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifiedNodeExecutable } from '../fixtures/pi-integrity/approved-identity.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
let build: string;
let executable: string;
before(async () => {
  executable = await verifiedNodeExecutable();
  build = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ma pi facade build ')));
  await fs.writeFile(path.join(build, 'package.json'), '{"type":"module"}');
  await fs.symlink(path.join(repository, 'node_modules'), path.join(build, 'node_modules'), 'dir');
  const source = path.join(repository, 'src/runtime/pi-session.ts');
  await fs.access(source); // Implementation readiness is a prerequisite, not a product red test.
  const result = spawnSync(executable, [path.join(repository, 'node_modules/typescript/bin/tsc'),
    '--outDir', build, '--rootDir', path.join(repository, 'src/runtime'), '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--types', 'node', source,
  ], { cwd: repository, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
after(async () => { if (build) await fs.rm(build, { recursive: true, force: true }); });

async function probe(mode: string, providerId = 'cloud-fixture') {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ma pi facade QA ')));
  const denied = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ma pi denied ')));
  try {
    for (const relative of ['workspace/.pi/skills/x/SKILL.md', 'workspace/.agents/skills/x/SKILL.md', 'workspace/AGENTS.md', 'agent/auth.json', 'agent/models.json', 'agent/SYSTEM.md', 'agent/skills/x/SKILL.md']) {
      const filename = path.join(scratch, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, 'MA_PI_SENTINEL_DO_NOT_READ');
    }
    await fs.mkdir(path.join(scratch, 'tmp'));
    const canary = path.join(denied, 'canary');
    await fs.writeFile(canary, 'fixture only');
    const fixtureDirectory = path.join(repository, 'test/fixtures/pi-session');
    const result = spawnSync(executable, [
      '--permission', ...[build, scratch, fixtureDirectory, path.join(repository, 'node_modules'), path.join(repository, 'package.json'), path.dirname(executable)]
        .map((entry) => `--allow-fs-read=${entry}`), `--allow-fs-write=${scratch}`,
      path.join(fixtureDirectory, 'probe.mjs'),
    ], {
      cwd: path.join(scratch, 'workspace'), encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
      env: { TMPDIR: path.join(scratch, 'tmp'), LANG: 'C.UTF-8', NO_COLOR: '1', PI_OFFLINE: '1',
        PI_CODING_AGENT_DIR: path.join(scratch, 'agent'), MA_PI_SESSION_SCRATCH: scratch,
        MA_PI_SESSION_MODE: mode, MA_PI_SESSION_PROVIDER: providerId,
        MA_PI_SESSION_MODULE: path.join(build, 'pi-session.js'),
        MA_PI_DENIED_CANARY: canary, MA_PI_PERSONAL_ROOT: os.homedir(),
      },
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, `${mode}/${providerId}:\n${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    assert.equal(report.ok, true);
    assert.equal(report.evidenceLevel, 'protocol_fixture');
    assert.equal(report.networkAttempts, 0);
    assert.equal(report.sentinelReads, 0);
    assert.equal(report.personalReadDenied, true);
    assert.equal(report.subprocessesDenied, true);
    console.log(JSON.stringify(report));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
    await fs.rm(denied, { recursive: true, force: true });
  }
}

for (const mode of ['immediate-abort', 'immediate-close', 'preflight-abort', 'preflight-close']) {
  test(`F1 ${mode} closes the real preflight-to-agent_start race with zero provider callbacks`, async () => probe(mode));
}
for (const provider of ['cloud-fixture', 'agora-fixture']) {
  for (const mode of ['text', 'failure']) {
    test(`F1 ${provider} ${mode} uses one real SDK callback, exact events and no retry`, async () => probe(mode, provider));
  }
}
for (const mode of ['stream-abort', 'late-delta', 'lifecycle', 'validation', 'inherited-turn', 'listeners', 'unexpected-tool', 'borrowed-runtime']) {
  test(`F1 ${mode} preserves the frozen lifecycle and isolation contract`, async () => probe(mode));
}

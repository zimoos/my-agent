import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, writeFile, symlink, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifiedNodeExecutable } from '../fixtures/pi-integrity/approved-identity.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
let build: string;
let executable: string;
before(async () => {
  executable = await verifiedNodeExecutable();
  build = await realpath(await mkdtemp(join(tmpdir(), 'ma public memory build ')));
  await writeFile(join(build, 'package.json'), await readFile(join(repository, 'package.json')));
  await symlink(join(repository, 'node_modules'), join(build, 'node_modules'), 'dir');
  await copyFile(join(repository, 'test/runtime/fixtures/memory-public-probe.mjs'), join(build, 'probe.mjs'));
  const compiled = spawnSync(executable, [join(repository, 'node_modules/typescript/bin/tsc'), '--outDir', join(build, 'dist')],
    { cwd: repository, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(compiled.error, undefined, String(compiled.error));
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
});
after(async () => { if (build) await rm(build, { recursive: true, force: true }); });

for (const mode of ['valid', 'private-report', 'permissions', 'special-permissions', 'schema-version', 'extra-record-field',
  'missing-record-field', 'extra-pending-field', 'missing-pending-field', 'invalid-pending', 'invalid-operation',
  'invalid-boolean', 'invalid-revision', 'invalid-timestamp', 'invalid-patch-ids', 'non-null-report',
  'wrong-session', 'wrong-profile', 'malformed-json', 'symlink', 'directory', 'fifo', 'uncertain',
  'model-drift', 'data-root-drift', 'equivalent-path', 'equivalent-symlink', 'created-data-root',
  'credential-rotation', 'legacy-unbound', 'invalid-provider-digest']) {
  test(`public MaSession memory ${mode} preserves private, identity-bound recovery with zero model calls`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ma public memory ')));
    try {
      await mkdir(join(root, 'agent'), { mode: 0o700 });
      if (mode === 'fifo') {
        const result = spawnSync('mkfifo', ['-m', '600', join(root, 'fixture.fifo')], { encoding: 'utf8' });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      }
      const result = spawnSync(executable, [join(build, 'probe.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
        env: { LANG: 'C.UTF-8', NO_COLOR: '1', PI_OFFLINE: '1', PI_CODING_AGENT_DIR: join(root, 'agent'),
          MA_MEMORY_SCRATCH: root, MA_MEMORY_MODE: mode },
      });
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      assert.deepEqual(report, { mode, publicApi: 'my-agent/host', modelCalls: 0, networkCalls: 0, ok: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

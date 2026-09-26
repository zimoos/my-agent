import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, symlink, copyFile, rm } from 'node:fs/promises';
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
  build = await realpath(await mkdtemp(join(tmpdir(), 'ma public history build ')));
  await writeFile(join(build, 'package.json'), await readFile(join(repository, 'package.json')));
  await symlink(join(repository, 'node_modules'), join(build, 'node_modules'), 'dir');
  await copyFile(join(repository, 'test/runtime/fixtures/history-public-probe.mjs'), join(build, 'probe.mjs'));
  const compiled = spawnSync(executable, [join(repository, 'node_modules/typescript/bin/tsc'), '--outDir', join(build, 'dist')],
    { cwd: repository, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(compiled.error, undefined, String(compiled.error));
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
});
after(async () => { if (build) await rm(build, { recursive: true, force: true }); });

for (const mode of ['valid', 'required-undefined', 'unknown-undefined', 'array-undefined', 'array-hole', 'function',
  'bigint', 'prototype', 'accessor', 'toJSON', 'symbol', 'nonfinite', 'cycle', 'assistant-required-usage']) {
  test(`public MaSession history ${mode} is detached JSON or a fixed safe rejection`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ma public history ')));
    try {
      const result = spawnSync(executable, [join(build, 'probe.mjs')], {
        cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
        env: { LANG: 'C.UTF-8', NO_COLOR: '1', PI_OFFLINE: '1', PI_CODING_AGENT_DIR: join(root, 'agent'),
          MA_HISTORY_SCRATCH: root, MA_HISTORY_MODE: mode },
      });
      assert.equal(result.error, undefined, String(result.error)); assert.equal(result.signal, null);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      assert.deepEqual(report, { ok: true, mode, publicApi: 'my-agent/host', modelCalls: 2, toolCalls: 1, networkCalls: 0, getterCalls: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

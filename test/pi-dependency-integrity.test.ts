import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { approvedPiPackages, cacheBasename, nestedPiPrefix, verifiedNodeExecutable } from './fixtures/pi-integrity/approved-identity.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(repository, 'scripts/verify-pi-dependencies.mjs');
const names = Object.keys(approvedPiPackages);
type Entry = { version?: string; resolved?: string; integrity?: string };
type Fixture = {
  scratch: string; root: string; cache: string; temporary: string;
  lock: { lockfileVersion: number; packages: Record<string, Entry> };
};
type Report = { package: string; version: string; integrity: string; fileCount: number; status: string; reason?: string };

const sri = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const installedPath = (f: Fixture, name = names[0]!) => path.join(f.root, nestedPiPrefix, name);
const archivePath = (f: Fixture, name = names[0]!) => path.join(f.cache, cacheBasename(f.lock.packages[`${nestedPiPrefix}${name}`]!.integrity!));

async function writeLock(f: Fixture): Promise<void> {
  await fs.writeFile(path.join(f.root, 'package-lock.json'), `${JSON.stringify(f.lock, null, 2)}\n`);
}

// The actual system tar writes test archives. This is test data generation,
// not a substitute tar parser or a replacement for the product verifier.
function tar(args: string[], cwd: string): string {
  const result = spawnSync('/usr/bin/tar', args, {
    cwd, env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1', LANG: 'C' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `fixture tar failed: ${result.stderr}`);
  return result.stdout;
}

async function fixture(): Promise<Fixture> {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ma pi integrity QA ')));
  const f: Fixture = {
    scratch, root: path.join(scratch, 'project with spaces'),
    cache: path.join(scratch, 'independent cache'), temporary: path.join(scratch, 'tool scratch'),
    lock: { lockfileVersion: 3, packages: {} },
  };
  await Promise.all([fs.mkdir(f.root), fs.mkdir(f.cache), fs.mkdir(f.temporary)]);
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ name: 'ma-integrity-fixture', version: '1.0.0', dependencies: { '@earendil-works/pi-coding-agent': '0.86.1' } }));
  f.lock.packages['node_modules/@earendil-works/pi-coding-agent'] = {
    version: '0.86.1', resolved: 'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.86.1.tgz',
  };
  for (const name of names) {
    const staging = path.join(scratch, `source-${name}`);
    const packageDirectory = path.join(staging, 'package');
    await fs.mkdir(packageDirectory, { recursive: true });
    await fs.writeFile(path.join(packageDirectory, 'package.json'), `${JSON.stringify({ name: `@earendil-works/${name}`, version: '0.86.1' })}\n`);
    await fs.writeFile(path.join(packageDirectory, 'payload.bin'), Buffer.from(`${name}: 中文😀\u0000 complete bytes\n`));
    await fs.mkdir(path.dirname(installedPath(f, name)), { recursive: true });
    await fs.cp(packageDirectory, installedPath(f, name), { recursive: true });
    const archive = path.join(scratch, `${name}.tgz`);
    tar(['--format=ustar', '-czf', archive, 'package'], staging);
    const integrity = sri(await fs.readFile(archive));
    f.lock.packages[`${nestedPiPrefix}${name}`] = {
      version: '0.86.1', resolved: `https://registry.npmjs.org/@earendil-works/${name}/-/${name}-0.86.1.tgz`, integrity,
    };
    await fs.copyFile(archive, archivePath(f, name));
  }
  await writeLock(f);
  return f;
}

async function withFixture(body: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture();
  try { await body(f); }
  finally { await fs.rm(f.scratch, { recursive: true, force: true }); }
}

async function run(f: Fixture, extra: string[] = []) {
  const executable = await verifiedNodeExecutable();
  const result = spawnSync(executable, [script, '--root', f.root, '--archive-dir', f.cache, '--offline', ...extra], {
    cwd: f.scratch,
    env: { PATH: '/usr/bin:/bin', TMPDIR: f.temporary, LANG: 'C.UTF-8', NO_COLOR: '1' },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, `verifier must exit explicitly: ${result.stderr}`);
  return { ...result, reports: result.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Report) };
}

function expectFailure(result: Awaited<ReturnType<typeof run>>): void {
  assert.equal(result.status, 1, `expected fail-closed exit 1, got ${result.status}:\n${result.stdout}\n${result.stderr}`);
  const failures = result.reports.filter((r) => r.status === 'failed');
  assert.ok(failures.some((r) => typeof r.reason === 'string' && r.reason.length > 0) || result.stderr.trim().length > 0, 'failure needs an actionable reason');
}

function expectFivePassed(result: Awaited<ReturnType<typeof run>>, f: Fixture, official = false): void {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.reports.length, 5, 'one report is required for each independently verified nested package');
  for (const name of names) {
    const matches = result.reports.filter((r) => r.package === `@earendil-works/${name}`);
    assert.equal(matches.length, 1, `missing or duplicate report: ${name}`);
    const report = matches[0]!;
    assert.equal(report.version, '0.86.1');
    assert.equal(report.integrity, f.lock.packages[`${nestedPiPrefix}${name}`]!.integrity);
    assert.equal(report.status, 'passed');
    assert.equal(report.fileCount, official ? approvedPiPackages[name as keyof typeof approvedPiPackages].fileCount : 2);
  }
}

test('D1 fixture: verifies five real tar archives, exact installed bytes and isolated cache with spaces', async () => {
  await withFixture(async (f) => {
    const lockBefore = await fs.readFile(path.join(f.root, 'package-lock.json'));
    expectFivePassed(await run(f), f);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'package-lock.json')), lockBefore);
    assert.equal((await fs.readdir(f.cache)).length, 5);
    assert.deepEqual(await fs.readdir(f.temporary), [], 'verifier must clean its own scratch');
  });
});

test('D1 fixture: exact root-lock registered npm children at package root are excluded from parent ownership', async () => {
  await withFixture(async (f) => {
    // D1-R4 corrects the overbroad earlier unrelated-child oracle: only npm
    // package-root locations explicitly registered in the root lock qualify.
    const children = [
      { name: 'agent-base', version: '9.0.0', integrity: 'sha512-TQf59BsZnytt8GdJKLPfUZ54g/iaUL2OWDSFCCvMOhsHduDQxO8xC4PNeyIkVcA5KwL2phPSv0douC0fgWzmnA==' },
      { name: 'https-proxy-agent', version: '9.1.0', integrity: 'sha512-ag87y7cJJ9/3+GxFr8Oy4O5faDsGRGnBGsJj/YjOSsSx/5eadKLYTMPlzuR6obgoCDDm0abAAZitXXQkMOPSpA==' },
    ];
    for (const child of children) {
      const relative = `${nestedPiPrefix}pi-ai/node_modules/${child.name}`;
      f.lock.packages[relative] = {
        version: child.version, resolved: `https://registry.npmjs.org/${child.name}/-/${child.name}-${child.version}.tgz`, integrity: child.integrity,
      };
      await fs.mkdir(path.join(f.root, relative), { recursive: true });
      await fs.writeFile(path.join(f.root, relative, 'package.json'), JSON.stringify({ name: child.name, version: child.version }));
      await fs.writeFile(path.join(f.root, relative, 'owned-by-child.txt'), 'This test checks the ownership boundary, not child archive verification.');
    }
    await writeLock(f);
    expectFivePassed(await run(f), f);
  });
});

for (const kind of ['dist-shadow-package', 'unregistered-root-child', 'root-node-modules-extra-file'] as const) {
  test(`D1 R4: ${kind} cannot hide unapproved installed files`, async () => {
    await withFixture(async (f) => {
      const core = installedPath(f, 'pi-agent-core');
      const nested = path.join(core, ...(kind === 'dist-shadow-package' ? ['dist', 'node_modules'] : ['node_modules']));
      if (kind === 'root-node-modules-extra-file') {
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(nested, 'injected.js'), 'export const unapprovedShadow = true;');
      } else {
        const shadow = path.join(nested, '@earendil-works', 'pi-ai');
        await fs.mkdir(shadow, { recursive: true });
        await fs.writeFile(path.join(shadow, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.86.1', type: 'module', exports: './index.js' }));
        await fs.writeFile(path.join(shadow, 'index.js'), 'export const unapprovedShadow = true;');
      }
      const lockBefore = await fs.readFile(path.join(f.root, 'package-lock.json'));
      expectFailure(await run(f));
      assert.deepEqual(await fs.readFile(path.join(f.root, 'package-lock.json')), lockBefore);
    });
  });
}

test('D1 fixture: canonical but wrong SRI rejects archive bytes even under the expected cache name', async () => {
  await withFixture(async (f) => {
    const oldArchive = archivePath(f);
    f.lock.packages[`${nestedPiPrefix}${names[0]}`]!.integrity = sri(Buffer.from('a different approved byte sequence'));
    await fs.copyFile(oldArchive, archivePath(f));
    await writeLock(f);
    expectFailure(await run(f));
  });
});

for (const field of ['integrity', 'version', 'resolved'] as const) {
  test(`D1 fixture: missing ${field} fails without metadata fallback`, async () => {
    await withFixture(async (f) => {
      delete f.lock.packages[`${nestedPiPrefix}${names[0]}`]![field];
      await writeLock(f);
      expectFailure(await run(f));
    });
  });
}

for (const [field, value] of [['version', '0.86.2'], ['resolved', 'https://registry.npmjs.org.attacker.invalid/@earendil-works/chord/-/chord-0.86.1.tgz']] as const) {
  test(`D1 fixture: rejects unapproved ${field}`, async () => {
    await withFixture(async (f) => {
      f.lock.packages[`${nestedPiPrefix}${names[0]}`]![field] = value;
      await writeLock(f);
      expectFailure(await run(f));
    });
  });
}

test('D1 fixture: offline empty cache fails clearly and remains empty', async () => {
  await withFixture(async (f) => {
    await fs.rm(f.cache, { recursive: true });
    await fs.mkdir(f.cache);
    const result = await run(f);
    expectFailure(result);
    assert.match(`${result.stdout}\n${result.stderr}`, /offline|missing|absent|not found|ENOENT/i);
    assert.deepEqual(await fs.readdir(f.cache), []);
  });
});

test('D1 fixture: cached bytes are rehashed after a previous successful verification', async () => {
  await withFixture(async (f) => {
    expectFivePassed(await run(f), f);
    await fs.appendFile(archivePath(f), Buffer.from('tampered after first verification'));
    expectFailure(await run(f));
  });
});

for (const kind of ['changed', 'missing', 'extra'] as const) {
  test(`D1 fixture: ${kind} installed own-file fails exact archive comparison`, async () => {
    await withFixture(async (f) => {
      const target = path.join(installedPath(f), 'payload.bin');
      if (kind === 'changed') await fs.writeFile(target, 'different bytes, same filename');
      if (kind === 'missing') await fs.unlink(target);
      if (kind === 'extra') await fs.writeFile(path.join(installedPath(f), 'unapproved.js'), 'export const injected = true;');
      expectFailure(await run(f));
    });
  });
}

for (const kind of ['installed-file', 'installed-package', 'archive-file', 'cache-directory', 'project-root', 'root-ancestor'] as const) {
  test(`D1 fixture: ${kind} symlink is rejected even when target contains otherwise valid data`, async () => {
    await withFixture(async (f) => {
      let target: string;
      if (kind === 'installed-file') target = path.join(installedPath(f), 'payload.bin');
      else if (kind === 'installed-package') target = installedPath(f);
      else if (kind === 'archive-file') target = archivePath(f);
      else if (kind === 'cache-directory') target = f.cache;
      else target = f.root;
      const outside = path.join(f.scratch, 'outside-target');
      await fs.rename(target, outside);
      if (kind === 'root-ancestor') {
        const link = path.join(f.scratch, 'linked-ancestor');
        await fs.symlink(f.scratch, link, 'dir');
        f.root = path.join(link, 'outside-target');
      } else {
        await fs.symlink(outside, target);
      }
      const before = (await fs.stat(outside)).isFile() ? await fs.readFile(outside) : undefined;
      expectFailure(await run(f));
      if (before) assert.deepEqual(await fs.readFile(outside), before, 'verifier must not write through symlinks');
    });
  });
}

for (const kind of ['symlink', 'parent-path', 'absolute-path', 'fifo'] as const) {
  test(`D1 fixture: valid-SRI tar with ${kind} entry fails before unsafe extraction`, async () => {
    await withFixture(async (f) => {
      const staging = path.join(f.scratch, `source-${names[0]}`);
      const source = path.join(staging, 'package', 'payload.bin');
      const canary = path.join(f.scratch, 'outside-canary');
      await fs.writeFile(canary, 'must remain unchanged');
      const archive = path.join(f.scratch, 'adversarial.tgz');
      const transforms: string[] = [];
      if (kind === 'symlink') {
        await fs.unlink(source);
        await fs.symlink(canary, source);
      } else if (kind === 'fifo') {
        await fs.unlink(source);
        const result = spawnSync('/usr/bin/mkfifo', [source], { encoding: 'utf8', timeout: 5_000 });
        assert.equal(result.status, 0, result.stderr);
      } else {
        transforms.push('-s', kind === 'parent-path' ? '|^package/payload.bin$|../outside-canary|' : `|^package/payload.bin$|${canary}|`);
      }
      tar(['--format=ustar', '-czf', archive, ...transforms, 'package'], staging);
      const bytes = await fs.readFile(archive);
      f.lock.packages[`${nestedPiPrefix}${names[0]}`]!.integrity = sri(bytes);
      await fs.writeFile(archivePath(f), bytes);
      await writeLock(f);
      if (kind === 'parent-path') assert.ok(tar(['-tzf', archive], staging).includes('../outside-canary'));
      expectFailure(await run(f));
      assert.equal(await fs.readFile(canary, 'utf8'), 'must remain unchanged');
      assert.deepEqual(await fs.readdir(f.temporary), [], 'rejected archive scratch must be cleaned');
    });
  });
}

test('D1 official: all five installed SDK packages match preapproved official archive bytes offline', async () => {
  // Consume the verifier's actual producer cache contract, not diagnostic
  // name-version archives. No downloads or caller-selected expected digests.
  const source = process.env.MA_PI_APPROVED_ARCHIVE_DIR ?? path.join(await fs.realpath(os.tmpdir()), 'my-agent-pi-dependency-archives-v1');
  await withFixture(async (f) => {
    f.root = repository;
    f.lock = JSON.parse(await fs.readFile(path.join(repository, 'package-lock.json'), 'utf8'));
    await fs.rm(f.cache, { recursive: true });
    await fs.mkdir(f.cache);
    for (const [name, approved] of Object.entries(approvedPiPackages)) {
      assert.equal(f.lock.packages[`${nestedPiPrefix}${name}`]?.integrity, approved.integrity, `${name} root lock must carry approved SRI`);
      const filename = path.join(source, cacheBasename(approved.integrity));
      const bytes: Buffer = await fs.readFile(filename).catch((error: unknown) => {
        throw new Error(`Required offline verified archive unavailable: ${filename}. Populate the approved verifier cache first or set MA_PI_APPROVED_ARCHIVE_DIR; tests never download or skip.`, { cause: error });
      });
      assert.equal(sri(bytes), approved.integrity, `${name} supplied official archive failed the independent oracle`);
      await fs.writeFile(path.join(f.cache, cacheBasename(approved.integrity)), bytes);
    }
    const result = await run(f);
    expectFivePassed(result, f, true);
    console.log(JSON.stringify({ case: 'D1-official-installed-files', packages: result.reports, totalFiles: result.reports.reduce((sum, r) => sum + r.fileCount, 0), offline: true }));
  });
});

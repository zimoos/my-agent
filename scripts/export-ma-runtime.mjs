#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, lstat, writeFile, access } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Distribution construction only. Normal MA startup never installs or verifies archives.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
function run(executable, args, cwd, environment = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...environment, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` } });
  if (result.error || result.status !== 0) throw new Error(`Export command failed: ${args[0]} (exit ${result.status ?? 'unavailable'})`);
  return result.stdout.trim();
}
async function files(directory, prefix = '') {
  const found = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Non-regular production resource: ${name}`);
    if (stat.isDirectory()) found.push(...await files(path, name));
    else found.push(name);
  }
  return found;
}
async function main() {
  const output = option('--out');
  const archiveDirectory = option('--archive-dir') ?? process.env.MA_PI_APPROVED_ARCHIVE_DIR;
  if (!output || !isAbsolute(output) || !archiveDirectory || !isAbsolute(archiveDirectory)) {
    throw new Error('Use --out /absolute/new/export-root --archive-dir /absolute/approved-archive-cache');
  }
  if (process.version !== 'v22.23.2') throw new Error('MA production export requires Node 22.23.2');
  if (run('git', ['status', '--porcelain'], root)) throw new Error('Commit the reviewed MA source before production export');
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], root);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Source revision unavailable');
  try { await access(output); throw new Error('Output directory already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rel = relative(root, output);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('Use an export directory outside the source checkout');
  const npm = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  await access(npm);
  // Use this exact approved archive directory; no implicit network/cache fallback.
  run(process.execPath, [join(root, 'scripts/verify-pi-dependencies.mjs'), '--root', root,
    '--archive-dir', archiveDirectory, '--offline'], root);
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], root);
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.ma-export-'));
  const productionRoots = ['package.json', 'package-lock.json', 'dist', 'bin', 'README.md', 'README.zh-CN.md', 'LICENSE'];
  for (const path of productionRoots) await cp(join(root, path), join(staging, path), { recursive: true, errorOnExist: true });
  await mkdir(join(staging, 'scripts'));
  await cp(join(root, 'scripts/fix-node-pty.mjs'), join(staging, 'scripts/fix-node-pty.mjs'));
  // No install scripts, development dependencies, shell bin links or inherited user sessions.
  run(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false'], staging);
  run(process.execPath, [join(root, 'scripts/verify-pi-dependencies.mjs'), '--root', staging,
    '--archive-dir', archiveDirectory, '--offline'], root);
  const packageJson = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'));
  const entryPath = 'dist/src/runtime/index.js';
  await access(join(staging, entryPath));
  await access(join(staging, 'dist/src/cli/index.js'));
  await access(join(staging, 'node_modules/ws/package.json'));
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    // Agora is a promised local provider on this release platform, not an optional omission.
    await access(join(staging, 'node_modules/@zimoos/agora/package.json'));
    await access(join(staging, 'node_modules/@zimoos/agora-darwin-arm64/manifest.json'));
  }
  const manifest = { schemaVersion: 1, sourceCommit, packageVersion: packageJson.version,
    entryPath, buildLockPath: 'package-lock.json', files: await files(staging) };
  await writeFile(join(staging, 'manifest-resources.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await rename(staging, output);
  process.stdout.write(`${output}\n`);
}
main().catch(error => { process.stderr.write(`MA export failed: ${error.message}\n`); process.exitCode = 1; });

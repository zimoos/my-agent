#!/usr/bin/env node
// Build-time verification only. This module is never loaded by the MA runtime.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const names = ['chord', 'pi-agent-core', 'pi-ai', 'pi-telemetry', 'pi-tui'];
const prefix = 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works';
const maxArchiveBytes = 32 * 1024 * 1024;
const maxFileBytes = 64 * 1024 * 1024;
const maxFiles = 10000;

function fail(message) { throw new Error(message); }

function parseArgs(args) {
  const options = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), offline: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) fail(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--offline') options.offline = true;
    else if (flag === '--root' || flag === '--archive-dir') {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail(`Missing value for ${flag}`);
      options[flag === '--root' ? 'root' : 'archiveDir'] = value;
    } else fail(`Unknown option: ${flag}`);
  }
  return options;
}

// macOS's OS-owned /tmp and /var aliases are not caller-created project links.
async function normalizeSystemAliases(value) {
  let result = path.resolve(value);
  if (process.platform === 'darwin') {
    for (const alias of ['/tmp', '/var']) {
      if (result === alias || result.startsWith(`${alias}/`)) {
        const canonical = await fs.realpath(alias);
        if (canonical !== `/private${alias}`) fail(`Unexpected system directory alias: ${alias}`);
        result = canonical + result.slice(alias.length);
        break;
      }
    }
  }
  return result;
}

async function directoryWithoutLinks(value, create = false) {
  const absolute = await normalizeSystemAliases(value);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`Unsafe directory or symlink: ${current}`);
  }
  return absolute;
}

async function readRegular(filename, maxBytes) {
  await directoryWithoutLinks(path.dirname(filename));
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail(`Unsafe file or link: ${filename}`);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino) fail(`File identity changed: ${filename}`);
    if (stat.size > maxBytes) fail(`File exceeds verification limit: ${filename}`);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) fail(`File exceeds verification limit: ${filename}`);
    return bytes;
  } finally { await handle.close(); }
}

function approvedPackage(lock, name) {
  const entry = lock?.packages?.[`${prefix}/${name}`];
  const resolved = `https://registry.npmjs.org/@earendil-works/${name}/-/${name}-0.86.1.tgz`;
  if (!entry || entry.version !== '0.86.1' || entry.resolved !== resolved) fail('Missing or unexpected locked version/resolved URL');
  if (typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) fail('Missing or invalid locked SHA-512 integrity');
  const digest = Buffer.from(entry.integrity.slice(7), 'base64');
  if (digest.length !== 64 || digest.toString('base64') !== entry.integrity.slice(7)) fail('Noncanonical locked SHA-512 integrity');
  return { version: entry.version, resolved, integrity: entry.integrity, archiveName: `${digest.toString('hex')}.tgz` };
}

function verifyArchive(bytes, approved) {
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actual !== approved.integrity) fail('Archive SHA-512 integrity mismatch');
}

async function downloadArchive(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) fail(`Archive download failed: HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > maxArchiveBytes) {
    await response.body.cancel();
    fail('Archive exceeds download limit');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxArchiveBytes) fail('Archive exceeds download limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function loadArchive(approved, archiveDir, offline) {
  await directoryWithoutLinks(archiveDir);
  const filename = path.join(archiveDir, approved.archiveName);
  let bytes;
  try { bytes = await readRegular(filename, maxArchiveBytes); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (offline) fail(`Archive missing in offline mode: ${approved.archiveName}`);
    bytes = await downloadArchive(approved.resolved);
    verifyArchive(bytes, approved);
    await directoryWithoutLinks(archiveDir);
    const temporary = path.join(archiveDir, `.${approved.archiveName}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      // Do not replace a link or a concurrently created unverified cache entry.
      try {
        const existing = await readRegular(filename, maxArchiveBytes);
        verifyArchive(existing, approved);
      } catch (existingError) {
        if (existingError.code !== 'ENOENT') throw existingError;
        await fs.link(temporary, filename);
      }
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  verifyArchive(bytes, approved);
  return bytes;
}

async function tar(args) {
  try {
    const result = await runFile('/usr/bin/tar', args, {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
    });
    if (result.stderr.trim()) fail('tar reported an archive warning');
    return result.stdout;
  } catch (error) {
    if (error.message === 'tar reported an archive warning') throw error;
    fail('System tar could not safely inspect or extract archive');
  }
}

async function inspectArchive(filename) {
  const listing = (await tar(['-tzf', filename])).trimEnd().split('\n');
  const details = (await tar(['-tvzf', filename])).trimEnd().split('\n');
  if (!listing[0] || listing.length !== details.length || listing.length > maxFiles) fail('Invalid or oversized archive listing');
  const seen = new Set();
  for (let i = 0; i < listing.length; i++) {
    const name = listing[i];
    const type = details[i][0];
    if (type !== '-' && type !== 'd') fail('Archive contains a link or special entry');
    if (name.length > 4096 || /[\x00-\x1f\x7f\\]/.test(name) || !name.startsWith('package/')) fail('Unsafe archive path');
    const clean = name.endsWith('/') ? name.slice(0, -1) : name;
    if (clean.split('/').some(part => !part || part === '.' || part === '..')) fail('Archive path traversal rejected');
    if (seen.has(clean)) fail('Archive contains duplicate paths');
    seen.add(clean);
    if (type === '-' && clean === 'package') fail('Archive package root is not a directory');
  }
}

function managedRootDependencies(lock, packagePath) {
  const dependencies = new Map();
  const childPrefix = `${packagePath}/node_modules/`;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.startsWith(childPrefix)) continue;
    const name = key.slice(childPrefix.length);
    if (!/^(?:@[^/]+\/)?[^/]+$/.test(name)) continue;
    if (typeof entry?.version !== 'string' || typeof entry.resolved !== 'string'
      || typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) {
      fail(`Nested dependency lacks a locked identity: ${name}`);
    }
    dependencies.set(name, entry);
  }
  return dependencies;
}

async function inspectManagedRoot(directory, dependencies) {
  const seen = new Set();
  const inspectPackage = async (name, filename) => {
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`Unsafe nested dependency or extra file: ${name}`);
    if (!dependencies.has(name)) fail(`Unregistered nested dependency: ${name}`);
    seen.add(name);
  };
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`Unsafe nested dependency or extra file: ${entry.name}`);
    if (entry.name.startsWith('@')) {
      const children = await fs.readdir(filename);
      if (!children.length) fail(`Unregistered empty dependency scope: ${entry.name}`);
      for (const child of children) await inspectPackage(`${entry.name}/${child}`, path.join(filename, child));
    } else await inspectPackage(entry.name, filename);
  }
  return seen;
}

async function ownFiles(directory, managedDependencies) {
  const result = new Map();
  let installedDependencies = new Set();
  const walk = async (relative) => {
    const current = path.join(directory, relative);
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      const stat = await fs.lstat(path.join(directory, next));
      if (stat.isSymbolicLink()) fail(`Package contains a symlink: ${next}`);
      if (relative === '' && entry.name === 'node_modules' && managedDependencies) {
        if (!stat.isDirectory()) fail(`Nested node_modules is not a directory: ${next}`);
        installedDependencies = await inspectManagedRoot(path.join(directory, next), managedDependencies);
        continue;
      }
      if (stat.isDirectory()) await walk(next);
      else if (stat.isFile() && stat.nlink === 1) {
        if (stat.size > maxFileBytes || result.size >= maxFiles) fail('Package exceeds file verification limit');
        result.set(next, stat.size);
      } else fail(`Package contains a link or special file: ${next}`);
    }
  };
  await directoryWithoutLinks(directory);
  await walk('');
  for (const [name, entry] of managedDependencies ?? []) {
    if (!entry.optional && !installedDependencies.has(name)) fail(`Missing locked nested dependency: ${name}`);
  }
  return result;
}

async function compareInstalled(bytes, installed, temporaryRoot, managedDependencies) {
  const scratch = await fs.mkdtemp(path.join(temporaryRoot, 'ma-pi-verify-'));
  try {
    const archive = path.join(scratch, 'verified.tgz');
    await fs.writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
    await inspectArchive(archive);
    const unpacked = path.join(scratch, 'unpacked');
    await fs.mkdir(unpacked, { mode: 0o700 });
    await tar(['-xzf', archive, '-C', unpacked, '--no-same-owner', '--no-same-permissions']);
    const expectedRoot = path.join(unpacked, 'package');
    const expected = await ownFiles(expectedRoot);
    const actual = await ownFiles(installed, managedDependencies);
    if (!expected.size) fail('Archive has no package files');
    for (const relative of actual.keys()) if (!expected.has(relative)) fail(`Extra installed file: ${relative}`);
    for (const [relative, size] of expected) {
      if (!actual.has(relative)) fail(`Missing installed file: ${relative}`);
      if (actual.get(relative) !== size) fail(`Installed file bytes differ: ${relative}`);
      const original = await readRegular(path.join(expectedRoot, relative), maxFileBytes);
      const present = await readRegular(path.join(installed, relative), maxFileBytes);
      if (!original.equals(present)) fail(`Installed file bytes differ: ${relative}`);
    }
    return expected.size;
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = await directoryWithoutLinks(options.root);
  const temporaryRoot = await directoryWithoutLinks(tmpdir());
  const archiveDir = await directoryWithoutLinks(options.archiveDir ?? path.join(temporaryRoot, 'my-agent-pi-dependency-archives-v1'), !options.offline);
  const lock = JSON.parse((await readRegular(path.join(root, 'package-lock.json'), 16 * 1024 * 1024)).toString('utf8'));
  let failed = false;
  for (const name of names) {
    let approved;
    try {
      approved = approvedPackage(lock, name);
      const bytes = await loadArchive(approved, archiveDir, options.offline);
      const packagePath = `${prefix}/${name}`;
      const fileCount = await compareInstalled(bytes, path.join(root, packagePath), temporaryRoot, managedRootDependencies(lock, packagePath));
      console.log(JSON.stringify({ package: `@earendil-works/${name}`, version: approved.version, integrity: approved.integrity, fileCount, status: 'passed' }));
    } catch (error) {
      failed = true;
      console.log(JSON.stringify({ package: `@earendil-works/${name}`, version: approved?.version ?? null, integrity: approved?.integrity ?? null, fileCount: 0, status: 'failed', reason: error.message }));
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', reason: error.message }));
  process.exitCode = 1;
});

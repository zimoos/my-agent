#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Consume the same committed production export as the desktop producer. Never copy the dev tree.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
function sha256(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function regularFiles(directory, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const source = path.join(directory, entry.name);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Invalid export resource: ${relative}`);
    if (stat.isDirectory()) files.push(...regularFiles(source, relative));
    else files.push(relative);
  }
  return files;
}
if (process.version !== 'v22.23.2') throw new Error('Portable MA requires Node 22.23.2');
const exportArgument = arg('--runtime-export');
const archiveDirectory = arg('--archive-dir');
if (!exportArgument || !path.isAbsolute(exportArgument) || !archiveDirectory || !path.isAbsolute(archiveDirectory)) {
  throw new Error('Use --runtime-export /absolute/production-export --archive-dir /absolute/approved-archive-cache [--out directory]');
}
const source = fs.realpathSync(exportArgument);
if (source !== path.resolve(exportArgument) || !fs.lstatSync(source).isDirectory()) throw new Error('The export must be a canonical directory');
const manifestPath = path.join(source, 'manifest-resources.json');
if (!fs.lstatSync(manifestPath).isFile() || fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error('Invalid export manifest');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)
  || manifest.entryPath !== 'dist/src/runtime/index.js' || manifest.buildLockPath !== 'package-lock.json'
  || !Array.isArray(manifest.files) || manifest.files.some(file => typeof file !== 'string' || file === 'manifest-resources.json'
    || file.includes('\\') || file.includes('\0') || path.isAbsolute(file) || file.split('/').some(part => !part || part === '.' || part === '..')))
  throw new Error('Invalid production export contract');
const actual = regularFiles(source).filter(file => file !== 'manifest-resources.json');
if (JSON.stringify(actual) !== JSON.stringify(manifest.files) || new Set(actual).size !== actual.length) throw new Error('Export file inventory mismatch');
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
if (pkg.name !== 'my-agent' || pkg.version !== manifest.packageVersion || !actual.includes('dist/src/cli/index.js')
  || !actual.includes('node_modules/ws/package.json')) throw new Error('Incomplete MA production export');
const verified = spawnSync(process.execPath, [path.join(root, 'scripts/verify-pi-dependencies.mjs'), '--root', source,
  '--archive-dir', archiveDirectory, '--offline'], { stdio: 'inherit' });
if (verified.error || verified.status !== 0) throw new Error('Production Pi dependency verification failed');
const nativeTarget = `${process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const target = arg('--target', nativeTarget);
if (target !== nativeTarget) throw new Error('Use the approved Node and production dependencies for the native target platform');
if (target === 'macos-arm64' && !actual.includes('node_modules/@zimoos/agora-darwin-arm64/manifest.json')) throw new Error('The promised Agora runtime is missing');
const outRoot = path.resolve(arg('--out', path.join(root, 'release')));
if (outRoot === source || outRoot.startsWith(source + path.sep)) throw new Error('The package output must be outside its production export');
fs.mkdirSync(outRoot, { recursive: true });
const bundle = path.join(outRoot, `ma-${pkg.version}-${target}`);
if (fs.existsSync(bundle)) throw new Error('Package output already exists; use a new output directory');
const staging = fs.mkdtempSync(path.join(outRoot, '.ma-portable-'));
const app = path.join(staging, 'app');
const runtime = path.join(staging, 'runtime');
fs.mkdirSync(app); fs.mkdirSync(runtime);
for (const relative of [...actual, 'manifest-resources.json']) {
  const destination = path.join(app, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(source, relative), destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, fs.statSync(path.join(source, relative)).mode & 0o777);
}
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
fs.copyFileSync(process.execPath, path.join(runtime, nodeName));
if (process.platform !== 'win32') {
  fs.chmodSync(path.join(runtime, nodeName), 0o755);
}

if (process.platform === 'win32') {
  fs.writeFileSync(
    path.join(staging, 'ma.cmd'),
    '@echo off\r\nset "DIR=%~dp0"\r\n"%DIR%runtime\\node.exe" "%DIR%app\\dist\\src\\cli\\index.js" %*\r\n',
    'utf-8'
  );
} else {
  fs.writeFileSync(
    path.join(staging, 'ma'),
    `#!/usr/bin/env sh
if [ -n "\${NODE_EXTRA_CA_CERTS:-}" ]; then
  if ! { [ -f "$NODE_EXTRA_CA_CERTS" ] && dd if="$NODE_EXTRA_CA_CERTS" of=/dev/null bs=1 count=1 >/dev/null 2>&1; }; then
    unset NODE_EXTRA_CA_CERTS
  fi
fi
script="$0"
while [ -h "$script" ]; do
  dir="$(CDPATH= cd -- "$(dirname -- "$script")" && pwd)"
  link="$(readlink "$script")"
  case "$link" in
    /*) script="$link" ;;
    *) script="$dir/$link" ;;
  esac
done
dir="$(CDPATH= cd -- "$(dirname -- "$script")" && pwd)"
exec "$dir/runtime/node" "$dir/app/dist/src/cli/index.js" "$@"
`,
    'utf-8'
  );
  fs.chmodSync(path.join(staging, 'ma'), 0o755);
}

fs.writeFileSync(
  path.join(staging, 'README.txt'),
  `MA ${pkg.version} portable bundle

Run:
  macOS/Linux: ./ma
  Windows: ma.cmd

Initialize:
  ./ma init

This bundle includes a Node.js runtime and does not require npm install.
`,
  'utf-8'
);

const packagedFiles = regularFiles(staging).map(relative => ({ path: relative, sha256: sha256(path.join(staging, relative)), size: fs.statSync(path.join(staging, relative)).size }));
fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ schemaVersion: 2, package: 'my-agent',
  version: pkg.version, sourceCommit: manifest.sourceCommit, platform: target, nodeVersion: process.versions.node,
  entryPath: 'app/dist/src/cli/index.js', buildLockSha256: sha256(path.join(app, 'package-lock.json')), files: packagedFiles }, null, 2) + '\n', { flag: 'wx' });
fs.renameSync(staging, bundle);
console.log(bundle);

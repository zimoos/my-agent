#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const agoraLock = JSON.parse(fs.readFileSync(path.join(root, 'src', 'provider', 'agora-runtime-lock.json'), 'utf-8'));

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function platformId() {
  const p = process.platform;
  const a = process.arch;
  const platform = p === 'darwin' ? 'macos' : p === 'win32' ? 'windows' : p;
  const arch = a === 'x64' ? 'x64' : a === 'arm64' ? 'arm64' : a;
  return `${platform}-${arch}`;
}

function copyRequired(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`missing required path: ${src}`);
  }
  fs.cpSync(src, dest, { recursive: true });
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copyAgoraRuntime(appDir, target) {
  if (target !== 'macos-arm64') return;
  const platformSource = process.env.MA_AGORA_ARTIFACT_DIR
    ? path.resolve(process.env.MA_AGORA_ARTIFACT_DIR)
    : path.join(root, 'node_modules', '@zimoos', 'agora-darwin-arm64');
  const launcherSource = process.env.MA_AGORA_LAUNCHER_DIR
    ? path.resolve(process.env.MA_AGORA_LAUNCHER_DIR)
    : path.join(root, 'node_modules', '@zimoos', 'agora');
  const manifestPath = path.join(platformSource, 'manifest.json');
  const binaryPath = path.join(platformSource, 'bin', 'agora');
  const launcherBinaryPath = path.join(launcherSource, 'bin', 'agora');
  const launcherPackagePath = path.join(launcherSource, 'package.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(binaryPath)) {
    throw new Error(`macos-arm64 portable release requires MA_AGORA_ARTIFACT_DIR with Agora ${agoraLock.version} native artifact`);
  }
  if (!fs.existsSync(launcherBinaryPath) || !fs.existsSync(launcherPackagePath)) {
    throw new Error(`macos-arm64 portable release requires MA_AGORA_LAUNCHER_DIR with Agora ${agoraLock.version} launcher package`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const launcherPackage = JSON.parse(fs.readFileSync(launcherPackagePath, 'utf8'));
  if (agoraLock.published !== true) {
    throw new Error('macos-arm64 portable release requires a published, notarized Agora release lock');
  }
  if (
    launcherPackage.name !== '@zimoos/agora' ||
    launcherPackage.version !== agoraLock.version ||
    launcherPackage.dependencies?.['@zimoos/agora-darwin-arm64'] !== agoraLock.version
  ) {
    throw new Error(`unexpected Agora launcher contract: ${launcherPackage.name}@${launcherPackage.version}`);
  }
  if (
    manifest.version !== agoraLock.version ||
    manifest.host_protocol_major !== agoraLock.host_protocol_major ||
    manifest.native_core_abi !== agoraLock.native_core_abi ||
    manifest.runtime_layout !== agoraLock.runtime_layout
  ) {
    throw new Error(`unexpected Agora contract: ${manifest.version}/host-v${manifest.host_protocol_major}`);
  }
  const requiredCapabilities = agoraLock.capabilities ?? [];
  if (!requiredCapabilities.every((capability) => manifest.capabilities?.includes(capability))) {
    throw new Error('Agora artifact is missing required Memory v2 capabilities');
  }
  for (const [relative, expected] of Object.entries(manifest.files ?? {})) {
    const target = path.resolve(platformSource, relative);
    if (!target.startsWith(`${platformSource}${path.sep}`) || !fs.existsSync(target) || sha256(target) !== expected) {
      throw new Error(`Agora artifact integrity mismatch: ${relative}`);
    }
  }
  const sourceLike = [];
  const visit = (directory, packageRoot) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, packageRoot);
      else if (/\.(py|pyc|js|map)$/i.test(entry.name)) sourceLike.push(path.relative(packageRoot, target));
    }
  };
  visit(platformSource, platformSource);
  visit(launcherSource, launcherSource);
  if (sourceLike.length > 0) {
    throw new Error(`Agora user artifact contains source-like files: ${sourceLike.join(', ')}`);
  }
  const launcherIntegrity = process.env.MA_AGORA_LAUNCHER_INTEGRITY?.trim();
  const platformIntegrity = process.env.MA_AGORA_PACKAGE_INTEGRITY?.trim();
  const expectedLauncherIntegrity = agoraLock.packages?.['@zimoos/agora']?.integrity;
  const expectedPlatformIntegrity = agoraLock.packages?.['@zimoos/agora-darwin-arm64']?.integrity;
  if (launcherIntegrity !== expectedLauncherIntegrity || platformIntegrity !== expectedPlatformIntegrity) {
    throw new Error('macos-arm64 portable release package integrities do not match the pinned Agora release');
  }
  const manifestSha = sha256(manifestPath);
  if (manifestSha !== agoraLock.manifest_sha256) {
    throw new Error('macos-arm64 portable release manifest SHA does not match the pinned Agora release');
  }
  const launcherDestination = path.join(appDir, 'resources', 'agora');
  const platformDestination = path.join(appDir, 'resources', 'agora-darwin-arm64');
  copyRequired(launcherSource, launcherDestination);
  copyRequired(platformSource, platformDestination);
  fs.writeFileSync(
    path.join(launcherDestination, 'runtime-lock.json'),
    JSON.stringify({
      version: agoraLock.version,
      package: '@zimoos/agora-darwin-arm64',
      platform: 'darwin-arm64',
      host_protocol_major: 1,
      native_core_abi: 1,
      published: true,
      notarization_id: agoraLock.notarization_id,
      launcher_package_integrity: launcherIntegrity,
      platform_package_integrity: platformIntegrity,
      manifest_sha256: manifestSha,
    }, null, 2) + '\n',
    'utf8'
  );
}

const outRoot = path.resolve(root, arg('--out', 'release'));
const target = arg('--target', platformId());
const name = `ma-${pkg.version}-${target}`;
const bundle = path.join(outRoot, name);
const app = path.join(bundle, 'app');
const runtime = path.join(bundle, 'runtime');

fs.rmSync(bundle, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
fs.mkdirSync(runtime, { recursive: true });

copyRequired(path.join(root, 'dist'), path.join(app, 'dist'));
copyRequired(path.join(root, 'node_modules'), path.join(app, 'node_modules'));
copyRequired(path.join(root, 'package.json'), path.join(app, 'package.json'));
copyRequired(path.join(root, 'README.md'), path.join(app, 'README.md'));
copyAgoraRuntime(app, target);
if (fs.existsSync(path.join(root, 'LICENSE'))) {
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(app, 'LICENSE'));
}

const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
fs.copyFileSync(process.execPath, path.join(runtime, nodeName));
if (process.platform !== 'win32') {
  fs.chmodSync(path.join(runtime, nodeName), 0o755);
}

if (process.platform === 'win32') {
  fs.writeFileSync(
    path.join(bundle, 'ma.cmd'),
    '@echo off\r\nset "DIR=%~dp0"\r\n"%DIR%runtime\\node.exe" "%DIR%app\\dist\\src\\cli\\index.js" %*\r\n',
    'utf-8'
  );
} else {
  fs.writeFileSync(
    path.join(bundle, 'ma'),
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
  fs.chmodSync(path.join(bundle, 'ma'), 0o755);
}

fs.writeFileSync(
  path.join(bundle, 'README.txt'),
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

console.log(bundle);

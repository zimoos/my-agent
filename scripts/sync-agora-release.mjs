#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.2.0';
const PACKAGE_NAMES = ['@zimoos/agora', '@zimoos/agora-darwin-arm64'];

function fail(message) {
  throw new Error(`Agora release evidence rejected: ${message}`);
}

export function buildReleaseLock(evidence) {
  if (evidence?.version !== VERSION || evidence?.published !== true) {
    fail(`expected published Agora ${VERSION}`);
  }
  if (evidence?.notarization?.status !== 'Accepted' || typeof evidence?.notarization?.id !== 'string') {
    fail('Apple notarization must be Accepted and include a submission id');
  }
  if (!/^[a-f0-9]{64}$/.test(String(evidence.manifest_sha256 ?? ''))) {
    fail('manifest_sha256 is missing or malformed');
  }
  const signatures = Object.values(evidence.signatures ?? {});
  if (signatures.length < 5 || signatures.some((item) => (
    !String(item?.authority ?? '').startsWith('Developer ID Application:') || !String(item?.team_id ?? '')
  ))) {
    fail('all native files must carry a Developer ID Application signature and Team ID');
  }
  const packages = Object.fromEntries((evidence.packages ?? []).map((item) => [item.name, item]));
  for (const name of PACKAGE_NAMES) {
    const item = packages[name];
    if (item?.version !== VERSION || !String(item?.integrity ?? '').startsWith('sha512-')) {
      fail(`missing exact npm integrity for ${name}@${VERSION}`);
    }
    const forbidden = (item.files ?? []).filter((file) => /\.(py|pyc|js|map|pem|key|p12)$/i.test(file));
    if (forbidden.length > 0) fail(`${name} contains forbidden files: ${forbidden.join(', ')}`);
  }
  const teamIds = new Set(signatures.map((item) => item.team_id));
  if (teamIds.size !== 1) fail('native files are not signed by one Apple team');
  return {
    version: VERSION,
    platform: 'darwin-arm64',
    host_protocol_major: 1,
    native_core_abi: 1,
    published: true,
    notarization_id: evidence.notarization.id,
    manifest_sha256: evidence.manifest_sha256,
    capabilities: ['mcp-stdio', 'memory-profile-v2', 'memory-intake-v2'],
    packages: Object.fromEntries(PACKAGE_NAMES.map((name) => [name, { integrity: packages[name].integrity }])),
  };
}

export function syncReleaseEvidence(evidencePath, workspaceRoot = root) {
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const lock = buildReleaseLock(evidence);
  const lockPath = path.join(workspaceRoot, 'src', 'provider', 'agora-runtime-lock.json');
  const packageLockPath = path.join(workspaceRoot, 'package-lock.json');
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
  for (const name of PACKAGE_NAMES) {
    const key = `node_modules/${name}`;
    if (packageLock.packages?.[key]?.version !== VERSION) {
      fail(`package-lock is missing exact ${name}@${VERSION}`);
    }
    packageLock.packages[key].integrity = lock.packages[name].integrity;
  }
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`, 'utf8');
  return lock;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const evidencePath = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!evidencePath) {
    console.error('usage: node scripts/sync-agora-release.mjs /path/to/release-evidence.json');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(syncReleaseEvidence(evidencePath), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

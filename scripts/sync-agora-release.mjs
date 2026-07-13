#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const VERSION = packageMetadata.optionalDependencies?.['@zimoos/agora'];
const PACKAGE_NAMES = ['@zimoos/agora', '@zimoos/agora-darwin-arm64'];
const REQUIRED_TAMPER_CHECKS = [
  'runtime_hash_tamper',
  'unmanifested_file',
  'missing_manifest',
  'protocol_mismatch',
  'dependency_adhoc_resign',
  'adhoc_resign',
];

if (typeof VERSION !== 'string' || !/^\d+\.\d+\.\d+$/.test(VERSION)) {
  throw new Error('Agora release evidence rejected: package.json must pin an exact @zimoos/agora semver');
}

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
  const artifactAudit = evidence?.artifact_audit;
  if (
    artifactAudit?.passed !== true ||
    artifactAudit?.readable_language_source_files !== 0 ||
    artifactAudit?.private_keys !== 0 ||
    artifactAudit?.repository_source_paths !== 0 ||
    artifactAudit?.debug_symbols !== 0
  ) {
    fail('artifact source/private-key/source-path/debug audit did not pass');
  }
  const tamperChecks = new Map((evidence?.tamper_audit?.checks ?? []).map((item) => [item?.name, item]));
  if (
    evidence?.tamper_audit?.passed !== true ||
    REQUIRED_TAMPER_CHECKS.some((name) => tamperChecks.get(name)?.exit_code !== 126)
  ) {
    fail('required launcher tamper checks did not fail closed');
  }
  const startup = evidence?.startup_performance;
  if (
    startup?.passed !== true ||
    startup?.cold?.runs < 5 ||
    startup?.warm?.runs < 30 ||
    startup?.cold?.p95_ms > 2000 ||
    startup?.warm?.p95_ms > 1000 ||
    startup?.precondition !== 'npm postinstall packaged doctor completed'
  ) {
    fail('packaged Agora startup performance evidence is missing or below the Issue #42 gate');
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
    const forbidden = (item.files ?? []).filter((file) => /\.(py|pyc|pyi|js|jsx|mjs|cjs|ts|tsx|map|key|p12)$/i.test(file));
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
    startup_performance: {
      cold_p95_ms: startup.cold.p95_ms,
      warm_p95_ms: startup.warm.p95_ms,
    },
    tamper_checks: REQUIRED_TAMPER_CHECKS,
    runtime_layout: 'nuitka-standalone-v1',
    capabilities: ['mcp-stdio', 'memory-profile-v2', 'memory-intake-v2', 'memory-lineage-cas-v1'],
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReleaseLock } from '../scripts/sync-agora-release.mjs';
import { parseDeveloperIdSignature } from '../src/provider/agora.js';

const EXPECTED_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  .optionalDependencies['@zimoos/agora'];

const evidence = () => ({
  version: EXPECTED_VERSION,
  published: true,
  notarization: { id: 'notary-id', status: 'Accepted' },
  manifest_sha256: 'a'.repeat(64),
  artifact_audit: {
    passed: true,
    readable_language_source_files: 0,
    private_keys: 0,
    repository_source_paths: 0,
    debug_symbols: 0,
  },
  tamper_audit: {
    passed: true,
    checks: [
      'runtime_hash_tamper',
      'unmanifested_file',
      'missing_manifest',
      'protocol_mismatch',
      'dependency_adhoc_resign',
      'adhoc_resign',
    ].map((name) => ({ name, exit_code: 126 })),
  },
  startup_performance: {
    passed: true,
    precondition: 'npm postinstall packaged doctor completed',
    cold: { runs: 5, p95_ms: 700 },
    warm: { runs: 30, p95_ms: 600 },
  },
  signatures: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
    `bin-${index}`,
    { authority: 'Developer ID Application: ZimoOS (TEAM123)', team_id: 'TEAM123' },
  ])),
  packages: [
    { name: '@zimoos/agora', version: EXPECTED_VERSION, integrity: 'sha512-launcher', files: ['package/bin/agora'] },
    { name: '@zimoos/agora-darwin-arm64', version: EXPECTED_VERSION, integrity: 'sha512-platform', files: ['package/bin/agora', 'package/bin/certifi/cacert.pem'] },
  ],
});

test('release lock accepts only published, notarized, Developer ID signed evidence', () => {
  const lock = buildReleaseLock(evidence());
  assert.equal(lock.published, true);
  assert.equal(lock.notarization_id, 'notary-id');
  assert.equal(lock.runtime_layout, 'nuitka-standalone-v1');
  assert.equal(lock.startup_performance.cold_p95_ms, 700);
  assert.equal(lock.packages['@zimoos/agora-darwin-arm64'].integrity, 'sha512-platform');

  assert.throws(() => buildReleaseLock({ ...evidence(), published: false }), /expected published/);
  assert.throws(() => buildReleaseLock({ ...evidence(), notarization: { status: 'Invalid' } }), /notarization/);
  const adHoc = evidence();
  adHoc.signatures['bin-0'] = { authority: '', team_id: '' };
  assert.throws(() => buildReleaseLock(adHoc), /Developer ID/);
  assert.throws(
    () => buildReleaseLock({ ...evidence(), artifact_audit: { ...evidence().artifact_audit, private_keys: 1 } }),
    /artifact source\/private-key/,
  );
  assert.throws(
    () => buildReleaseLock({ ...evidence(), startup_performance: { ...evidence().startup_performance, passed: false } }),
    /startup performance/,
  );
  const missingTamperCheck = evidence();
  missingTamperCheck.tamper_audit.checks.pop();
  assert.throws(() => buildReleaseLock(missingTamperCheck), /tamper checks/);
});

test('Developer ID parser rejects ad-hoc signatures', () => {
  assert.equal(parseDeveloperIdSignature('Signature=adhoc\nTeamIdentifier=not set'), false);
  assert.equal(
    parseDeveloperIdSignature('Authority=Developer ID Application: ZimoOS (TEAM123)\nTeamIdentifier=TEAM123'),
    true
  );
});

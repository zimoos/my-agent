import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReleaseLock } from '../scripts/sync-agora-release.mjs';
import { parseDeveloperIdSignature } from '../src/provider/agora.js';

const evidence = () => ({
  version: '0.2.0',
  published: true,
  notarization: { id: 'notary-id', status: 'Accepted' },
  manifest_sha256: 'a'.repeat(64),
  signatures: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
    `bin-${index}`,
    { authority: 'Developer ID Application: ZimoOS (TEAM123)', team_id: 'TEAM123' },
  ])),
  packages: [
    { name: '@zimoos/agora', version: '0.2.0', integrity: 'sha512-launcher', files: ['package/bin/agora'] },
    { name: '@zimoos/agora-darwin-arm64', version: '0.2.0', integrity: 'sha512-platform', files: ['package/bin/agora'] },
  ],
});

test('release lock accepts only published, notarized, Developer ID signed evidence', () => {
  const lock = buildReleaseLock(evidence());
  assert.equal(lock.published, true);
  assert.equal(lock.notarization_id, 'notary-id');
  assert.equal(lock.packages['@zimoos/agora-darwin-arm64'].integrity, 'sha512-platform');

  assert.throws(() => buildReleaseLock({ ...evidence(), published: false }), /expected published/);
  assert.throws(() => buildReleaseLock({ ...evidence(), notarization: { status: 'Invalid' } }), /notarization/);
  const adHoc = evidence();
  adHoc.signatures['bin-0'] = { authority: '', team_id: '' };
  assert.throws(() => buildReleaseLock(adHoc), /Developer ID/);
});

test('Developer ID parser rejects ad-hoc signatures', () => {
  assert.equal(parseDeveloperIdSignature('Signature=adhoc\nTeamIdentifier=not set'), false);
  assert.equal(
    parseDeveloperIdSignature('Authority=Developer ID Application: ZimoOS (TEAM123)\nTeamIdentifier=TEAM123'),
    true
  );
});

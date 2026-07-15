import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { verifyAgoraManifestFiles } from '../src/provider/agora.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('Agora manifest verifies every packaged runtime file and rejects tampering', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-agora-integrity-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'agora'), 'native-binary');
    fs.writeFileSync(path.join(root, 'lib', 'agora-core.dylib'), 'native-core');
    const manifest = {
      files: {
        'bin/agora': sha256('native-binary'),
        'lib/agora-core.dylib': sha256('native-core'),
      },
    };
    assert.equal(verifyAgoraManifestFiles(root, manifest), true);
    fs.writeFileSync(path.join(root, 'lib', 'agora-core.dylib'), 'tampered');
    assert.equal(verifyAgoraManifestFiles(root, manifest), false);
    assert.equal(verifyAgoraManifestFiles(root, { files: { '../escape': sha256('x') } }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

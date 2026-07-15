import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { VERSION } from '../src/cli/version.js';

test('CLI version is read from package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
    version: string;
  };

  assert.equal(VERSION, pkg.version);
  assert.notEqual(VERSION, '0.1.0-alpha.0');
});

test('npm package includes its postinstall entrypoint', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
    files: string[];
    scripts: { postinstall?: string };
  };

  assert.equal(pkg.scripts.postinstall, 'node scripts/fix-node-pty.mjs');
  assert.ok(pkg.files.includes('scripts/fix-node-pty.mjs'));
});

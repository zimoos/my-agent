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

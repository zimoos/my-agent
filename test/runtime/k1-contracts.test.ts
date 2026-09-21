import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));

test('A0 compile gate: six frozen exported types preserve required identity and reject invalid consumers', () => {
  assert.equal(process.version, 'v22.23.2', 'Use the approved Node runtime for MA contract evidence');
  const result = spawnSync(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '-p', 'test/runtime/tsconfig.contracts.json',
    '--noEmit',
  ], { cwd: repository, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, `compiler was interrupted: ${result.signal}`);
  assert.equal(result.status, 0, `compile-only contract failed:\n${result.stdout}\n${result.stderr}`);
});

test('A0 module boundary: type-only contract module exports no runtime bindings', async () => {
  const contractModule = await import('../../src/runtime/contracts.js');
  assert.deepEqual(Object.keys(contractModule), [], 'A1 exports types only; runtime validators and engines are later nodes');
});

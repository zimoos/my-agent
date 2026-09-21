import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';

// Reviewed official archive identities; test callers cannot supply their own oracle.
export const approvedPiPackages = {
  chord: { integrity: 'sha512-GzUr5n4tFBHUYxN9CjcRHK8QWo9tbxNrZu6iWPQ+PFiFrLASvSZOKeAVAgh3gHv/t0X5OvUpFlrMQ/nEFfCYpg==', fileCount: 99 },
  'pi-agent-core': { integrity: 'sha512-8TbBzhYsDeu5V1Zl2NsyrBqJAzX1EiEL3Np3ZjGpy0pSDdGRVOpcyW1qruLqfWmEqGcnxmvgnTMLS/wJNZO2XQ==', fileCount: 466 },
  'pi-ai': { integrity: 'sha512-1XHhI6D/fyQdsBieHC/E/4zGKVOoGe4yDyX67VXvzoYkFsX/qE7NpZE7E1RC8e6Bz8B9oG/P+MQFXikv2/BGEg==', fileCount: 772 },
  'pi-telemetry': { integrity: 'sha512-SOcEqOS3oVGgKeahs2jHB906d8hFjuLP+RBee8xKYMRgw5KAeWHNg+YABfL0ALlp3Bt6tW4b632MLghc3vnTog==', fileCount: 26 },
  'pi-tui': { integrity: 'sha512-FU/zU/zG4RWokcZt+BVXXcieWi5ggvYnWP2kkB5XXjMaHRoy5BDhcZJ9JAnLTN9MwrCRoXgPQxOI0bFqwYeZkQ==', fileCount: 188 },
} as const;

export const nestedPiPrefix = 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/';
export const approvedNodeBinarySha256 = '18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572';

export async function verifiedNodeExecutable(): Promise<string> {
  assert.equal(process.version, 'v22.23.2', 'Run acceptance using the approved Node; no PATH fallback or automatic download');
  assert.equal(process.versions.bun, undefined);
  assert.equal(process.platform, 'darwin', 'This approved binary identity is darwin-arm64; other platforms require a reviewed identity');
  assert.equal(process.arch, 'arm64');
  const executable = await realpath(process.execPath);
  const digest = createHash('sha256').update(await readFile(executable)).digest('hex');
  assert.equal(digest, approvedNodeBinarySha256, 'Node executable differs from the independently verified official binary');
  return executable;
}

export function cacheBasename(integrity: string): string {
  return `${Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex')}.tgz`;
}

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { FixtureSpec } from './types.js';

export interface PreparedFixture {
  cwd: string;
  workspaceId: string;
  fixtureSource?: string;
  fixtureFingerprint?: string;
  cleanup: () => Promise<void>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_FIXTURES = resolve(__dirname, '..', 'fixtures');
const E2E_FIXTURES = resolve(__dirname, '..', '..', 'e2e', 'fixtures');

function resolveFixtureSource(project: string): string {
  const benchPath = join(BENCH_FIXTURES, project);
  if (existsSync(benchPath) && statSync(benchPath).isDirectory()) return benchPath;

  const e2ePath = join(E2E_FIXTURES, project);
  if (existsSync(e2ePath) && statSync(e2ePath).isDirectory()) return e2ePath;

  throw new Error(
    `fixture not found: "${project}". Looked in:\n  - ${benchPath}\n  - ${e2ePath}`,
  );
}

export async function prepareFixture(spec?: FixtureSpec): Promise<PreparedFixture> {
  const cwd = mkdtempSync(join(tmpdir(), 'ma-bench-fixture-'));
  const workspaceId = sha256(cwd).slice(0, 12);
  let fixtureSource: string | undefined;
  let fixtureFingerprint: string | undefined;

  if (spec) {
    const src = resolveFixtureSource(spec.project);
    fixtureSource = src;
    fixtureFingerprint = fingerprintDirectory(src);
    cpSync(src, cwd, { recursive: true });

    if (spec.setup && spec.setup.length > 0) {
      for (const cmd of spec.setup) {
        execSync(cmd, { cwd, stdio: 'pipe' });
      }
    }
  }

  const cleanup = async (): Promise<void> => {
    rmSync(cwd, { recursive: true, force: true });
  };

  return { cwd, workspaceId, fixtureSource, fixtureFingerprint, cleanup };
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function fingerprintDirectory(dir: string): string {
  const hash = createHash('sha256');
  const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'coverage']);

  function walk(current: string, rel = ''): void {
    const entries = readdirSync(current, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.DS_Store'))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childPath = join(current, entry.name);
      hash.update(childRel);
      if (entry.isDirectory()) {
        walk(childPath, childRel);
      } else if (entry.isFile()) {
        hash.update(readFileSync(childPath));
      }
    }
  }

  walk(dir);
  return hash.digest('hex').slice(0, 16);
}

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '../../..');
export const DIST_CLI = path.join(REPO_ROOT, 'dist/src/cli/index.js');
export const SIMPLE_FIXTURE_CWD = path.join(
  REPO_ROOT,
  'test/e2e/fixtures/simple-node-project'
);
export const DEFAULT_BENCHMARK_ENV = path.join(os.homedir(), '.my-agent', 'benchmark.env');
export const DEFAULT_MA_CONFIG = path.join(
  os.homedir(),
  '.my-agent',
  'benchmark-ma-config.json'
);

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function readEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = stripQuotes(trimmed.slice(idx + 1));
    if (key) out[key] = value;
  }
  return out;
}

export function resolveE2EConfigPath(): string | null {
  const benchmarkEnv = readEnvFile(DEFAULT_BENCHMARK_ENV);
  const candidates = [
    process.env.MA_E2E_CONFIG,
    process.env.MA_BENCH_MA_CONFIG,
    benchmarkEnv.MA_BENCH_MA_CONFIG,
    DEFAULT_MA_CONFIG,
  ].filter((v): v is string => Boolean(v && v.trim()));

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

export function e2eConfigSkipReason(): string {
  return [
    'requires real MA config',
    'set MA_E2E_CONFIG or MA_BENCH_MA_CONFIG',
    `or create ${DEFAULT_MA_CONFIG}`,
  ].join('; ');
}

export function assertBuiltCli(): void {
  if (!fs.existsSync(DIST_CLI)) {
    throw new Error(`Built CLI not found at ${DIST_CLI}; run npm run build first.`);
  }
}

export function defaultE2ECwd(): string {
  const requested = process.env.TEST_CWD;
  if (requested && fs.existsSync(requested)) return path.resolve(requested);
  return SIMPLE_FIXTURE_CWD;
}

export function tmpFile(prefix: string, suffix = '.tmp'): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`
  );
}

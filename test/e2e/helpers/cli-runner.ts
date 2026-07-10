import { spawn } from 'node:child_process';
import { assertBuiltCli, defaultE2ECwd, DIST_CLI } from './real-env.js';

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export function hasLlmError(text: string): boolean {
  return /\[error\]|\[task:failed\]|Internal Server Error|5\d\d\s+Error/.test(text);
}

export function countChinese(text: string): number {
  return (text.match(/[一-鿿]/g) ?? []).length;
}

export async function runMaPrompt(params: {
  configPath: string;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<CliResult> {
  assertBuiltCli();
  const timeoutMs = params.timeoutMs ?? 240000;
  const proc = spawn(
    process.execPath,
    [
      DIST_CLI,
      'run',
      '--config',
      params.configPath,
      '--prompt',
      params.prompt,
    ],
    {
      cwd: params.cwd ?? defaultE2ECwd(),
      env: { ...process.env, ...params.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 5000).unref();
  }, timeoutMs);

  proc.stdout.setEncoding('utf-8');
  proc.stderr.setEncoding('utf-8');
  proc.stdout.on('data', (chunk) => { stdout += chunk; });
  proc.stderr.on('data', (chunk) => { stderr += chunk; });

  return new Promise((resolve) => {
    proc.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal, timedOut });
    });
  });
}

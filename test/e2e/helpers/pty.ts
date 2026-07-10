import * as pty from 'node-pty';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertBuiltCli,
  defaultE2ECwd,
  DIST_CLI,
  REPO_ROOT,
  resolveE2EConfigPath,
} from './real-env.js';

export type IPty = pty.IPty;

export interface SpawnMaOptions {
  configPath?: string;
  command?: 'chat' | 'dev';
  cols?: number;
  rows?: number;
}

export async function canSpawnPty(): Promise<{ ok: boolean; reason?: string }> {
  let proc: pty.IPty;
  try {
    proc = pty.spawn('/bin/echo', ['ok'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: defaultE2ECwd(),
      env: { ...process.env },
    });
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve({ ok: false, reason: 'node-pty echo probe timed out' });
    }, 5000);
    proc.onExit((event) => {
      clearTimeout(timer);
      resolve(
        event.exitCode === 0
          ? { ok: true }
          : { ok: false, reason: `/bin/echo exited ${event.exitCode}` }
      );
    });
  });
}

export function spawnMa(cwd: string, opts: SpawnMaOptions = {}): IPty {
  assertBuiltCli();
  try {
    fs.chmodSync(
      path.join(
        REPO_ROOT,
        'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'
      ),
      0o755
    );
  } catch {}
  const configPath = opts.configPath ?? resolveE2EConfigPath();
  const args = [DIST_CLI, opts.command ?? 'chat'];
  if (configPath) args.push('--config', configPath);
  return pty.spawn(process.execPath, args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 30,
    cwd,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b[78]/g, '')
    .replace(/\x1b\[\?[0-9]+[hl]/g, '');
}

// Ink CLI 下文本 + \r 必须分两次 write,中间 sleep 800ms,否则 submit 不触发 (mnemo: 923)
export async function sendLine(proc: IPty, text: string): Promise<void> {
  proc.write(text);
  await new Promise((r) => setTimeout(r, 800));
  proc.write('\r');
}

export function waitFor(
  proc: IPty,
  predicate: (output: string) => boolean,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sub.dispose();
      reject(
        new Error(
          `waitFor timeout after ${timeoutMs}ms. Tail: ${stripAnsi(output).slice(-400)}`
        )
      );
    }, timeoutMs);
    const sub = proc.onData((data) => {
      if (settled) return;
      output += data;
      if (predicate(output)) {
        settled = true;
        clearTimeout(timer);
        sub.dispose();
        resolve(output);
      }
    });
  });
}

export async function killMa(proc: IPty): Promise<void> {
  try {
    proc.write('/quit\r');
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
  try {
    proc.kill();
  } catch {}
  await new Promise((r) => setTimeout(r, 3000));
}

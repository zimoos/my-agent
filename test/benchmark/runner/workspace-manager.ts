import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

export interface WorkspaceResult {
  workdir: string;
  cleanup: () => Promise<void>;
}

export type WorkspaceFileStatus = 'added' | 'modified' | 'deleted';

export interface WorkspaceFileDiff {
  path: string;
  status: WorkspaceFileStatus;
  diff: string;
}

export interface WorkspaceDiff {
  files: WorkspaceFileDiff[];
  summary: string;
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitInitWithBaseline(workdir: string): void {
  runGit(['init', '--quiet', '--initial-branch=main'], workdir);
  runGit(['config', 'user.email', 'bench@local'], workdir);
  runGit(['config', 'user.name', 'bench'], workdir);
  runGit(['config', 'commit.gpgsign', 'false'], workdir);
  runGit(['add', '-A'], workdir);
  // 允许空目录也能提交，setup 可能还会再改
  runGit(['commit', '--quiet', '--allow-empty', '-m', 'initial'], workdir);
}

export async function prepareWorkspace(
  fixtureDir: string,
  setup?: string[],
): Promise<WorkspaceResult> {
  if (!existsSync(fixtureDir) || !statSync(fixtureDir).isDirectory()) {
    throw new Error(`fixture dir not found: ${fixtureDir}`);
  }

  const workdir = mkdtempSync(join(tmpdir(), 'ma-bench-workspace-'));

  cpSync(fixtureDir, workdir, { recursive: true });

  gitInitWithBaseline(workdir);

  if (setup && setup.length > 0) {
    for (const cmd of setup) {
      execSync(cmd, { cwd: workdir, stdio: 'pipe' });
    }
    // setup 产物进入基线：后续 agent 的 diff 才只反映 agent 改动
    runGit(['add', '-A'], workdir);
    const status = runGit(['status', '--porcelain'], workdir);
    if (status.trim().length > 0) {
      runGit(['commit', '--quiet', '-m', 'setup'], workdir);
    }
  }

  const cleanup = async (): Promise<void> => {
    rmSync(workdir, { recursive: true, force: true });
  };

  return { workdir, cleanup };
}

function parseNameStatus(raw: string): Array<{ path: string; status: WorkspaceFileStatus }> {
  const out: Array<{ path: string; status: WorkspaceFileStatus }> = [];
  const lines = raw.split('\n').filter((l) => l.length > 0);
  for (const line of lines) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const code = line.slice(0, tab).trim();
    const path = line.slice(tab + 1);
    // 处理 rename：R100\told\tnew — 视为 added（新路径）
    if (code.startsWith('R') || code.startsWith('C')) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        out.push({ path: parts[parts.length - 1], status: 'added' });
      }
      continue;
    }
    if (code === 'A') out.push({ path, status: 'added' });
    else if (code === 'M') out.push({ path, status: 'modified' });
    else if (code === 'D') out.push({ path, status: 'deleted' });
    else if (code === 'T') out.push({ path, status: 'modified' });
    // 忽略 U 未合并、? 未跟踪（已 add -A 不会出现）
  }
  return out;
}

function splitDiffByFile(raw: string): Map<string, string> {
  // git diff 输出按 "diff --git a/<p> b/<p>" 切块，key 取 b/<p>
  const map = new Map<string, string>();
  const lines = raw.split('\n');
  let current: { path: string; buf: string[] } | null = null;
  const flush = () => {
    if (current) map.set(current.path, current.buf.join('\n'));
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      // 解析尾部 b/<path>，兼容带空格路径（git 会加引号，这里按最后一个 " b/" 分隔）
      const marker = ' b/';
      const idx = line.lastIndexOf(marker);
      let path = idx >= 0 ? line.slice(idx + marker.length) : '';
      if (path.startsWith('"') && path.endsWith('"')) {
        path = path.slice(1, -1);
      }
      current = { path, buf: [line] };
    } else if (current) {
      current.buf.push(line);
    }
  }
  flush();
  return map;
}

export async function collectDiff(workdir: string): Promise<WorkspaceDiff> {
  if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
    throw new Error(`workdir not found: ${workdir}`);
  }

  runGit(['add', '-A'], workdir);

  const nameStatusRaw = runGit(['diff', '--cached', '--name-status'], workdir);
  const entries = parseNameStatus(nameStatusRaw);

  const diffRaw = runGit(['diff', '--cached'], workdir);
  const diffByFile = splitDiffByFile(diffRaw);

  const summary = runGit(['diff', '--cached', '--stat'], workdir).trimEnd();

  const files: WorkspaceFileDiff[] = entries.map((e) => ({
    path: e.path,
    status: e.status,
    diff: diffByFile.get(e.path) ?? '',
  }));

  return { files, summary };
}

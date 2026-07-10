import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ProviderSessionState } from '../mcp/types.js';

export interface SessionMeta {
  id: string;
  createdAt: number;
  cwd: string;
  model: string;
  messageCount: number;
  providerState?: ProviderSessionState;
}

export interface SessionStore {
  create(meta: Omit<SessionMeta, 'id' | 'messageCount'>): string;
  append(sessionId: string, msg: any): void;
  truncate(sessionId: string, keepMessages: number): void;
  updateProviderState(sessionId: string, providerState: ProviderSessionState): void;
  load(sessionId: string): any[];
  list(limit?: number): SessionMeta[];
  latest(): string | null;
  prune(keep?: number): number;
  getSessionDir(): string;
}

function defaultSessionDir(): string {
  return path.join(os.homedir(), '.my-agent', 'sessions');
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

function makeSessionId(now: number): string {
  return `s_${now}_${randomSuffix()}`;
}

function readMeta(metaPath: string): SessionMeta | null {
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.id === 'string' &&
      typeof parsed?.createdAt === 'number' &&
      typeof parsed?.cwd === 'string' &&
      typeof parsed?.model === 'string' &&
      typeof parsed?.messageCount === 'number'
    ) {
      return parsed as SessionMeta;
    }
    return null;
  } catch {
    return null;
  }
}

function writeMeta(metaPath: string, meta: SessionMeta): void {
  fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');
}

export function createSessionStore(sessionDir?: string): SessionStore {
  const dir = sessionDir ?? defaultSessionDir();
  fs.mkdirSync(dir, { recursive: true });

  const jsonlPath = (id: string): string => path.join(dir, `${id}.jsonl`);
  const metaPath = (id: string): string => path.join(dir, `${id}.meta.json`);
  const sidecarPaths = (id: string): string[] => [
    path.join(dir, `${id}.context.json`),
    path.join(dir, `${id}.pool.jsonl`),
    path.join(dir, `${id}.index.jsonl`),
    path.join(dir, `${id}.patch.jsonl`),
  ];

  function create(partial: Omit<SessionMeta, 'id' | 'messageCount'>): string {
    const id = makeSessionId(Date.now());
    const meta: SessionMeta = { ...partial, id, messageCount: 0 };
    fs.writeFileSync(jsonlPath(id), '', 'utf-8');
    writeMeta(metaPath(id), meta);
    return id;
  }

  function append(sessionId: string, msg: any): void {
    const line = JSON.stringify(msg) + '\n';
    fs.appendFileSync(jsonlPath(sessionId), line, 'utf-8');
    const meta = readMeta(metaPath(sessionId));
    if (meta) {
      meta.messageCount += 1;
      writeMeta(metaPath(sessionId), meta);
    }
  }

  function truncate(sessionId: string, keepMessages: number): void {
    const kept = Math.max(0, keepMessages);
    const messages = load(sessionId).slice(0, kept);
    fs.writeFileSync(
      jsonlPath(sessionId),
      messages.map((msg) => JSON.stringify(msg)).join('\n') + (messages.length > 0 ? '\n' : ''),
      'utf-8'
    );
    const meta = readMeta(metaPath(sessionId));
    if (meta) {
      meta.messageCount = messages.length;
      writeMeta(metaPath(sessionId), meta);
    }
  }

  function updateProviderState(sessionId: string, providerState: ProviderSessionState): void {
    const meta = readMeta(metaPath(sessionId));
    if (!meta) return;
    meta.providerState = providerState;
    writeMeta(metaPath(sessionId), meta);
  }

  function load(sessionId: string): any[] {
    const p = jsonlPath(sessionId);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    const out: any[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  function list(limit?: number): SessionMeta[] {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir);
    const metas: SessionMeta[] = [];
    for (const name of entries) {
      if (!name.endsWith('.meta.json')) continue;
      const m = readMeta(path.join(dir, name));
      if (m) metas.push(m);
    }
    metas.sort((a, b) => b.createdAt - a.createdAt);
    return typeof limit === 'number' ? metas.slice(0, limit) : metas;
  }

  function latest(): string | null {
    const all = list(1);
    return all.length > 0 ? all[0].id : null;
  }

  function prune(keep = 20): number {
    const all = list();
    if (all.length <= keep) return 0;
    const toDelete = all.slice(keep);
    let removed = 0;
    for (const meta of toDelete) {
      try {
        fs.rmSync(jsonlPath(meta.id), { force: true });
        fs.rmSync(metaPath(meta.id), { force: true });
        for (const file of sidecarPaths(meta.id)) {
          fs.rmSync(file, { force: true });
        }
        removed++;
      } catch {
        /* ignore */
      }
    }
    return removed;
  }

  function getSessionDir(): string {
    return dir;
  }

  return { create, append, truncate, updateProviderState, load, list, latest, prune, getSessionDir };
}

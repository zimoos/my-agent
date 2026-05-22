import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const CONTEXT_PATCH_OPEN = '<ma_context_patch>';
export const CONTEXT_PATCH_CLOSE = '</ma_context_patch>';

export type HygieneAction =
  | 'keep'
  | 'demote'
  | 'supersede'
  | 'invalidate'
  | 'protect';

export interface ContextPatch {
  activeTask?: {
    id?: string;
    title?: string;
    goal?: string;
    state?: string;
  };
  keep?: string[];
  hygiene?: Array<{
    target?: string;
    action?: HygieneAction;
    reason?: string;
  }>;
  archiveToPool?: Array<{
    reason?: string;
    messageIds?: string[];
    summary?: string;
    text?: string;
  }>;
  recallFromPool?: Array<{
    query?: string;
    reason?: string;
  }>;
  pin?: string[];
  admitRecall?: Array<{
    entryId?: string;
    mode?: 'snippet' | 'summary' | 'full';
    reason?: string;
  }>;
  rejectRecall?: Array<{
    entryId?: string;
    reason?: string;
  }>;
}

export interface SessionPoolEntry {
  id: string;
  sessionId: string;
  taskId?: string;
  createdAt: number;
  turnIndex?: number;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'summary';
  text: string;
  summary?: string;
  keywords: string[];
  sourceMessageIds?: string[];
  archivedReason?: string;
}

export interface RecalledContext {
  entryId: string;
  query: string;
  reason: string;
  snippet: string;
  updatedAt: number;
}

export interface ActiveContextState {
  sessionId: string;
  currentTask?: {
    id: string;
    title: string;
    goal?: string;
    state?: string;
    updatedAt: number;
  };
  pins: string[];
  recalled: RecalledContext[];
  activeSummaries: string[];
  updatedAt: number;
}

export interface ContextManager {
  state(): ActiveContextState;
  inspect(): string;
  formatForPrompt(): string;
  pin(text: string): string;
  search(query: string, limit?: number): SessionPoolEntry[];
  recall(entryId: string, reason?: string): string;
  applyPatch(rawPatch?: string | null): void;
  archive(entry: Omit<SessionPoolEntry, 'id' | 'sessionId' | 'createdAt' | 'keywords'> & { keywords?: string[] }): SessionPoolEntry | null;
}

const MAX_PIN = 1000;
const MAX_SUMMARY = 1200;
const MAX_RECALLS = 6;
const MAX_RECALL_CHARS = 900;
const MAX_ACTIVE_SUMMARIES = 8;
const VALID_HYGIENE = new Set<HygieneAction>([
  'keep',
  'demote',
  'supersede',
  'invalidate',
  'protect',
]);

function defaultSessionDir(): string {
  return path.join(os.homedir(), '.my-agent', 'sessions');
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

function safeText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

function initialState(sessionId: string): ActiveContextState {
  const now = Date.now();
  return {
    sessionId,
    pins: [],
    recalled: [],
    activeSummaries: [],
    updatedAt: now,
  };
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}

function makeEntryId(now: number): string {
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `p_${now}_${suffix}`;
}

function parsePatch(raw: string): ContextPatch | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed as ContextPatch : null;
  } catch {
    return null;
  }
}

export function createContextManager(
  sessionId: string | undefined,
  sessionDir?: string
): ContextManager {
  const id = sessionId || 'memory';
  const dir = sessionDir ?? defaultSessionDir();
  const statePath = path.join(dir, `${id}.context.json`);
  const poolPath = path.join(dir, `${id}.pool.jsonl`);
  let current = readJson<ActiveContextState>(statePath) ?? initialState(id);
  current.sessionId = id;

  function save(): void {
    current.updatedAt = Date.now();
    if (sessionId) writeJson(statePath, current);
  }

  function loadPool(): SessionPoolEntry[] {
    if (!fs.existsSync(poolPath)) return [];
    const out: SessionPoolEntry[] = [];
    const raw = fs.readFileSync(poolPath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.id === 'string' && typeof parsed?.text === 'string') {
          out.push(parsed as SessionPoolEntry);
        }
      } catch {
        /* skip corrupt pool line */
      }
    }
    return out;
  }

  function appendPool(entry: SessionPoolEntry): void {
    if (!sessionId) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(poolPath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  function archive(
    input: Omit<SessionPoolEntry, 'id' | 'sessionId' | 'createdAt' | 'keywords'> & { keywords?: string[] }
  ): SessionPoolEntry | null {
    const text = safeText(input.text, 8000);
    const summary = safeText(input.summary, MAX_SUMMARY);
    if (!text && !summary) return null;
    const now = Date.now();
    const keywords = input.keywords?.length
      ? input.keywords.slice(0, 30)
      : tokenize(`${summary} ${text}`).slice(0, 30);
    const entry: SessionPoolEntry = {
      ...input,
      id: makeEntryId(now),
      sessionId: id,
      createdAt: now,
      text,
      summary,
      keywords,
    };
    appendPool(entry);
    return entry;
  }

  function search(query: string, limit = 5): SessionPoolEntry[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const now = Date.now();
    return loadPool()
      .map((entry) => {
        const hay = `${entry.summary ?? ''} ${entry.text} ${entry.keywords.join(' ')}`.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (entry.keywords.includes(term)) score += 4;
          if ((entry.summary ?? '').toLowerCase().includes(term)) score += 3;
          if (hay.includes(term)) score += 1;
        }
        const ageHours = Math.max(1, (now - entry.createdAt) / 3_600_000);
        score += Math.max(0, 2 - ageHours / 24);
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt)
      .slice(0, limit)
      .map((item) => item.entry);
  }

  function recall(entryId: string, reason = 'manual recall'): string {
    const entry = loadPool().find((item) => item.id === entryId);
    if (!entry) return `No pool entry found: ${entryId}`;
    const snippet = (entry.summary || entry.text).slice(0, MAX_RECALL_CHARS);
    current.recalled = [
      {
        entryId: entry.id,
        query: entryId,
        reason: reason.slice(0, 300),
        snippet,
        updatedAt: Date.now(),
      },
      ...current.recalled.filter((item) => item.entryId !== entry.id),
    ].slice(0, MAX_RECALLS);
    save();
    return `Recalled ${entry.id}`;
  }

  function pin(text: string): string {
    const value = safeText(text, MAX_PIN);
    if (!value) return 'usage: /context pin <text>';
    if (!current.pins.includes(value)) {
      current.pins.push(value);
      save();
    }
    return `Pinned: ${value}`;
  }

  function applyPatch(rawPatch?: string | null): void {
    if (!rawPatch) return;
    const patch = parsePatch(rawPatch);
    if (!patch) return;
    const now = Date.now();

    const title = safeText(patch.activeTask?.title, 200);
    if (title) {
      current.currentTask = {
        id: safeText(patch.activeTask?.id, 80) || current.currentTask?.id || `t_${now}`,
        title,
        goal: safeText(patch.activeTask?.goal, 500) || undefined,
        state: safeText(patch.activeTask?.state, 500) || undefined,
        updatedAt: now,
      };
    }

    for (const item of patch.pin ?? []) {
      const value = safeText(item, MAX_PIN);
      if (value && !current.pins.includes(value)) current.pins.push(value);
    }

    const summaries: string[] = [];
    for (const item of patch.hygiene ?? []) {
      const action = item.action;
      const target = safeText(item.target, 300);
      const reason = safeText(item.reason, 500);
      if (!action || !VALID_HYGIENE.has(action) || !target) continue;
      if (action === 'protect') {
        const protectedPin = `[protected] ${target}${reason ? ` — ${reason}` : ''}`.slice(0, MAX_PIN);
        if (!current.pins.includes(protectedPin)) current.pins.push(protectedPin);
      } else if (action !== 'keep') {
        summaries.push(`[${action}] ${target}${reason ? ` — ${reason}` : ''}`.slice(0, MAX_SUMMARY));
      }
    }
    if (summaries.length > 0) {
      current.activeSummaries = [...summaries, ...current.activeSummaries].slice(0, MAX_ACTIVE_SUMMARIES);
    }

    for (const item of patch.archiveToPool ?? []) {
      const text = safeText(item.text, 8000);
      const summary = safeText(item.summary, MAX_SUMMARY);
      archive({
        role: 'summary',
        text: text || summary,
        summary,
        sourceMessageIds: Array.isArray(item.messageIds)
          ? item.messageIds.filter((x): x is string => typeof x === 'string')
          : undefined,
        archivedReason: safeText(item.reason, 80) || 'other',
      });
    }

    for (const item of patch.recallFromPool ?? []) {
      const query = safeText(item.query, 300);
      if (!query) continue;
      const reason = safeText(item.reason, 300) || 'model requested recall';
      for (const entry of search(query, 3)) {
        const snippet = (entry.summary || entry.text).slice(0, MAX_RECALL_CHARS);
        current.recalled = [
          { entryId: entry.id, query, reason, snippet, updatedAt: now },
          ...current.recalled.filter((old) => old.entryId !== entry.id),
        ].slice(0, MAX_RECALLS);
      }
    }

    for (const item of patch.rejectRecall ?? []) {
      const entryId = safeText(item.entryId, 100);
      if (entryId) {
        current.recalled = current.recalled.filter((old) => old.entryId !== entryId);
      }
    }

    save();
  }

  function formatForPrompt(): string {
    const lines: string[] = ['[MA Active Context]'];
    if (current.currentTask) {
      lines.push(`Current task: ${current.currentTask.title}`);
      if (current.currentTask.goal) lines.push(`Goal: ${current.currentTask.goal}`);
      if (current.currentTask.state) lines.push(`State: ${current.currentTask.state}`);
    }
    if (current.pins.length > 0) {
      lines.push('Pins:');
      for (const pin of current.pins.slice(0, 8)) lines.push(`- ${pin}`);
    }
    if (current.activeSummaries.length > 0) {
      lines.push('Context hygiene notes:');
      for (const note of current.activeSummaries.slice(0, 6)) lines.push(`- ${note}`);
    }
    if (current.recalled.length > 0) {
      lines.push('Recalled session context:');
      for (const item of current.recalled.slice(0, MAX_RECALLS)) {
        lines.push(`- (${item.entryId}) ${item.snippet}`);
      }
    }
    lines.push(
      'At the end of your final visible response, emit a hidden JSON patch between <ma_context_patch> and </ma_context_patch>. The patch should describe the next-turn context only. Do not mention the patch to the user. Use this compact shape when useful: {"activeTask":{"title":"...","state":"..."},"hygiene":[{"target":"...","action":"keep|demote|supersede|invalidate|protect","reason":"..."}],"recallFromPool":[{"query":"...","reason":"..."}],"pin":["..."]}. If no context change is needed, emit {"hygiene":[]}.'
    );
    return lines.join('\n');
  }

  function inspect(): string {
    const lines = [formatForPrompt()];
    const poolCount = loadPool().length;
    lines.push(`Session pool entries: ${poolCount}`);
    return lines.join('\n');
  }

  return {
    state: () => current,
    inspect,
    formatForPrompt,
    pin,
    search,
    recall,
    applyPatch,
    archive,
  };
}

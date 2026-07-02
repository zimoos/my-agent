import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export interface ContextPatch {
  ops?: ContextOp[];
}

export type ContextOp =
  | { i?: number; act?: 'keep'; reason?: string }
  | { i?: number; act?: 'rm'; reason?: string }
  | { i?: number; act?: 'edit'; res?: string; reason?: string }
  | { i?: number; act?: 'protect'; reason?: string }
  | { act?: 'search'; q?: string; reason?: string };

export interface TranscriptIndexEntry {
  i: number;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'summary';
  text: string;
  createdAt: number;
  turnId?: string;
  pairId?: string;
  pairIds?: string[];
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  immutable: boolean;
}

export interface ActiveContextItem {
  i: number;
  role: TranscriptIndexEntry['role'];
  mode: 'raw' | 'summary' | 'protected';
  content?: string;
  reason?: string;
  updatedAt: number;
}

export interface SessionPoolEntry {
  id: string;
  i?: number;
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
  i?: number;
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
  activeItems: ActiveContextItem[];
  updatedAt: number;
}

export interface ContextPatchAuditEntry {
  id: string;
  sessionId: string;
  createdAt: number;
  rawPatch: string;
  parseOk: boolean;
  rejected: string[];
  appliedOps: Array<Record<string, unknown>>;
  activeBefore: number[];
  activeAfter: number[];
  poolEntryIds: string[];
}

export interface ContextManager {
  state(): ActiveContextState;
  inspect(): string;
  formatForPrompt(): string;
  formatRequestInstructions(): string;
  buildLlmContext(): ChatCompletionMessageParam[];
  pin(text: string): string;
  search(query: string, limit?: number): SessionPoolEntry[];
  recall(entryId: string, reason?: string): string;
  active(): ActiveContextItem[];
  pool(limit?: number): SessionPoolEntry[];
  drop(i: number): string;
  clearActive(): string;
  truncateFrom(i: number): void;
  applyPatch(rawPatch?: string | null): void;
  archive(entry: Omit<SessionPoolEntry, 'id' | 'sessionId' | 'createdAt' | 'keywords'> & { keywords?: string[] }): SessionPoolEntry | null;
  recordMessages(messages: any[]): TranscriptIndexEntry[];
  ensureIndexed(messages: any[]): void;
}

const MAX_PIN = 1000;
const MAX_SUMMARY = 1200;
const MAX_RECALLS = 6;
const MAX_RECALL_CHARS = 900;

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
    activeItems: [],
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

function writeJsonl(file: string, values: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    values.map((value) => JSON.stringify(value)).join('\n') + (values.length > 0 ? '\n' : ''),
    'utf-8'
  );
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
  const indexPath = path.join(dir, `${id}.index.jsonl`);
  const patchPath = path.join(dir, `${id}.patch.jsonl`);
  let current = readJson<ActiveContextState>(statePath) ?? initialState(id);
  current.sessionId = id;
  current.activeItems ??= [];
  let memoryNextIndex = 0;

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

  function loadIndex(): TranscriptIndexEntry[] {
    if (!fs.existsSync(indexPath)) return [];
    const out: TranscriptIndexEntry[] = [];
    const raw = fs.readFileSync(indexPath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.i === 'number' && typeof parsed?.text === 'string') {
          out.push(parsed as TranscriptIndexEntry);
        }
      } catch {
        /* skip corrupt index line */
      }
    }
    return out;
  }

  function appendIndex(entry: TranscriptIndexEntry): void {
    if (!sessionId) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(indexPath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  function appendPatchAudit(entry: ContextPatchAuditEntry): void {
    if (!sessionId) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(patchPath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  function nextTranscriptIndex(): number {
    if (!sessionId) return memoryNextIndex++;
    const entries = loadIndex();
    return entries.length === 0
      ? 0
      : Math.max(...entries.map((entry) => entry.i)) + 1;
  }

  function messageText(msg: any): string {
    const content = msg?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part?.text === 'string') return part.text;
          if (part?.type === 'image_url') return '[image]';
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  function normalizeRole(role: unknown): TranscriptIndexEntry['role'] {
    return role === 'user' ||
      role === 'assistant' ||
      role === 'tool' ||
      role === 'system'
      ? role
      : 'summary';
  }

  function findIndexEntry(i: number): TranscriptIndexEntry | null {
    return loadIndex().find((entry) => entry.i === i) ?? null;
  }

  function pairIdsFor(entry: TranscriptIndexEntry): string[] {
    if (Array.isArray(entry.pairIds) && entry.pairIds.length > 0) {
      return entry.pairIds;
    }
    return entry.pairId ? [entry.pairId] : [];
  }

  function toolGroupFor(
    entry: TranscriptIndexEntry,
    index: TranscriptIndexEntry[]
  ): TranscriptIndexEntry[] {
    const ids = pairIdsFor(entry);
    if (ids.length === 0) return [entry];
    const idSet = new Set(ids);
    const group = index.filter((candidate) =>
      pairIdsFor(candidate).some((id) => idSet.has(id))
    );
    if (group.some((candidate) => candidate.role === 'assistant')) {
      const allIds = new Set<string>();
      for (const candidate of group) {
        for (const id of pairIdsFor(candidate)) allIds.add(id);
      }
      return index.filter((candidate) =>
        pairIdsFor(candidate).some((id) => allIds.has(id))
      );
    }
    const assistant = index.find(
      (candidate) =>
        candidate.role === 'assistant' &&
        pairIdsFor(candidate).some((id) => idSet.has(id))
    );
    if (!assistant) return group;
    const assistantIds = new Set(pairIdsFor(assistant));
    return index.filter((candidate) =>
      pairIdsFor(candidate).some((id) => assistantIds.has(id))
    );
  }

  function isHalfToolGroupOp(
    op: Extract<ContextOp, { i?: number }>,
    source: TranscriptIndexEntry,
    patch: ContextPatch,
    index: TranscriptIndexEntry[]
  ): boolean {
    if (op.act !== 'rm' && op.act !== 'edit') return false;
    const group = toolGroupFor(source, index);
    if (group.length <= 1) return false;
    const groupIds = new Set(group.map((entry) => entry.i));
    const matchingOps = new Set<number>();
    for (const candidate of patch.ops ?? []) {
      if (candidate.act !== op.act) continue;
      const candidateI = (candidate as { i?: number }).i;
      if (Number.isInteger(candidateI) && groupIds.has(candidateI as number)) {
        matchingOps.add(candidateI as number);
      }
    }
    return matchingOps.size !== groupIds.size;
  }

  function upsertActiveItem(item: ActiveContextItem): void {
    current.activeItems = [
      item,
      ...current.activeItems.filter((old) => old.i !== item.i),
    ];
  }

  function recordMessages(messages: any[]): TranscriptIndexEntry[] {
    let next = nextTranscriptIndex();
    const created: TranscriptIndexEntry[] = [];
    for (const msg of messages) {
      const role = normalizeRole(msg?.role);
      if (role === 'system') continue;
      const text = messageText(msg).slice(0, 8000);
      const pairIds =
        typeof msg?.tool_call_id === 'string'
          ? [msg.tool_call_id]
          : Array.isArray(msg?.tool_calls)
            ? msg.tool_calls
                .map((toolCall: any) => toolCall?.id)
                .filter((value: unknown): value is string => typeof value === 'string')
            : [];
      const toolCalls =
        Array.isArray(msg?.tool_calls)
          ? msg.tool_calls
              .filter((tc: any) => tc?.id && tc?.function?.name)
              .map((tc: any) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : '',
              }))
          : undefined;
      const entry: TranscriptIndexEntry = {
        i: next++,
        sessionId: id,
        role,
        text,
        createdAt: Date.now(),
        pairId: pairIds[0],
        pairIds: pairIds.length > 0 ? pairIds : undefined,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        immutable: role === 'user',
      };
      appendIndex(entry);
      created.push(entry);
      upsertActiveItem({
        i: entry.i,
        role: entry.role,
        mode: entry.role === 'user' ? 'protected' : 'raw',
        content: text,
        reason: 'latest transcript message',
        updatedAt: entry.createdAt,
      });
    }
    if (!sessionId) memoryNextIndex = next;
    if (created.length > 0) save();
    return created;
  }

  function ensureIndexed(messages: any[]): void {
    if (loadIndex().length > 0) return;
    recordMessages(messages);
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
    const numericId = Number(entryId);
    const entry = loadPool().find((item) =>
      Number.isInteger(numericId) ? item.i === numericId : item.id === entryId
    );
    if (!entry) return `No pool entry found: ${entryId}`;
    const snippet = (entry.summary || entry.text).slice(0, MAX_RECALL_CHARS);
    if (typeof entry.i === 'number') {
      const source = findIndexEntry(entry.i);
      upsertActiveItem({
        i: entry.i,
        role: source?.role ?? entry.role,
        mode: entry.summary ? 'summary' : 'raw',
        content: entry.summary || undefined,
        reason,
        updatedAt: Date.now(),
      });
    }
    current.recalled = [
      {
        entryId: entry.id,
        i: entry.i,
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

  function active(): ActiveContextItem[] {
    return current.activeItems.slice();
  }

  function pool(limit = 20): SessionPoolEntry[] {
    return loadPool()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  function drop(i: number): string {
    if (!Number.isInteger(i)) return 'usage: /context drop <i>';
    const source = findIndexEntry(i);
    if (source && !source.immutable) {
      archive({
        i,
        role: source.role,
        text: source.text,
        archivedReason: 'demoted',
      });
    }
    const before = current.activeItems.length;
    current.activeItems = current.activeItems.filter((item) => item.i !== i);
    current.recalled = current.recalled.filter((item) => item.i !== i);
    if (current.activeItems.length !== before) {
      save();
      return `Dropped i=${i} from active context`;
    }
    return `No active context item i=${i}`;
  }

  function clearActive(): string {
    current.currentTask = undefined;
    current.recalled = [];
    current.activeItems = [];
    save();
    return 'Cleared active context';
  }

  function activeItemContent(
    item: ActiveContextItem,
    index: TranscriptIndexEntry[]
  ): string {
    const source = index.find((entry) => entry.i === item.i);
    return (item.content || source?.text || '').trim();
  }

  function buildLlmContext(): ChatCompletionMessageParam[] {
    const index = loadIndex();
    const out: ChatCompletionMessageParam[] = [];
    const sorted = current.activeItems
      .slice()
      .sort((a, b) => a.i - b.i);

    for (const item of sorted) {
      const source = index.find((entry) => entry.i === item.i);
      const content = activeItemContent(item, index);

      // Assistant tool_calls must be replayed as a protocol pair with the
      // following tool result. Keep them even when the assistant also emitted
      // visible text; otherwise providers reject the orphan tool message.
      if (source?.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: null,
          tool_calls: source.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        } as any);
        continue;
      }

      if (!content) continue;
      if (item.role === 'user') {
        out.push({ role: 'user', content });
      } else if (item.role === 'tool' && source?.pairId) {
        out.push({ role: 'tool', tool_call_id: source.pairId, content } as any);
      } else {
        out.push({
          role: 'assistant',
          content,
        });
      }
    }

    const hasUser = out.some((msg) => msg.role === 'user');
    if (!hasUser) {
      const latestUser = index
        .filter((entry) => entry.role === 'user')
        .sort((a, b) => b.i - a.i)[0];
      if (latestUser?.text.trim()) {
        out.unshift({ role: 'user', content: latestUser.text.trim() });
      }
    }

    for (const item of current.recalled.slice().reverse()) {
      if (typeof item.i === 'number' && sorted.some((active) => active.i === item.i)) {
        continue;
      }
      if (item.snippet.trim()) {
        out.push({
          role: 'assistant',
          content: `[recalled ${item.entryId}] ${item.snippet.trim()}`,
        });
      }
    }

    return out;
  }

  function truncateFrom(i: number): void {
    if (!Number.isInteger(i) || i < 0) return;
    const index = loadIndex().filter((entry) => entry.i < i);
    const poolEntries = loadPool().filter((entry) =>
      typeof entry.i === 'number' ? entry.i < i : true
    );
    writeJsonl(indexPath, index);
    writeJsonl(poolPath, poolEntries);
    current.activeItems = current.activeItems.filter((item) => item.i < i);
    current.recalled = current.recalled.filter((item) =>
      typeof item.i === 'number' ? item.i < i : true
    );
    save();
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
    const raw = rawPatch.trim();
    const now = Date.now();
    const activeBefore = current.activeItems.map((item) => item.i);
    const rejected: string[] = [];
    const appliedOps: Array<Record<string, unknown>> = [];
    const poolEntryIds: string[] = [];
    const patch = parsePatch(rawPatch);
    if (!patch) {
      appendPatchAudit({
        id: makeEntryId(now),
        sessionId: id,
        createdAt: now,
        rawPatch: raw,
        parseOk: false,
        rejected: ['invalid-json'],
        appliedOps: [],
        activeBefore,
        activeAfter: activeBefore,
        poolEntryIds: [],
      });
      return;
    }

    for (const key of Object.keys(patch as Record<string, unknown>)) {
      if (key !== 'ops') rejected.push(`unsupported-field:${key}`);
    }

    for (const op of patch.ops ?? []) {
      const act = op.act;
      if (!act) {
        rejected.push('missing-act');
        continue;
      }
      const index = loadIndex();
      if (act === 'search') {
        const query = safeText((op as Extract<ContextOp, { act?: 'search' }>).q, 300);
        if (!query) {
          rejected.push('search-missing-query');
          continue;
        }
        const reason = safeText(op.reason, 300) || 'model requested search';
        const recalledIds: string[] = [];
        for (const entry of search(query, 3)) {
          const snippet = (entry.summary || entry.text).slice(0, MAX_RECALL_CHARS);
          recalledIds.push(entry.id);
          current.recalled = [
            { entryId: entry.id, i: entry.i, query, reason, snippet, updatedAt: now },
            ...current.recalled.filter((old) => old.entryId !== entry.id),
          ].slice(0, MAX_RECALLS);
        }
        appliedOps.push({ act, query, recalledIds });
        continue;
      }

      const i = (op as { i?: number }).i;
      if (!Number.isInteger(i)) {
        rejected.push(`${act}:missing-i`);
        continue;
      }
      const targetI = i as number;
      const source = index.find((entry) => entry.i === targetI) ?? null;
      if (!source) {
        rejected.push(`${act}:unknown-i:${targetI}`);
        continue;
      }
      const reason = safeText(op.reason, 500);

      if (act === 'keep') {
        upsertActiveItem({
          i: targetI,
          role: source.role,
          mode: source.immutable ? 'protected' : 'raw',
          reason,
          updatedAt: now,
        });
        appliedOps.push({ act, i: targetI });
        continue;
      }

      if (act === 'protect') {
        upsertActiveItem({
          i: targetI,
          role: source.role,
          mode: 'protected',
          reason,
          updatedAt: now,
        });
        appliedOps.push({ act, i: targetI });
        continue;
      }

      if (source.immutable) {
        rejected.push(`${act}:immutable-user:${targetI}`);
        continue;
      }

      if (isHalfToolGroupOp(op as Extract<ContextOp, { i?: number }>, source, patch, index)) {
        rejected.push(`${act}:half-tool-group:${targetI}`);
        continue;
      }

      if (act === 'rm') {
        current.activeItems = current.activeItems.filter((item) => item.i !== targetI);
        const entry = archive({
          i: targetI,
          role: source.role,
          text: source.text,
          summary: reason ? `[removed from active] ${reason}` : undefined,
          archivedReason: 'demoted',
        });
        if (entry) poolEntryIds.push(entry.id);
        appliedOps.push({ act, i: targetI, poolEntryId: entry?.id });
        continue;
      }

      if (act === 'edit') {
        const res = safeText((op as Extract<ContextOp, { act?: 'edit' }>).res, MAX_SUMMARY);
        if (!res) {
          rejected.push(`edit:missing-res:${targetI}`);
          continue;
        }
        upsertActiveItem({
          i: targetI,
          role: source.role,
          mode: 'summary',
          content: res,
          reason,
          updatedAt: now,
        });
        const entry = archive({
          i: targetI,
          role: source.role,
          text: source.text,
          summary: res,
          archivedReason: 'superseded',
        });
        if (entry) poolEntryIds.push(entry.id);
        appliedOps.push({ act, i: targetI, poolEntryId: entry?.id });
        continue;
      }
      rejected.push(`unsupported-act:${String(act)}`);
    }

    save();
    appendPatchAudit({
      id: makeEntryId(now),
      sessionId: id,
      createdAt: now,
      rawPatch: raw,
      parseOk: true,
      rejected,
      appliedOps,
      activeBefore,
      activeAfter: current.activeItems.map((item) => item.i),
      poolEntryIds,
    });
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
    if (current.activeItems.length > 0) {
      lines.push('Indexed Active Context View:');
      const index = loadIndex();
      for (const item of current.activeItems) {
        const source = index.find((entry) => entry.i === item.i);
        const content = item.content || source?.text || '';
        const prefix = `[i=${item.i} role=${item.role} mode=${item.mode}]`;
        lines.push(`- ${prefix} ${content.replace(/\s+/g, ' ').slice(0, 500)}`);
      }
    }
    if (current.recalled.length > 0) {
      lines.push('Recalled session context:');
      for (const item of current.recalled.slice(0, MAX_RECALLS)) {
        lines.push(`- (${item.entryId}) ${item.snippet}`);
      }
    }
    lines.push(
      'To manage context, use shell commands: ma ctx rm <i>, ma ctx search <q>, ma ctx recall <id>, ma ctx pin <text>, ma ctx clear.'
    );
    return lines.join('\n');
  }

  function formatRequestInstructions(): string {
    const lines: string[] = ['[MA Context Protocol]'];
    if (current.currentTask) {
      lines.push(`Current task: ${current.currentTask.title}`);
      if (current.currentTask.goal) lines.push(`Goal: ${current.currentTask.goal}`);
      if (current.currentTask.state) lines.push(`State: ${current.currentTask.state}`);
    }
    if (current.pins.length > 0) {
      lines.push('Pins:');
      for (const pin of current.pins.slice(0, 8)) lines.push(`- ${pin}`);
    }
    lines.push(
      'To manage context, use: ma ctx rm <i>, ma ctx search <q>, ma ctx recall <id>.'
    );
    return lines.join('\n');
  }

  function inspect(): string {
    const lines = [formatForPrompt()];
    const poolCount = loadPool().length;
    const indexCount = loadIndex().length;
    lines.push(`Transcript index entries: ${indexCount}`);
    lines.push(`Session pool entries: ${poolCount}`);
    return lines.join('\n');
  }

  return {
    state: () => current,
    inspect,
    formatForPrompt,
    formatRequestInstructions,
    buildLlmContext,
    pin,
    search,
    recall,
    active,
    pool,
    drop,
    clearActive,
    truncateFrom,
    applyPatch,
    archive,
    recordMessages,
    ensureIndexed,
  };
}

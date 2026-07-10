import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

type Role = 'user' | 'assistant' | 'tool' | 'system' | 'summary';

interface TranscriptIndexEntry {
  i: number;
  role: Role;
  text: string;
  createdAt?: number;
  immutable?: boolean;
}

interface ActiveContextItem {
  i: number;
  role: Role;
  mode: 'raw' | 'summary' | 'protected';
  content?: string;
  reason?: string;
  updatedAt?: number;
}

interface PoolEntry {
  id: string;
  i?: number;
  role: Role;
  text: string;
  summary?: string;
  archivedReason?: string;
  createdAt?: number;
}

interface PatchAuditEntry {
  id: string;
  createdAt?: number;
  parseOk?: boolean;
  rejected?: string[];
  appliedOps?: Array<Record<string, unknown>>;
  activeBefore?: number[];
  activeAfter?: number[];
  poolEntryIds?: string[];
}

export interface ContextWatchSnapshot {
  sid: string;
  generatedAt: number;
  paths: Record<string, string>;
  visible: Array<{
    seq: number;
    i?: number;
    role: Role;
    text: string;
    status: 'active' | 'compressed' | 'moved' | 'visible-only';
    activeMode?: ActiveContextItem['mode'];
    summary?: string;
  }>;
  llm: Array<{
    i: number;
    role: Role;
    mode: ActiveContextItem['mode'];
    text: string;
    original?: string;
    reason?: string;
    changed: boolean;
  }>;
  pool: Array<PoolEntry & { label: string }>;
  audit: PatchAuditEntry[];
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
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

function roleOf(value: unknown): Role {
  return value === 'user' || value === 'assistant' || value === 'tool' || value === 'system'
    ? value
    : 'summary';
}

function pathsFor(sessionDir: string, sid: string): ContextWatchSnapshot['paths'] {
  return {
    transcript: path.join(sessionDir, `${sid}.jsonl`),
    index: path.join(sessionDir, `${sid}.index.jsonl`),
    context: path.join(sessionDir, `${sid}.context.json`),
    pool: path.join(sessionDir, `${sid}.pool.jsonl`),
    audit: path.join(sessionDir, `${sid}.patch.jsonl`),
  };
}

export function buildContextWatchSnapshot(
  sessionDir: string,
  sid: string
): ContextWatchSnapshot {
  const files = pathsFor(sessionDir, sid);
  const transcript = readJsonl<any>(files.transcript);
  const index = readJsonl<TranscriptIndexEntry>(files.index);
  const state = readJson<{ activeItems?: ActiveContextItem[] }>(files.context);
  const activeItems = Array.isArray(state?.activeItems) ? state.activeItems : [];
  const pool = readJsonl<PoolEntry>(files.pool);
  const audit = readJsonl<PatchAuditEntry>(files.audit).slice(-50).reverse();

  const indexByI = new Map(index.map((entry) => [entry.i, entry]));
  const activeByI = new Map(activeItems.map((item) => [item.i, item]));
  const poolByI = new Map<number, PoolEntry[]>();
  for (const entry of pool) {
    if (typeof entry.i !== 'number') continue;
    poolByI.set(entry.i, [...(poolByI.get(entry.i) ?? []), entry]);
  }

  let nextIndexEntry = 0;
  const visible = transcript
    .filter((msg) => roleOf(msg?.role) !== 'system')
    .map((msg, seq) => {
      const role = roleOf(msg?.role);
      const indexed = index[nextIndexEntry++];
      const active = indexed ? activeByI.get(indexed.i) : undefined;
      const poolEntries = indexed ? poolByI.get(indexed.i) ?? [] : [];
      const compressed = active?.mode === 'summary' || poolEntries.some((p) => p.archivedReason === 'superseded');
      const moved = !active && poolEntries.length > 0;
      return {
        seq,
        i: indexed?.i,
        role,
        text: messageText(msg),
        status: compressed ? 'compressed' as const : moved ? 'moved' as const : active ? 'active' as const : 'visible-only' as const,
        activeMode: active?.mode,
        summary: active?.mode === 'summary' ? active.content : undefined,
      };
    });

  const llm = activeItems
    .slice()
    .sort((a, b) => a.i - b.i)
    .map((item) => {
      const original = indexByI.get(item.i)?.text ?? '';
      const text = (item.content || original).trim();
      return {
        i: item.i,
        role: item.role,
        mode: item.mode,
        text,
        original: item.mode === 'summary' ? original : undefined,
        reason: item.reason,
        changed: item.mode === 'summary' || text !== original,
      };
    });

  return {
    sid,
    generatedAt: Date.now(),
    paths: files,
    visible,
    llm,
    pool: pool
      .slice()
      .reverse()
      .map((entry) => ({
        ...entry,
        label: entry.archivedReason === 'superseded'
          ? 'compressed original'
          : entry.archivedReason === 'demoted'
            ? 'moved out'
            : entry.archivedReason || 'pool',
      })),
    audit,
  };
}

function html(defaultSid?: string): string {
  const sidLiteral = JSON.stringify(defaultSid ?? '');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MA Context Watch</title>
<style>
:root{color-scheme:dark;--bg:#101113;--panel:#181a1f;--line:#2a2d35;--text:#e8e8e8;--muted:#9ca3af;--user:#60a5fa;--llm:#34d399;--pool:#f59e0b;--bad:#fb7185;--summary:#c084fc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{height:48px;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid var(--line);background:#0c0d10;position:sticky;top:0;z-index:2}
input{width:360px;max-width:45vw;background:#111318;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:7px 9px}
button{background:#2563eb;color:white;border:0;border-radius:6px;padding:8px 10px;cursor:pointer}.status{color:var(--muted)}.status.ok{color:var(--llm)}.status.bad{color:var(--bad)}
main{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:10px;height:calc(100vh - 48px)}
.col{min-width:0;background:var(--panel);border:1px solid var(--line);border-radius:8px;display:flex;flex-direction:column;overflow:hidden}
.title{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--line);font-weight:650}.count{color:var(--muted);font-weight:400}
.list{overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.item{border:1px solid var(--line);border-left-width:4px;border-radius:7px;background:#111318;padding:8px;white-space:pre-wrap;word-break:break-word}
.item.user{border-left-color:var(--user)}.item.assistant{border-left-color:var(--llm)}.item.tool{border-left-color:#a3e635}.item.summary{border-left-color:var(--summary)}.item.pool{border-left-color:var(--pool)}.item.moved{opacity:.82}.item.compressed{background:#171226;border-color:#3b2a57;border-left-color:var(--summary)}
.meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;color:var(--muted);font-size:12px;margin-bottom:5px}.pill{border:1px solid var(--line);border-radius:999px;padding:1px 6px;background:#0c0d10}.pill.compressed{color:var(--summary);border-color:#5b3b81}.pill.moved{color:var(--pool);border-color:#7c5419}.pill.protected{color:var(--user);border-color:#244f80}
.text{max-height:220px;overflow:auto}.summaryBox{margin-top:6px;border-top:1px dashed #5b3b81;padding-top:6px;color:#e9d5ff}.orig{margin-top:6px;color:var(--muted);font-size:12px;max-height:120px;overflow:auto;border-top:1px dashed var(--line);padding-top:6px}
@media(max-width:1000px){main{grid-template-columns:1fr;height:auto}.col{min-height:360px}header{height:auto;flex-wrap:wrap;padding:10px}input{max-width:none;width:100%}}
</style>
</head>
<body>
<header>
  <strong>MA Context Watch</strong>
  <input id="sid" placeholder="session id, e.g. s_..." />
  <button id="go">watch</button>
  <span id="status" class="status">disconnected</span>
</header>
<main>
  <section class="col"><div class="title">用户视角 <span id="visibleCount" class="count"></span></div><div id="visible" class="list"></div></section>
  <section class="col"><div class="title">LLM 视角 <span id="llmCount" class="count"></span></div><div id="llm" class="list"></div></section>
  <section class="col"><div class="title">垃圾桶 / Pool <span id="poolCount" class="count"></span></div><div id="pool" class="list"></div></section>
</main>
<script>
const defaultSid = ${sidLiteral};
const params = new URLSearchParams(location.search);
const sidInput = document.getElementById('sid');
const statusEl = document.getElementById('status');
sidInput.value = params.get('sid') || defaultSid || '';
let ws;
function esc(s){return String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function pill(text, cls=''){return '<span class="pill '+cls+'">'+esc(text)+'</span>'}
function itemClass(role, status){return 'item '+esc(role)+' '+esc(status)}
function render(snapshot){
  document.getElementById('visibleCount').textContent = snapshot.visible.length + ' items';
  document.getElementById('llmCount').textContent = snapshot.llm.length + ' items';
  document.getElementById('poolCount').textContent = snapshot.pool.length + ' items';
  document.getElementById('visible').innerHTML = snapshot.visible.map(x => {
    const tags = [pill('i='+(x.i ?? '?')), pill(x.role), pill(x.status, x.status), x.activeMode ? pill(x.activeMode, x.activeMode) : ''].join('');
    const summary = x.summary ? '<div class="summaryBox"><b>LLM summary:</b> '+esc(x.summary)+'</div>' : '';
    return '<article class="'+itemClass(x.role,x.status)+'"><div class="meta">'+tags+'</div><div class="text">'+esc(x.text)+'</div>'+summary+'</article>';
  }).join('') || '<div class="status">no transcript</div>';
  document.getElementById('llm').innerHTML = snapshot.llm.map(x => {
    const tags = [pill('i='+x.i), pill(x.role), pill(x.mode, x.mode), x.changed ? pill('changed','compressed') : ''].join('');
    const orig = x.original ? '<div class="orig"><b>original:</b> '+esc(x.original)+'</div>' : '';
    return '<article class="'+itemClass(x.role,x.mode === 'summary' ? 'compressed' : '')+'"><div class="meta">'+tags+'</div><div class="text">'+esc(x.text)+'</div>'+orig+'</article>';
  }).join('') || '<div class="status">no context sidecar items</div>';
  document.getElementById('pool').innerHTML = snapshot.pool.map(x => {
    const labelClass = x.archivedReason === 'superseded' ? 'compressed' : x.archivedReason === 'demoted' ? 'moved' : '';
    const tags = [pill('i='+(x.i ?? '?')), pill(x.role), pill(x.label,labelClass)].join('');
    const summary = x.summary ? '<div class="summaryBox"><b>summary:</b> '+esc(x.summary)+'</div>' : '';
    return '<article class="item pool"><div class="meta">'+tags+'</div><div class="text">'+esc(x.text)+'</div>'+summary+'</article>';
  }).join('') || '<div class="status">pool empty</div>';
}
function connect(){
  const sid = sidInput.value.trim();
  if(!sid){statusEl.textContent='sid required';statusEl.className='status bad';return;}
  const url = new URL(location.href); url.searchParams.set('sid', sid); history.replaceState(null,'',url);
  if(ws) ws.close();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws?sid=' + encodeURIComponent(sid));
  statusEl.textContent='connecting '+sid; statusEl.className='status';
  ws.onopen=()=>{statusEl.textContent='live '+sid;statusEl.className='status ok'};
  ws.onclose=()=>{statusEl.textContent='disconnected';statusEl.className='status bad'};
  ws.onerror=()=>{statusEl.textContent='ws error';statusEl.className='status bad'};
  ws.onmessage=(ev)=>{const msg=JSON.parse(ev.data); if(msg.type==='snapshot') render(msg.snapshot); if(msg.type==='error'){statusEl.textContent=msg.error;statusEl.className='status bad';}};
}
document.getElementById('go').onclick=connect;
sidInput.addEventListener('keydown',e=>{if(e.key==='Enter')connect()});
if(sidInput.value) connect();
</script>
</body>
</html>`;
}

function send(ws: WebSocket, value: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
}

export async function runContextWatch(opts: {
  sessionDir: string;
  port: number;
  host?: string;
  sid?: string;
}): Promise<void> {
  const host = opts.host ?? '127.0.0.1';
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html(opts.sid));
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const sid = url.searchParams.get('sid') || opts.sid || '';
    if (!sid) {
      send(ws, { type: 'error', error: 'missing sid' });
      ws.close();
      return;
    }
    let last = '';
    const push = (): void => {
      try {
        const snapshot = buildContextWatchSnapshot(opts.sessionDir, sid);
        const encoded = JSON.stringify(snapshot);
        if (encoded !== last) {
          last = encoded;
          send(ws, { type: 'snapshot', snapshot });
        }
      } catch (err) {
        send(ws, { type: 'error', error: (err as Error).message });
      }
    };
    push();
    const timer = setInterval(push, 500);
    ws.on('close', () => clearInterval(timer));
  });

  await new Promise<void>((resolve) => {
    server.listen(opts.port, host, resolve);
  });

  const url = opts.sid
    ? `http://${host}:${opts.port}/?sid=${encodeURIComponent(opts.sid)}`
    : `http://${host}:${opts.port}/`;
  console.log(`context watch: ${url}`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      wss.close();
      server.close(() => resolve());
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

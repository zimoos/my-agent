import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

type Id = string | number | null;
interface Req { jsonrpc: '2.0'; id?: Id; method: string; params?: unknown }
interface Res { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } }

const MAX_LINES = 100;
const MAX_CAPTURE_CHARS = 512 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;
const GREP_TIMEOUT_MS = 20000;

const TOOLS = [
  { name: 'grep',
    description: '在文件中搜索文本模式，返回匹配行和行号。调用系统 grep（默认递归），截断前 100 行。',
    inputSchema: { type: 'object', required: ['pattern', 'path'], properties: {
      pattern: { type: 'string', description: '搜索模式（正则或纯文本）' },
      path: { type: 'string', description: '文件或目录路径' },
      recursive: { type: 'boolean', description: '是否递归搜索子目录（默认 true；保留参数向后兼容）', default: true },
    } } },
];

const send = (r: Res) => process.stdout.write(JSON.stringify(r) + '\n');
const log = (...a: unknown[]) => process.stderr.write('[grep-mcp] ' + a.map(String).join(' ') + '\n');
const ok = (text: string, isError = false) => ({ content: [{ type: 'text', text }], isError });
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);
let pendingRequests = 0;
let inputClosed = false;

function maybeExit() {
  if (inputClosed && pendingRequests === 0) process.exit(0);
}

async function handleGrep(args: Record<string, unknown>): Promise<ReturnType<typeof ok>> {
  const pattern = args.pattern;
  const path = args.path;
  if (typeof pattern !== 'string' || !pattern) return ok('grep: "pattern" must be a non-empty string', true);
  if (typeof path !== 'string' || !path) return ok('grep: "path" must be a non-empty string', true);
  const flags = ['-rn', '-E', '--'];
  const result = await runGrep([...flags, pattern, path]);
  if (result.status === 1 && result.lines.length === 0) return ok('（无匹配）');
  if (result.status !== 0 && !result.truncated) {
    return ok(`grep failed: ${result.stderr || result.error || `exit ${result.status}`}`, true);
  }
  const body = result.lines.join('\n');
  if (!body) return ok('（无匹配）');
  return ok(result.truncated ? `${body}\n[...truncated]` : body);
}

function runGrep(args: string[]): Promise<{
  status: number | null;
  lines: string[];
  stderr: string;
  truncated: boolean;
  error?: string;
}> {
  return new Promise((resolve) => {
    const child = spawn('grep', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let pending = '';
    let stderr = '';
    let capturedChars = 0;
    let truncated = false;
    let settled = false;

    const finish = (status: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const tail = pending.trimEnd();
      if (tail && lines.length < MAX_LINES && capturedChars < MAX_CAPTURE_CHARS) {
        lines.push(tail);
      }
      resolve({ status, lines, stderr: stderr.trim(), truncated, error });
    };

    const stopEarly = () => {
      truncated = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    };

    const timer = setTimeout(() => {
      truncated = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, GREP_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return;
      pending += chunk;
      let idx: number;
      while ((idx = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (!line) continue;
        lines.push(line);
        capturedChars += line.length + 1;
        if (lines.length >= MAX_LINES || capturedChars >= MAX_CAPTURE_CHARS) {
          stopEarly();
          return;
        }
      }
    });

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length >= MAX_STDERR_CHARS) return;
      stderr = (stderr + chunk).slice(0, MAX_STDERR_CHARS);
    });

    child.on('error', (error) => finish(null, error.message));
    child.on('close', (status) => finish(status));
  });
}

async function handleRequest(req: Req): Promise<void> {
  const id = req.id ?? null;
  try {
    if (req.method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'grep-mcp', version: '1.0.0' } } });
      return;
    }
    if (req.method === 'notifications/initialized') return;
    if (req.method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
    if (req.method === 'tools/call') {
      const p = rec(req.params);
      const name = typeof p.name === 'string' ? p.name : '';
      const result = name === 'grep' ? await handleGrep(rec(p.arguments)) : ok(`unknown tool: ${name}`, true);
      send({ jsonrpc: '2.0', id, result });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${req.method}` } });
  } catch (e) {
    log('request handler error:', errMsg(e));
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: errMsg(e) } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Req;
  try { msg = JSON.parse(t) as Req; }
  catch (e) {
    log('parse error:', errMsg(e), 'line:', t);
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${errMsg(e)}` } });
    return;
  }
  pendingRequests += 1;
  handleRequest(msg).catch((e) => {
    log('request handler error:', errMsg(e));
    send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: errMsg(e) } });
  }).finally(() => {
    pendingRequests -= 1;
    maybeExit();
  });
});
rl.on('close', () => {
  inputClosed = true;
  maybeExit();
});

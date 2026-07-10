import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, lstatSync, readlinkSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import pico from 'picocolors';

type Id = string | number | null;
interface Req { jsonrpc: '2.0'; id?: Id; method: string; params?: unknown }
interface Res { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } }

const MAX_FILE_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IGNORED = new Set(['node_modules', '.git', 'dist']);
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg']);
const DEVICES = new Set(['/dev/zero', '/dev/null', '/dev/random', '/dev/urandom', '/dev/tty', '/dev/stdin']);

const TOOLS = [
  { name: 'read_file', description: '读取文件内容，带行号输出。支持 offset/limit 分段读取，二进制文件拒绝，大文件保护 256KB。',
    inputSchema: { type: 'object', required: ['path'], properties: {
      path: { type: 'string', description: '文件路径（必填）。例如: ./package.json' },
      offset: { type: 'number', description: '起始行（1-indexed，可选）' },
      limit: { type: 'number', description: '读取行数（可选）' } } } },
  { name: 'write_file', description: '写入文件，自动创建父目录。行尾统一为 LF。',
    inputSchema: { type: 'object', required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'list_directory', description: '列出目录条目，默认跳过 node_modules/.git/dist，显示符号链接目标。',
    inputSchema: { type: 'object', required: ['path'], properties: {
      path: { type: 'string', description: '目录路径（默认 .）' },
      recursive: { type: 'boolean', default: false },
      maxEntries: { type: 'number', default: 200 } } } },
  { name: 'read_image', description: '读取图片文件并返回 base64 data URL，最大 5MB。',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
];

const mime = (ext: string) => ext === '.jpg' ? 'image/jpeg' : ext === '.svg' ? 'image/svg+xml' : ext === '.ico' ? 'image/x-icon' : `image/${ext.slice(1)}`;
const send = (r: Res) => process.stdout.write(JSON.stringify(r) + '\n');
const log = (...a: unknown[]) => process.stderr.write('[fs-mcp] ' + a.map(String).join(' ') + '\n');
const ok = (text: string, isError = false, structuredContent?: Record<string, unknown>) =>
  structuredContent === undefined
    ? { content: [{ type: 'text', text }], isError }
    : { content: [{ type: 'text', text }], isError, structuredContent };
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);

function mutationEvidence(operation: string, metadata: Record<string, unknown>): Record<string, unknown> {
  const id = randomUUID();
  return {
    id,
    evidenceId: id,
    tool: `fs-mcp__${operation}`,
    server: 'fs-mcp',
    toolName: operation,
    operation,
    status: 'verified',
    ...metadata,
  };
}

function isBinary(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, 512, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } catch { return false; } finally { if (fd !== null) try { closeSync(fd); } catch { /* */ } }
}

function formatLines(s: string, offset: number, limit: number | null): string {
  const all = s.split('\n');
  const start = Math.max(1, offset) - 1;
  const end = limit !== null ? Math.min(all.length, start + limit) : all.length;
  const width = String(end).length;
  const out: string[] = [];
  for (let i = start; i < end; i++) out.push(`${String(i + 1).padStart(width, ' ')}│${all[i]}`);
  return out.join('\n');
}

function fsErr(op: string, path: string, e: unknown) {
  const c = errCode(e);
  if (c === 'ENOENT') return ok(`文件不存在: ${path}`, true);
  if (c === 'EISDIR') return ok(`不是文件（是目录）: ${path}`, true);
  return ok(`${op} failed: ${errMsg(e)}`, true);
}

function handleReadFile(args: Record<string, unknown>) {
  if (typeof args.path !== 'string' || !args.path.trim()) return ok('Error: path parameter is required', true);
  const path = args.path.trim();
  if (DEVICES.has(path)) return ok(`拒绝读取设备文件: ${path}`, true);
  const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 1;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : null;
  const ext = extname(path).toLowerCase();
  try {
    const st = statSync(path);
    if (st.isDirectory()) return ok(`不是文件（是目录）: ${path}`, true);
    if (IMG_EXTS.has(ext)) return ok(`[图片文件] ${path}\n格式: ${mime(ext)}\n大小: ${Math.round(st.size / 1024)}KB\n提示: 这是图片文件，无法以文本形式读取。请使用 read_image 获取 base64 data URL。`);
    if (st.size > MAX_FILE_BYTES && offset === 1 && limit === null) return ok(`文件过大（${Math.round(st.size / 1024)}KB），请指定 offset 和 limit 参数读取部分内容`, true);
    if (isBinary(path)) return ok(`二进制文件，无法读取: ${path}`, true);
    const raw = readFileSync(path, 'utf-8');
    const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const lines = content.split('\n');
    const start = Math.max(1, offset);
    const end = limit === null ? lines.length : Math.min(lines.length, start + limit - 1);
    const complete = end >= lines.length;
    return ok(formatLines(content, offset, limit), false, {
      offset,
      limit,
      totalLines: lines.length,
      start,
      end,
      complete,
      nextOffset: complete ? null : end + 1,
      hash: createHash('sha256').update(raw, 'utf8').digest('hex'),
    });
  } catch (e) { return fsErr('read_file', path, e); }
}

function handleReadImage(args: Record<string, unknown>) {
  const path = args.path;
  if (typeof path !== 'string' || !path) return ok('请提供图片文件路径', true);
  const ext = extname(path).toLowerCase();
  if (!IMG_EXTS.has(ext)) return ok(`不是图片文件: ${path}`, true);
  try {
    const buf = readFileSync(path);
    if (buf.length > MAX_IMAGE_BYTES) return ok(`图片太大（${Math.round(buf.length / 1024 / 1024)}MB），最大支持 5MB`, true);
    return ok(`data:${mime(ext)};base64,${buf.toString('base64')}`);
  } catch (e) { return fsErr('read_image', path, e); }
}

function handleWriteFile(args: Record<string, unknown>) {
  const path = args.path, content = args.content;
  if (typeof path !== 'string' || !path) return ok('write_file: "path" must be a non-empty string', true);
  if (typeof content !== 'string') return ok('write_file: "content" must be a string', true);
  try {
    const parent = dirname(path);
    if (parent && parent !== '.' && parent !== '/') mkdirSync(parent, { recursive: true });
    const existed = existsSync(path);
    let oldContent = '';
    if (existed) {
      try { oldContent = readFileSync(path, 'utf-8'); } catch { /* ignore */ }
    }
    const normalized = content.replace(/\r\n/g, '\n');
    writeFileSync(path, normalized, { encoding: 'utf-8' });
    const bytes = Buffer.byteLength(normalized, 'utf-8');
    let result: string;
    if (existed && oldContent) {
      const diff = generateWriteFileDiff(oldContent, normalized, path);
      result = `已覆盖 ${path}（${bytes} bytes）\n\n--- Diff ---\n${diff}`;
    } else if (existed) {
      // 文件存在但读取失败，仍然生成 diff
      const diff = generateWriteFileDiff('', normalized, path);
      result = `已覆盖 ${path}（${bytes} bytes）\n\n--- Diff ---\n${diff}`;
    } else {
      // 新文件也生成 diff，让所有行显示为新增
      const diff = generateWriteFileDiff('', normalized, path);
      result = `已写入 ${path}（${bytes} bytes）\n\n--- Diff ---\n${diff}`;
    }
    const beforeHash = existed
      ? createHash('sha256').update(oldContent, 'utf8').digest('hex')
      : null;
    const afterHash = createHash('sha256').update(normalized, 'utf8').digest('hex');
    return ok(result, false, {
      'my-agent/evidence': mutationEvidence('write_file', {
        path,
        changed: !existed || oldContent !== normalized,
        existed,
        bytes,
        beforeHash,
        afterHash,
      }),
    });
  } catch (e) { return ok(`write_file failed: ${errMsg(e)}`, true); }
}

function walk(root: string, recursive: boolean, max: number) {
  const lines: string[] = [];
  let total = 0, truncated = false;
  const push = (s: string) => { if (lines.length < max) lines.push(s); else truncated = true; };
  const visit = (dir: string) => {
    if (truncated) return;
    for (const name of readdirSync(dir)) {
      if (truncated) return;
      const full = join(dir, name);
      let lst; try { lst = lstatSync(full); } catch { continue; }
      const rel = relative(root, full) || name;
      total++;
      if (lst.isSymbolicLink()) {
        let target = '?'; try { target = readlinkSync(full); } catch { /* */ }
        push(`[link] ${rel} -> ${target}`);
      } else if (lst.isDirectory()) {
        if (IGNORED.has(name)) { push(`[dir] ${rel}/ (skipped)`); continue; }
        push(`[dir] ${rel}/`);
        if (recursive && !truncated) visit(full);
      } else if (lst.isFile()) push(`[file] ${rel}`);
    }
  };
  visit(root);
  return { lines, truncated, total };
}

function handleListDirectory(args: Record<string, unknown>) {
  const path = (typeof args.path === 'string' && args.path) ? args.path : '.';
  const recursive = args.recursive === true;
  const max = typeof args.maxEntries === 'number' && args.maxEntries > 0 ? Math.floor(args.maxEntries) : 200;
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return ok(`不是目录（是文件）: ${path}`, true);
    const { lines, truncated, total } = walk(path, recursive, max);
    if (truncated) lines.push(`[...truncated, ${total - lines.length} more entries]`);
    return ok(lines.join('\n'));
  } catch (e) {
    if (errCode(e) === 'ENOENT') return ok(`目录不存在: ${path}`, true);
    return ok(`list_directory failed: ${errMsg(e)}`, true);
  }
}

function dispatch(name: string, args: Record<string, unknown>) {
  if (name === 'read_file') return handleReadFile(args);
  if (name === 'write_file') return handleWriteFile(args);
  if (name === 'list_directory') return handleListDirectory(args);
  if (name === 'read_image') return handleReadImage(args);
  return ok(`unknown tool: ${name}`, true);
}

function handleRequest(req: Req): void {
  const id = req.id ?? null;
  try {
    if (req.method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fs-mcp', version: '2.0.0' } } });
      return;
    }
    if (req.method === 'notifications/initialized') return;
    if (req.method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
    if (req.method === 'tools/call') {
      const p = rec(req.params);
      const name = typeof p.name === 'string' ? p.name : '';
      send({ jsonrpc: '2.0', id, result: dispatch(name, rec(p.arguments)) });
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
  handleRequest(msg);
});
rl.on('close', () => process.exit(0));

/**
 * 生成 write_file 的 diff 摘要
 */
function generateWriteFileDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const maxLen = Math.max(oldLines.length, newLines.length);
  const limit = Math.min(maxLen, 60);
  
  let diff = '';
  let added = 0;
  let removed = 0;
  
  for (let i = 0; i < limit; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;
    
    if (oldLine === newLine) {
      // 上下文行
      if (i > 0 && i - 1 < limit && oldLines[i - 1] !== newLines[i - 1]) {
        // 上一行有差异，显示一些上下文
        if (i > 2) {
          const ctxStart = Math.max(0, i - 2);
          for (let j = ctxStart; j < i; j++) {
            const ln = j + 1;
            const line = oldLines[j].replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
            diff += `  ${ln}: ${line}\n`;
          }
        }
      }
    } else {
      if (oldLine !== undefined) {
        const ln = i + 1;
        const line = oldLine.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
        diff += pico.red(`- ${ln}: ${line}`);
        removed++;
      }
      if (newLine !== undefined) {
        const ln = i + 1;
        const line = newLine.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
        diff += pico.green(`+ ${ln}: ${line}`);
        added++;
      }
    }
  }
  
  if (oldLines.length > limit) {
    diff += `\n${pico.dim(`... (${oldLines.length - limit} more old lines)`)}`;
  }
  if (newLines.length > limit) {
    diff += `\n${pico.dim(`... (${newLines.length - limit} more new lines)`)}`;
  }
  
  if (added === 0 && removed === 0) {
    return '(no visible changes)';
  }
  
  return `${pico.green(`+${added}`)} ${pico.red(`-${removed}`)}\n${diff}`;
}

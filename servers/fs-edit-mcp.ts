import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';

type Id = string | number | null;
interface Req { jsonrpc: '2.0'; id?: Id; method: string; params?: unknown }
interface Res { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } }

const MAX_EDIT_BYTES = 512 * 1024;
const DEVICES = new Set(['/dev/zero', '/dev/null', '/dev/random', '/dev/urandom', '/dev/tty', '/dev/stdin']);

const TOOLS = [
  { name: 'file_edit', description: '对已存在文件做精确字符串替换。必须先用 read_file 读过目标文件。old_string 必须在文件中唯一（除非 replace_all=true）。不做 CRLF 归一化、不做模糊匹配、二进制文件拒绝、上限 512KB。',
    inputSchema: { type: 'object', required: ['path', 'old_string', 'new_string'], properties: {
      path: { type: 'string', description: '目标文件路径' },
      old_string: { type: 'string', description: '要被替换的原始文本（必须完整、包含足够上下文以保证唯一）' },
      new_string: { type: 'string', description: '替换为的新文本（可为空串，表示删除）' },
      replace_all: { type: 'boolean', description: '替换所有出现，默认 false', default: false } } } },
];

const send = (r: Res) => process.stdout.write(JSON.stringify(r) + '\n');
const log = (...a: unknown[]) => process.stderr.write('[fs-edit-mcp] ' + a.map(String).join(' ') + '\n');
const ok = (text: string, isError = false) => ({ content: [{ type: 'text', text }], isError });
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);

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

function countOccurrences(hay: string, needle: string): number {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function fsErr(op: string, path: string, e: unknown) {
  const c = errCode(e);
  if (c === 'ENOENT') return ok(`文件不存在: ${path}`, true);
  if (c === 'EISDIR') return ok(`不是文件（是目录）: ${path}`, true);
  return ok(`${op} failed: ${errMsg(e)}`, true);
}

export function handleFileEdit(args: Record<string, unknown>) {
  const path = args.path, oldStr = args.old_string, newStr = args.new_string;
  const replaceAll = args.replace_all === true;
  if (typeof path !== 'string' || !path) return ok('file_edit: "path" must be a non-empty string', true);
  if (typeof oldStr !== 'string') return ok('file_edit: "old_string" must be a string', true);
  if (typeof newStr !== 'string') return ok('file_edit: "new_string" must be a string', true);
  if (oldStr === '') return ok('file_edit: "old_string" 不能为空', true);
  if (oldStr === newStr) return ok('无变化: old_string 与 new_string 相同');
  if (DEVICES.has(path)) return ok(`拒绝编辑设备文件: ${path}`, true);
  try {
    const st = statSync(path);
    if (st.isDirectory()) return ok(`不是文件（是目录）: ${path}`, true);
    if (st.size > MAX_EDIT_BYTES) return ok(`文件过大（${Math.round(st.size / 1024)}KB），file_edit 上限 512KB`, true);
    if (isBinary(path)) return ok(`二进制文件，无法编辑: ${path}`, true);
    const before = readFileSync(path, 'utf-8');
    const count = countOccurrences(before, oldStr);
    if (count === 0) {
      const preview = before.slice(0, 200).replace(/\n/g, '\\n');
      return ok(`old_string 在文件中未找到，请先 read_file 核对内容。文件前 200 字符: ${preview}`, true);
    }
    if (count > 1 && !replaceAll) return ok(`old_string 在文件中出现 ${count} 次，不唯一。请扩大上下文或设 replace_all=true`, true);
    const after = replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
    writeFileSync(path, after, { encoding: 'utf-8' });
    const replaced = replaceAll ? count : 1;
    const delta = Buffer.byteLength(after, 'utf-8') - Buffer.byteLength(before, 'utf-8');
    const sign = delta > 0 ? '+' : '';
    // 生成 diff 信息供前端展示
    const diffLinesBefore = before.split('\n');
    const diffLinesAfter = after.split('\n');
    const diffSummary = generateUnifiedDiffSummary(diffLinesBefore, diffLinesAfter);
    return ok(`已编辑 ${path}：替换 ${replaced} 处，大小变化 ${sign}${delta} bytes\n\n--- Diff ---\n${diffSummary}`);
  } catch (e) { return fsErr('file_edit', path, e); }
}

function dispatch(name: string, args: Record<string, unknown>) {
  if (name === 'file_edit') return handleFileEdit(args);
  return ok(`unknown tool: ${name}`, true);
}

function handleRequest(req: Req): void {
  const id = req.id ?? null;
  try {
    if (req.method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fs-edit-mcp', version: '1.0.0' } } });
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

function main() {
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
}

if (process.argv[1] && (process.argv[1].endsWith('fs-edit-mcp.ts') || process.argv[1].endsWith('fs-edit-mcp.js'))) main();

/**
 * 生成简化的 unified diff 摘要（不依赖 jsdiff，避免循环依赖）
 */
function generateUnifiedDiffSummary(oldLines: string[], newLines: string[]): string {
  const maxLen = Math.max(oldLines.length, newLines.length, 50);
  const limit = Math.min(maxLen, 60); // 最多显示 60 行
  
  let diff = '';
  let hunks = 0;
  let lastOld = -2;
  let lastNew = -2;
  
  for (let i = 0; i < limit; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;
    
    if (oldLine === newLine) {
      // 上下文行
      if (i - lastOld > 1 || i - lastNew > 1) {
        const contextStart = Math.max(0, i - 2);
        const contextEnd = Math.min(oldLines.length - 1, i + 2);
        if (contextStart < contextEnd) {
          diff += '\n';
          for (let j = contextStart; j <= contextEnd && j < oldLines.length; j++) {
            const lineNum = j + 1;
            const line = oldLines[j].replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
            diff += `  ${lineNum}: ${line}\n`;
          }
          hunks++;
        }
        lastOld = i + 3;
        lastNew = i + 3;
      }
    } else {
      // 差异行
      if (oldLine !== undefined) {
        const lineNum = i + 1;
        const line = oldLine.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
        diff += `- ${lineNum}: ${line}\n`;
      }
      if (newLine !== undefined) {
        const lineNum = i + 1;
        const line = newLine.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
        diff += `+ ${lineNum}: ${line}\n`;
      }
      lastOld = i;
      lastNew = i;
    }
  }
  
  if (oldLines.length > limit) {
    diff += `\n... (${oldLines.length - limit} more old lines)\n`;
  }
  if (newLines.length > limit) {
    diff += `\n... (${newLines.length - limit} more new lines)\n`;
  }
  
  return diff || '(no visible changes)';
}

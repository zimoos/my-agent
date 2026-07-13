import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const serverPath = fileURLToPath(new URL('../servers/fs-mcp.ts', import.meta.url));

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function textOf(result: ToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text ?? '' : '';
}

function bodyOf(result: ToolResult): string {
  return textOf(result).split('\n[read_file receipt] ', 1)[0];
}

function pageReceiptOf(result: ToolResult): Record<string, unknown> {
  const receipt = evidenceOf(result).read_file_page;
  assert.ok(receipt && typeof receipt === 'object' && !Array.isArray(receipt));
  return receipt as Record<string, unknown>;
}

function evidenceOf(result: ToolResult): Record<string, unknown> {
  assert.ok(
    result.structuredContent,
    'read_file must return structuredContent alongside the compatible text result',
  );
  return result.structuredContent;
}

function verifiedEvidenceOf(
  result: ToolResult,
  operation: string,
): Record<string, unknown> {
  assert.ok(result.structuredContent, 'successful mutation must return structuredContent');
  const evidence = result.structuredContent['my-agent/evidence'];
  assert.ok(
    evidence && typeof evidence === 'object' && !Array.isArray(evidence),
    'mutation evidence must use structuredContent["my-agent/evidence"]',
  );
  const value = evidence as Record<string, unknown>;
  assert.equal(value.operation, operation);
  assert.equal(value.status, 'verified');
  return value;
}

async function callFsTool(
  name: 'read_file' | 'write_file',
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const child = spawn(process.execPath, ['--import', 'tsx', serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  try {
    const response = new Promise<ToolResult>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once('error', onError);
      lines.once('line', (line) => {
        child.off('error', onError);
        try {
          const message = JSON.parse(line) as { result?: ToolResult; error?: { message: string } };
          if (message.error) reject(new Error(message.error.message));
          else if (!message.result) reject(new Error(`fs-mcp returned no result: ${line}`));
          else resolve(message.result);
        } catch (error) {
          reject(error);
        }
      });
      child.once('exit', (code) => {
        if (code && code !== 0) reject(new Error(`fs-mcp exited ${code}: ${stderr}`));
      });
    });

    child.stdin.end(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })}\n`);
    return await response;
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

test('read_file: keeps the existing numbered text response and adds complete structured evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-mcp-'));
  try {
    const path = join(dir, 'short.txt');
    const content = 'alpha\nbeta\ngamma';
    writeFileSync(path, content);

    const result = await callFsTool('read_file', { path });

    assert.equal(result.isError, false);
    assert.equal(bodyOf(result), '1│alpha\n2│beta\n3│gamma');
    const evidence = evidenceOf(result);
    assert.equal(evidence.offset, 1);
    assert.equal(evidence.limit, null);
    assert.equal(evidence.totalLines, 3);
    assert.equal(evidence.start, 1);
    assert.equal(evidence.end, 3);
    assert.equal(evidence.complete, true);
    assert.equal(evidence.nextOffset, null);
    assert.equal(evidence.nextCursor, null);
    assert.equal(evidence.hash, sha256(content));
    assert.deepEqual(pageReceiptOf(result), {
      kind: 'read_file_page',
      canonical_path: path,
      file_hash: sha256(content),
      cursor: '1:0',
      start_line: 1,
      start_column: 0,
      end_line: 3,
      end_column: 5,
      total_lines: 3,
      complete: true,
      next_offset: null,
      next_cursor: null,
      body_chars: bodyOf(result).length,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file: reports precise evidence for a partial page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-mcp-'));
  try {
    const path = join(dir, 'paged.txt');
    const content = Array.from({ length: 8 }, (_, i) => `line-${i + 1}`).join('\n');
    writeFileSync(path, content);

    const result = await callFsTool('read_file', { path, offset: 3, limit: 2 });
    const evidence = evidenceOf(result);

    assert.equal(bodyOf(result), '3│line-3\n4│line-4');
    assert.equal(evidence.offset, 3);
    assert.equal(evidence.limit, 2);
    assert.equal(evidence.totalLines, 8);
    assert.equal(evidence.start, 3);
    assert.equal(evidence.end, 4);
    assert.equal(evidence.complete, false);
    assert.equal(evidence.nextOffset, 5);
    assert.equal(evidence.hash, sha256(content));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file: nextOffset paginates without gaps or overlap and preserves one file hash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-mcp-'));
  try {
    const path = join(dir, 'all-pages.txt');
    const sourceLines = Array.from({ length: 8 }, (_, i) => `value-${i + 1}`);
    const content = sourceLines.join('\n');
    writeFileSync(path, content);

    const received: string[] = [];
    const hashes = new Set<string>();
    let offset: number | null = 1;
    let pageCount = 0;

    while (offset !== null) {
      const result = await callFsTool('read_file', { path, offset, limit: 3 });
      const evidence = evidenceOf(result);
      const pageLines = bodyOf(result).split('\n');
      received.push(...pageLines.map((line) => line.replace(/^\s*\d+│/, '')));
      hashes.add(String(evidence.hash));
      pageCount++;

      assert.equal(evidence.offset, offset);
      assert.equal(evidence.limit, 3);
      assert.equal(evidence.totalLines, sourceLines.length);
      assert.equal(evidence.start, offset);
      assert.equal(evidence.end, Math.min(offset + 2, sourceLines.length));
      assert.equal(evidence.complete, evidence.end === sourceLines.length);
      assert.equal(
        evidence.nextOffset,
        evidence.complete ? null : Number(evidence.end) + 1,
      );
      offset = evidence.nextOffset as number | null;
    }

    assert.equal(pageCount, 3);
    assert.deepEqual(received, sourceLines);
    assert.deepEqual([...hashes], [sha256(content)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file: normalizes positive integer strings and rejects invalid pagination instead of restarting at line one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-mcp-'));
  try {
    const path = join(dir, 'numeric.txt');
    const content = Array.from({ length: 120 }, (_, i) => `line-${i + 1}`).join('\n');
    writeFileSync(path, content);

    const numeric = await callFsTool('read_file', { path, offset: 100, limit: 2 });
    const stringified = await callFsTool('read_file', { path, offset: '100', limit: '2' });
    assert.equal(bodyOf(stringified), bodyOf(numeric));
    assert.equal(evidenceOf(stringified).offset, 100);
    assert.equal(evidenceOf(stringified).limit, 2);

    for (const [field, value] of [['offset', 'abc'], ['offset', 0], ['offset', -1], ['limit', 'NaN'], ['limit', null]] as const) {
      const failed = await callFsTool('read_file', { path, [field]: value });
      assert.equal(failed.isError, true);
      const error = failed.structuredContent?.error as Record<string, unknown>;
      assert.equal(error.kind, 'invalid_pagination_argument');
      assert.equal(error.field, field);
      assert.doesNotMatch(textOf(failed), /1│line-1/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file: 198-line and 212-line sources reconstruct through bounded pages without gaps', async () => {
  for (const lineCount of [198, 212]) {
    const dir = mkdtempSync(join(tmpdir(), 'fs-mcp-'));
    try {
      const path = join(dir, `large-${lineCount}.ts`);
      const sourceLines = Array.from({ length: lineCount }, (_, i) => `export const value${i + 1} = ${JSON.stringify('x'.repeat(24))};`);
      const content = sourceLines.join('\n');
      writeFileSync(path, content);

      const received: string[] = [];
      let cursor: string | null = '1:0';
      const hashes = new Set<string>();
      while (cursor !== null) {
        const result = await callFsTool('read_file', { path, cursor });
        const receipt = pageReceiptOf(result);
        assert.ok(Number(receipt.body_chars) <= 3200);
        received.push(...bodyOf(result).split('\n').map((line) => line.replace(/^\s*\d+│/, '')));
        hashes.add(String(receipt.file_hash));
        cursor = receipt.next_cursor as string | null;
      }
      assert.equal(received.join('\n'), content, `${lineCount}-line source must reconstruct exactly`);
      assert.deepEqual([...hashes], [sha256(content)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('read_file: a 20K single line reconstructs exactly through column cursors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-mcp-'));
  try {
    const path = join(dir, 'minified.js');
    const content = `const payload=${JSON.stringify('z'.repeat(20_000))};`;
    writeFileSync(path, content);

    let cursor: string | null = '1:0';
    let rebuilt = '';
    let pages = 0;
    while (cursor !== null) {
      const result = await callFsTool('read_file', { path, cursor });
      const receipt = pageReceiptOf(result);
      rebuilt += bodyOf(result).replace(/^\s*1│/, '');
      cursor = receipt.next_cursor as string | null;
      pages++;
    }
    assert.ok(pages > 1);
    assert.equal(rebuilt, content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file: files above 256KB remain available through explicit pagination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-mcp-'));
  try {
    const path = join(dir, 'oversized-generated.ts');
    const content = Array.from({ length: 12_000 }, (_, i) => `export const generated_${i} = ${i};`).join('\n');
    writeFileSync(path, content);
    assert.ok(Buffer.byteLength(content) > 256 * 1024);

    const unpaged = await callFsTool('read_file', { path });
    assert.equal(unpaged.isError, true);
    assert.match(textOf(unpaged), /offset\/limit 或 cursor/);

    const paged = await callFsTool('read_file', { path, offset: '1', limit: '2' });
    assert.equal(paged.isError, false);
    assert.match(bodyOf(paged), /1│export const generated_0/);
    assert.equal(evidenceOf(paged).nextOffset, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write_file: emits canonical verified evidence without replacing legacy text output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fs-mcp-'));
  try {
    const path = join(dir, 'written.txt');
    const content = 'alpha\r\nbeta\n';
    const normalized = 'alpha\nbeta\n';

    const result = await callFsTool('write_file', { path, content });
    const evidence = verifiedEvidenceOf(result, 'write_file');

    assert.equal(result.isError, false);
    assert.match(textOf(result), /^已写入 /);
    assert.match(textOf(result), /--- Diff ---/);
    assert.equal(readFileSync(path, 'utf8'), normalized);
    assert.equal(evidence.changed, true);
    assert.equal(evidence.afterHash, sha256(normalized));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

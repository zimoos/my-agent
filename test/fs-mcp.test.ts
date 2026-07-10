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
    assert.equal(textOf(result), '1│alpha\n2│beta\n3│gamma');
    assert.deepEqual(evidenceOf(result), {
      offset: 1,
      limit: null,
      totalLines: 3,
      start: 1,
      end: 3,
      complete: true,
      nextOffset: null,
      hash: sha256(content),
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

    assert.equal(textOf(result), '3│line-3\n4│line-4');
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
      const pageLines = textOf(result).split('\n');
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

import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface ReadFileReceipt {
  kind: 'read_file_page';
  canonicalPath: string;
  fileHash: string;
  cursor: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  totalLines: number;
  complete: boolean;
  nextOffset: number | null;
  nextCursor: string | null;
  bodyChars: number;
}

interface StoredPage {
  nextCursor: string | null;
  nextOffset: number | null;
  complete: boolean;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

interface StoredFile {
  hash: string;
  totalLines: number;
  pages: Record<string, StoredPage>;
}

interface LedgerSnapshot {
  version: 1;
  files: Record<string, StoredFile>;
}

export interface FileReadCoverageFile {
  path: string;
  hash: string;
  totalLines: number;
  complete: boolean;
  nextCursor: string | null;
  pageCount: number;
}

export interface FileReadCoverage {
  files: FileReadCoverageFile[];
  trackedFiles: number;
  completeFiles: number;
  allComplete: boolean;
}

export interface FileReadRecordResult {
  receipt: ReadFileReceipt;
  duplicate: boolean;
  fileChanged: boolean;
  coverage: FileReadCoverageFile;
}

function finiteInteger(value: unknown, minimum = 0): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value
    : null;
}

function nullableInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = finiteInteger(value, 1);
  return parsed === null ? undefined : parsed;
}

function nullableCursor(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && /^[1-9]\d*:(?:0|[1-9]\d*)$/.test(value)
    ? value
    : undefined;
}

export function parseReadFileReceipt(
  structuredContent: Record<string, unknown> | undefined,
): ReadFileReceipt | null {
  const raw = structuredContent?.read_file_page;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const startLine = finiteInteger(value.start_line, 1);
  const startColumn = finiteInteger(value.start_column, 0);
  const endLine = finiteInteger(value.end_line, 1);
  const endColumn = finiteInteger(value.end_column, 0);
  const totalLines = finiteInteger(value.total_lines, 1);
  const bodyChars = finiteInteger(value.body_chars, 0);
  const nextOffset = nullableInteger(value.next_offset);
  const nextCursor = nullableCursor(value.next_cursor);
  if (
    value.kind !== 'read_file_page' ||
    typeof value.canonical_path !== 'string' || !value.canonical_path ||
    typeof value.file_hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.file_hash) ||
    typeof value.cursor !== 'string' || !/^[1-9]\d*:(?:0|[1-9]\d*)$/.test(value.cursor) ||
    startLine === null || startColumn === null || endLine === null || endColumn === null ||
    totalLines === null || bodyChars === null || typeof value.complete !== 'boolean' ||
    nextOffset === undefined || nextCursor === undefined
  ) return null;
  const cursor = `${startLine}:${startColumn}`;
  if (value.cursor !== cursor || startLine > endLine || endLine > totalLines) return null;
  if (startLine === endLine && endColumn < startColumn) return null;
  if (value.complete) {
    if (endLine !== totalLines || nextOffset !== null || nextCursor !== null) return null;
  } else {
    if (nextCursor === null) return null;
    const sameLineContinuation = `${endLine}:${endColumn}`;
    const nextLine = endLine < totalLines ? `${endLine + 1}:0` : null;
    if (nextCursor !== sameLineContinuation && nextCursor !== nextLine) return null;
    if (nextCursor === cursor) return null;
    const [nextLineNumber, nextColumn] = nextCursor.split(':').map(Number);
    const expectedOffset = nextColumn === 0 ? nextLineNumber : null;
    if (nextOffset !== expectedOffset) return null;
  }
  return {
    kind: 'read_file_page',
    canonicalPath: value.canonical_path,
    fileHash: value.file_hash,
    cursor: value.cursor,
    startLine,
    startColumn,
    endLine,
    endColumn,
    totalLines,
    complete: value.complete,
    nextOffset,
    nextCursor,
    bodyChars,
  };
}

export class FileReadLedger {
  private snapshot: LedgerSnapshot = { version: 1, files: {} };

  constructor(private readonly persistencePath?: string) {
    this.load();
  }

  record(structuredContent: Record<string, unknown> | undefined): FileReadRecordResult | null {
    const receipt = parseReadFileReceipt(structuredContent);
    if (!receipt) return null;
    const previous = this.snapshot.files[receipt.canonicalPath];
    if (previous && previous.hash === receipt.fileHash && previous.totalLines !== receipt.totalLines) {
      return null;
    }
    const fileChanged = Boolean(previous && previous.hash !== receipt.fileHash);
    const file: StoredFile = !previous || fileChanged
      ? { hash: receipt.fileHash, totalLines: receipt.totalLines, pages: {} }
      : previous;
    file.totalLines = receipt.totalLines;
    const existing = file.pages[receipt.cursor];
    const duplicate = Boolean(
      existing &&
      existing.nextCursor === receipt.nextCursor &&
      existing.nextOffset === receipt.nextOffset &&
      existing.complete === receipt.complete &&
      existing.startLine === receipt.startLine &&
      existing.startColumn === receipt.startColumn &&
      existing.endLine === receipt.endLine &&
      existing.endColumn === receipt.endColumn
    );
    if (!duplicate) {
      file.pages[receipt.cursor] = {
        nextCursor: receipt.nextCursor,
        nextOffset: receipt.nextOffset,
        complete: receipt.complete,
        startLine: receipt.startLine,
        endLine: receipt.endLine,
        startColumn: receipt.startColumn,
        endColumn: receipt.endColumn,
      };
      this.snapshot.files[receipt.canonicalPath] = file;
      this.persist();
    }
    return {
      receipt,
      duplicate,
      fileChanged,
      coverage: this.coverageFor(receipt.canonicalPath, file),
    };
  }

  coverage(): FileReadCoverage {
    const files = Object.entries(this.snapshot.files)
      .map(([path, file]) => this.coverageFor(path, file))
      .sort((a, b) => a.path.localeCompare(b.path));
    const completeFiles = files.filter((file) => file.complete).length;
    return {
      files,
      trackedFiles: files.length,
      completeFiles,
      allComplete: files.length > 0 && completeFiles === files.length,
    };
  }

  private coverageFor(path: string, file: StoredFile): FileReadCoverageFile {
    let cursor: string | null = '1:0';
    const visited = new Set<string>();
    let complete = false;
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor);
      const page: StoredPage | undefined = file.pages[cursor];
      if (!page) break;
      if (page.complete && page.nextCursor === null) {
        cursor = null;
        complete = true;
        break;
      }
      cursor = page.nextCursor;
    }
    return {
      path,
      hash: file.hash,
      totalLines: file.totalLines,
      complete,
      nextCursor: complete ? null : cursor,
      pageCount: Object.keys(file.pages).length,
    };
  }

  private load(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.persistencePath, 'utf8')) as LedgerSnapshot;
      if (parsed?.version === 1 && parsed.files && typeof parsed.files === 'object') {
        this.snapshot = parsed;
      }
    } catch {
      this.snapshot = { version: 1, files: {} };
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    mkdirSync(dirname(this.persistencePath), { recursive: true });
    const temp = `${this.persistencePath}.tmp`;
    writeFileSync(temp, JSON.stringify(this.snapshot), 'utf8');
    renameSync(temp, this.persistencePath);
  }
}

export function duplicateReadPageText(record: FileReadRecordResult): string {
  const next = record.coverage.complete
    ? 'coverage is already complete'
    : `continue with cursor=${JSON.stringify(record.coverage.nextCursor)}`;
  return `[read_file duplicate_page] ${record.receipt.canonicalPath} · hash=${record.receipt.fileHash.slice(0, 12)} · cursor=${record.receipt.cursor} · ${next}. The duplicate body was not added to context.`;
}

export function readPageUiSummary(record: FileReadRecordResult): string {
  const page = record.receipt;
  const columnPage = page.startColumn > 0 || (!page.complete && page.nextOffset === null);
  const range = columnPage
    ? `line ${page.startLine} columns ${page.startColumn}-${page.endColumn}`
    : `lines ${page.startLine}-${page.endLine}/${page.totalLines}`;
  const status = record.duplicate
    ? '重复页面已去重'
    : record.coverage.complete
      ? '文件覆盖完成'
      : `页面未读完 · next_cursor=${record.coverage.nextCursor}`;
  const changed = record.fileChanged ? ' · 文件已变化，旧覆盖作废' : '';
  return `[read_file page] ${page.canonicalPath} · ${range} · ${status}${changed} · hash=${page.fileHash.slice(0, 12)} · 正文预览已折叠`;
}

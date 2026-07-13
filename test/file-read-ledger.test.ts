import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FileReadLedger,
  duplicateReadPageText,
  parseReadFileReceipt,
  readPageUiSummary,
} from '../src/agent/file-read-ledger.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    read_file_page: {
      kind: 'read_file_page',
      canonical_path: '/tmp/example.ts',
      file_hash: HASH_A,
      cursor: '1:0',
      start_line: 1,
      start_column: 0,
      end_line: 2,
      end_column: 10,
      total_lines: 4,
      complete: false,
      next_offset: 3,
      next_cursor: '3:0',
      body_chars: 100,
      ...overrides,
    },
  };
}

test('FileReadLedger proves completion only through a contiguous cursor chain', () => {
  const ledger = new FileReadLedger();
  ledger.record(page({
    cursor: '3:0',
    start_line: 3,
    end_line: 4,
    complete: true,
    next_offset: null,
    next_cursor: null,
  }));
  assert.equal(ledger.coverage().allComplete, false);
  assert.equal(ledger.coverage().files[0]?.nextCursor, '1:0');

  ledger.record(page());
  assert.equal(ledger.coverage().allComplete, true);
  assert.equal(ledger.coverage().files[0]?.pageCount, 2);
});

test('FileReadLedger suppresses identical pages and points at the real next cursor', () => {
  const ledger = new FileReadLedger();
  const first = ledger.record(page());
  const duplicate = ledger.record(page());
  assert.ok(first);
  assert.ok(duplicate);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.match(duplicateReadPageText(duplicate), /duplicate_page/);
  assert.match(duplicateReadPageText(duplicate), /cursor="3:0"/);
  assert.equal(duplicateReadPageText(duplicate).includes('body_chars'), false);
});

test('FileReadLedger invalidates old coverage when the file hash changes', () => {
  const ledger = new FileReadLedger();
  ledger.record(page({
    complete: true,
    next_offset: null,
    next_cursor: null,
    end_line: 4,
  }));
  assert.equal(ledger.coverage().allComplete, true);

  const changed = ledger.record(page({ file_hash: HASH_B }));
  assert.ok(changed);
  assert.equal(changed.fileChanged, true);
  assert.equal(ledger.coverage().allComplete, false);
  assert.equal(ledger.coverage().files[0]?.hash, HASH_B);
  assert.equal(ledger.coverage().files[0]?.pageCount, 1);
});

test('FileReadLedger persists only compact receipts across session resume', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-read-ledger-'));
  try {
    const file = join(dir, 'session.reads.json');
    const ledger = new FileReadLedger(file);
    ledger.record(page());
    const resumed = new FileReadLedger(file);
    assert.equal(resumed.coverage().trackedFiles, 1);
    assert.equal(resumed.coverage().files[0]?.nextCursor, '3:0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseReadFileReceipt rejects prose and malformed receipts', () => {
  assert.equal(parseReadFileReceipt(undefined), null);
  assert.equal(parseReadFileReceipt({ read_file_page: 'claimed complete' }), null);
  assert.equal(parseReadFileReceipt(page({ file_hash: 'not-a-hash' })), null);
  assert.equal(parseReadFileReceipt(page({ complete: true, next_cursor: '3:0' })), null);
  assert.equal(parseReadFileReceipt(page({ cursor: '2:0' })), null);
  assert.equal(parseReadFileReceipt(page({ start_line: 3, end_line: 2 })), null);
  assert.equal(parseReadFileReceipt(page({ end_line: 5 })), null);
  assert.equal(parseReadFileReceipt(page({ next_cursor: '4:0', next_offset: 4 })), null);
  assert.equal(parseReadFileReceipt(page({ next_cursor: '2:10', next_offset: 2 })), null);
  assert.equal(parseReadFileReceipt(page({ complete: true, next_offset: null, next_cursor: null })), null);
});

test('parseReadFileReceipt accepts exact long-line continuation and requires matching offset semantics', () => {
  const receipt = parseReadFileReceipt(page({
    end_line: 1,
    end_column: 3100,
    next_offset: null,
    next_cursor: '1:3100',
  }));
  assert.equal(receipt?.nextCursor, '1:3100');
  assert.equal(parseReadFileReceipt(page({
    end_line: 1,
    end_column: 3100,
    next_offset: 1,
    next_cursor: '1:3100',
  })), null);
});

test('readPageUiSummary distinguishes ordinary line pages from long-line columns', () => {
  const ledger = new FileReadLedger();
  const ordinary = ledger.record(page());
  assert.ok(ordinary);
  assert.match(readPageUiSummary(ordinary), /lines 1-2\/4/);

  const longLine = new FileReadLedger().record(page({
    end_line: 1,
    end_column: 3100,
    next_offset: null,
    next_cursor: '1:3100',
  }));
  assert.ok(longLine);
  assert.match(readPageUiSummary(longLine), /line 1 columns 0-3100/);
});

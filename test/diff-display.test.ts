import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React from 'react';
import { renderToString } from 'ink';

import { formatToolResultForUi } from '../src/agent/tool-executor.js';
import { parseToolResultDiff } from '../src/agent/diff-artifact.js';
import {
  collectWorkspaceSnapshot,
  diffWorkspaceSnapshots,
} from '../src/agent/workspace-diff.js';
import { DiffBlock, getDiffLayout } from '../src/cli/components/DiffBlock.js';
import { buildDiffLines, diffDisplayWidth, truncateDiffContent } from '../src/cli/utils/diff-lines.js';

test('parseToolResultDiff: parses fs-edit result with Chinese colon path separator', () => {
  const content = [
    '已编辑 src/app.ts：替换 1 处，大小变化 +7 bytes',
    '',
    '--- Diff ---',
    '- 2: const port = 3000;',
    '+ 2: const port = 8080;',
    '',
  ].join('\n');

  const diff = parseToolResultDiff(content);

  assert.equal(diff?.type, 'diff');
  assert.equal(diff?.filePath, 'src/app.ts');
  assert.equal(diff?.addedLines, 1);
  assert.equal(diff?.removedLines, 1);
  assert.match(diff?.diffText ?? '', /\+ 2: const port = 8080;/);
});

test('parseToolResultDiff: parses write_file summary format', () => {
  const content = [
    '已覆盖 config.json（18 bytes）',
    '',
    '--- Diff ---',
    '+1 -1',
    '- 1: {"port":3000}',
    '+ 1: {"port":8080}',
    '',
  ].join('\n');

  const diff = parseToolResultDiff(content);

  assert.equal(diff?.filePath, 'config.json');
  assert.equal(diff?.addedLines, 1);
  assert.equal(diff?.removedLines, 1);
  assert.match(diff?.diffText ?? '', /- 1: \{"port":3000\}/);
});

test('formatToolResultForUi: preserves diff content instead of 400-char truncation', () => {
  const prefix = `已编辑 src/long.ts：替换 1 处，大小变化 +7 bytes\n\n--- Diff ---\n`;
  const diffLine = `+ 1: ${'x'.repeat(700)}`;
  const content = prefix + diffLine;

  const formatted = formatToolResultForUi(content);

  assert.ok(formatted.length > 400);
  assert.match(formatted, /\+ 1: x{700}/);
});

test('workspace diff: reports only changes made after the starting snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-diff-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  writeFileSync(join(dir, 'tracked.txt'), 'base\n');
  writeFileSync(join(dir, 'dirty.txt'), 'dirty before\n');
  git(dir, ['add', 'tracked.txt', 'dirty.txt']);
  git(dir, ['commit', '-m', 'base']);

  writeFileSync(join(dir, 'dirty.txt'), 'dirty before\nuser change\n');
  const before = collectWorkspaceSnapshot(dir);

  writeFileSync(join(dir, 'tracked.txt'), 'base\nagent change\n');
  writeFileSync(join(dir, 'dirty.txt'), 'dirty before\nuser change\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/new.txt'), 'new file\n');
  const after = collectWorkspaceSnapshot(dir);

  const diff = diffWorkspaceSnapshots(before, after);

  assert.ok(diff);
  assert.deepEqual(
    diff.files.map((f) => `${f.status}:${f.filePath}`),
    ['added:src/new.txt', 'modified:tracked.txt']
  );
  assert.match(diff.summary, /M tracked\.txt \+1\/-0/);
  assert.doesNotMatch(diff.summary, /dirty\.txt/);
});

test('buildDiffLines: parses unified diff into colored line model', () => {
  const lines = buildDiffLines([
    'diff --git a/src/app.ts b/src/app.ts',
    'index 111..222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,2 +1,2 @@',
    '-const port = 3000;',
    '+const port = 8080;',
    ' const ok = true;',
  ].join('\n'));

  assert.deepEqual(
    lines.map((line) => `${line.kind}:${line.oldLine ?? ''}:${line.newLine ?? ''}:${line.sign}:${line.content}`),
    [
      'hunk:::@:@@ -1,2 +1,2 @@',
      'del:1::-:const port = 3000;',
      'add::1:+:const port = 8080;',
      'context:2:2: :const ok = true;',
    ]
  );
});

test('buildDiffLines: classifies MA simple numbered diff format', () => {
  const lines = buildDiffLines([
    '--- a/src/App.tsx',
    '+++ b/src/App.tsx',
    '- 39: const abortRef = useRef<AbortController | null>(null);',
    '+ 39: const scrollListRef = useRef<FixedSizeList>(null);',
    '  40: const streamIdRef = useRef<string>("");',
    '... (230 more old lines)',
  ].join('\n'));

  assert.equal(lines[0].kind, 'file');
  assert.equal(lines[1].kind, 'file');
  assert.deepEqual(lines.slice(2).map((line) => line.kind), [
    'del',
    'add',
    'context',
    'meta',
  ]);
  assert.equal(lines[2].oldLine, 39);
  assert.equal(lines[3].newLine, 39);
  assert.equal(lines[4].oldLine, 40);
  assert.equal(lines[4].newLine, 40);
});

test('truncateDiffContent: keeps diff rows single-line friendly', () => {
  const longMarkdown = '> '.repeat(80) + 'Local-first AI 应用平台，连接任意 OpenAI 兼容端点。';

  const truncated = truncateDiffContent(longMarkdown, 40);

  assert.ok(diffDisplayWidth(truncated) <= 40);
  assert.equal(truncated.endsWith('…'), true);
  assert.match(truncated, /^> > > /);
});

test('truncateDiffContent: respects fullwidth Chinese display columns', () => {
  const longMarkdown = 'Local-first AI 应用平台，连接任意 OpenAI 兼容端点，DeepSeek 无脑配置，本地小模型生产力。';

  const truncated = truncateDiffContent(longMarkdown, 32);

  assert.ok(diffDisplayWidth(truncated) <= 32);
  assert.equal(truncated.endsWith('…'), true);
});

test('getDiffLayout: leaves terminal margin and stable content columns', () => {
  assert.deepEqual(getDiffLayout(80), {
    boxColumns: 76,
    frameContentColumns: 72,
    diffContentColumns: 66,
  });
  assert.equal(getDiffLayout(200).boxColumns, 120);
});

test('DiffBlock: rendered rows fit an 80-column terminal with wide README text', () => {
  const previousColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, 'columns', {
    value: 80,
    configurable: true,
  });

  try {
    const output = renderToString(React.createElement(DiffBlock, {
      diff: {
        type: 'diff',
        filePath: './README.md',
        addedLines: 79,
        removedLines: 79,
        diffText: [
          '--- a/README.md',
          '+++ b/README.md',
          '@@ -1,3 +1,3 @@',
          '-# Supercell 🚀',
          '+# MA',
          '+> Local-first AI 应用平台，连接任意 OpenAI 兼容端点（LM Studio / Ollama / OpenAI 等），提供多轮对话、Agent 团队协作、数据分析三大核心能力。',
          '-| `VITE_OPENAI_BASE_URL` | OpenAI 兼容 API 地址 | `http://localhost:1234/v1` |',
          '+| `VITE_OPENAI_BASE_URL` | OpenAI 兼容 API 地址 | `http://localhost:1234/v1` |',
          '... (151 lines collapsed) ...',
        ].join('\n'),
      },
    }));

    for (const line of output.split('\n')) {
      assert.ok(diffDisplayWidth(stripAnsi(line)) <= 80, line);
    }
    assert.match(output, /Local-first AI 应用平台/);
    assert.match(output, /…/);
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: previousColumns,
      configurable: true,
    });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

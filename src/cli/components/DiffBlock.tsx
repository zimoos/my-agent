/**
 * DiffBlock 组件 — 智能折叠 diff 显示
 *
 * 根据变更行数自动选择显示策略：
 * - ≤ 50 行：完整显示
 * - 51-200 行：摘要 + 前10行 + 折叠标记 + 后10行
 * - > 200 行：仅摘要框
 */

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import pico from 'picocolors';
import type { DiffData } from '../state/types.js';
import { buildDiffLines, diffDisplayWidth, truncateDiffContent, type RenderDiffLine } from '../utils/diff-lines.js';

interface DiffBlockProps {
  diff: DiffData;
}

/** 折叠标记 */
const COLLAPSE_MARKER = pico.yellow('  · · ·');

/** 最大显示行数（含上下文） */
const MAX_VISIBLE = 10;
const MIN_BOX_COLUMNS = 48;
const MAX_BOX_COLUMNS = 120;
const TERMINAL_MARGIN_COLUMNS = 4;
const DIFF_GUTTER_COLUMNS = 10;

export function DiffBlock({ diff }: DiffBlockProps) {
  const totalChanges = diff.addedLines + diff.removedLines;
  const { stdout } = useStdout();
  const terminalColumns = stdout.columns || process.stdout.columns || 80;
  const layout = getDiffLayout(terminalColumns);

  // === 策略 1: 大文件 → 仅摘要 ===
  if (totalChanges > 200) {
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <DiffFrameHeader diff={diff} layout={layout} />
        <FrameRow layout={layout} color="yellow" text="  ! Full diff hidden (too large)" />
        <FrameBorder layout={layout} edge="bottom" />
      </Box>
    );
  }

  // === 策略 2: 中等文件 → 摘要 + 前N/后N行 ===
  if (totalChanges > 50) {
    const contentLines = buildDiffLines(diff.diffText);
    const half = Math.floor(MAX_VISIBLE / 2);
    const head = contentLines.slice(0, half);
    const tail = contentLines.slice(-half);
    const collapsed = Math.max(0, contentLines.length - head.length - tail.length);

    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <DiffFrameHeader diff={diff} layout={layout} />
        <Box flexDirection="column">
          {head.map((line, i) => (
            <DiffLine key={`h-${i}`} line={line} layout={layout} />
          ))}
          {collapsed > 0 && (
            <Box>
              <Text dimColor wrap="truncate-end">
                {truncateDiffContent(`${COLLAPSE_MARKER} (${collapsed} lines collapsed) ${COLLAPSE_MARKER}`, layout.boxColumns)}
              </Text>
            </Box>
          )}
          {tail.map((line, i) => (
            <DiffLine key={`t-${i}`} line={line} layout={layout} />
          ))}
        </Box>
        <FrameBorder layout={layout} edge="bottom" />
      </Box>
    );
  }

  // === 策略 3: 小文件 → 完整显示 ===
  const contentLines = buildDiffLines(diff.diffText);

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <DiffFrameHeader diff={diff} layout={layout} />
      <Box flexDirection="column">
        {contentLines.map((line, i) => (
          <DiffLine key={i} line={line} layout={layout} />
        ))}
      </Box>
      <FrameBorder layout={layout} edge="bottom" />
    </Box>
  );
}

export interface DiffLayout {
  boxColumns: number;
  frameContentColumns: number;
  diffContentColumns: number;
}

export function getDiffLayout(terminalColumns: number): DiffLayout {
  const available = Math.max(MIN_BOX_COLUMNS, terminalColumns - TERMINAL_MARGIN_COLUMNS);
  const boxColumns = clamp(available, MIN_BOX_COLUMNS, MAX_BOX_COLUMNS);
  return {
    boxColumns,
    frameContentColumns: Math.max(16, boxColumns - 4),
    diffContentColumns: Math.max(16, boxColumns - DIFF_GUTTER_COLUMNS),
  };
}

function DiffFrameHeader({ diff, layout }: { diff: DiffData; layout: DiffLayout }) {
  return (
    <>
      <FrameBorder layout={layout} edge="top" />
      <FrameRow layout={layout} color="cyan" text={`[file] ${diff.filePath}`} bold />
      <FrameRow layout={layout} text={`   +${diff.addedLines} / -${diff.removedLines} lines changed`} />
    </>
  );
}

function FrameBorder({ layout, edge }: { layout: DiffLayout; edge: 'top' | 'bottom' }) {
  const left = edge === 'top' ? '┌' : '└';
  const right = edge === 'top' ? '┐' : '┘';
  return (
    <Box>
      <Text color="blue">{left}{'─'.repeat(layout.boxColumns - 2)}{right}</Text>
    </Box>
  );
}

function FrameRow({
  layout,
  text,
  color,
  bold = false,
}: {
  layout: DiffLayout;
  text: string;
  color?: 'cyan' | 'yellow';
  bold?: boolean;
}) {
  const content = padRight(truncateDiffContent(text, layout.frameContentColumns), layout.frameContentColumns);
  return (
    <Box>
      <Text color="blue">│ </Text>
      <Text color={color} bold={bold} wrap="truncate-end">{content}</Text>
      <Text color="blue"> │</Text>
    </Box>
  );
}

function DiffLine({ line, layout }: { line: RenderDiffLine; layout: DiffLayout }) {
  const oldLine = formatLineNo(line.oldLine);
  const newLine = formatLineNo(line.newLine);

  if (line.kind === 'file') {
    const content = truncateDiffContent(line.content, layout.boxColumns - 5);
    return (
      <Box>
        <Text color="cyan" dimColor wrap="truncate-end">{'     '}{content}</Text>
      </Box>
    );
  }
  if (line.kind === 'hunk') {
    const content = truncateDiffContent(line.content, layout.boxColumns - 5);
    return (
      <Box>
        <Text color="yellow" wrap="truncate-end">{'     '}{content}</Text>
      </Box>
    );
  }
  if (line.kind === 'meta') {
    const content = truncateDiffContent(line.content, layout.boxColumns - 5);
    return (
      <Box>
        <Text color="yellow" dimColor wrap="truncate-end">{'     '}{content}</Text>
      </Box>
    );
  }

  const color = line.kind === 'add' ? 'green' : line.kind === 'del' ? 'red' : undefined;
  const dim = line.kind === 'context';
  const content = truncateDiffContent(line.content, layout.diffContentColumns);

  return (
    <Box>
      <Text color={color} dimColor={dim} wrap="truncate-end">{`${oldLine} ${newLine} ${line.sign} ${content}`}</Text>
    </Box>
  );
}

function formatLineNo(value: number | undefined): string {
  return value === undefined ? '   ' : String(value).padStart(3, ' ');
}

function padRight(value: string, columns: number): string {
  return `${value}${' '.repeat(Math.max(0, columns - diffDisplayWidth(value)))}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

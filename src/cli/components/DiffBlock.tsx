/**
 * DiffBlock 组件 — 智能折叠 diff 显示
 *
 * 根据变更行数自动选择显示策略：
 * - ≤ 50 行：完整显示
 * - 51-200 行：摘要 + 前10行 + 折叠标记 + 后10行
 * - > 200 行：仅摘要框
 */

import React from 'react';
import { Box, Text } from 'ink';
import pico from 'picocolors';
import type { DiffData } from '../state/types.js';

interface DiffBlockProps {
  diff: DiffData;
}

/** 折叠标记 */
const COLLAPSE_MARKER = pico.yellow('  · · ·');

/** 最大显示行数（含上下文） */
const MAX_VISIBLE = 10;

export function DiffBlock({ diff }: DiffBlockProps) {
  const totalChanges = diff.addedLines + diff.removedLines;

  // === 策略 1: 大文件 → 仅摘要 ===
  if (totalChanges > 200) {
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Box>
          <Text color="blue">{pico.blue('┌─')} {pico.blue('─'.repeat(58))} {pico.blue('┐')}</Text>
        </Box>
        <Box>
          <Text color="blue">{pico.blue('│')} {pico.dim('📝 ')} {pico.cyan(pico.bold(diff.filePath))} {pico.blue('│')}</Text>
        </Box>
        <Box>
          <Text color="blue">{pico.blue('│')} {pico.dim('   ')} {pico.green(`+${diff.addedLines}`)} {pico.dim('/')} {pico.red(`-${diff.removedLines}`)} {pico.dim('lines changed')} {pico.blue('│')}</Text>
        </Box>
        <Box>
          <Text color="blue">{pico.blue('│')} {pico.yellow('  ⚠ Full diff hidden (too large)')} {pico.blue('│')}</Text>
        </Box>
        <Box>
          <Text color="blue">{pico.blue('└─')} {pico.blue('─'.repeat(58))} {pico.blue('┘')}</Text>
        </Box>
      </Box>
    );
  }

  // === 策略 2: 中等文件 → 摘要 + 前N/后N行 ===
  if (totalChanges > 50) {
    const lines = diff.diffText.split('\n');
    // 跳过 header（前4行）和 closing border（最后一行）
    const contentLines = lines.slice(4, -1);
    const half = Math.floor(MAX_VISIBLE / 2);
    const head = contentLines.slice(0, half);
    const tail = contentLines.slice(-half);

    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Box>
          <Text color="blue">{pico.blue('┌─')} {pico.blue('─'.repeat(58))} {pico.blue('┐')}</Text>
        </Box>
        <Box>
          <Text color="blue">{pico.blue('│')} {pico.dim('📝 ')} {pico.cyan(pico.bold(diff.filePath))} {pico.blue('│')}</Text>
        </Box>
        <Box>
          <Text color="blue">{pico.blue('│')} {pico.dim('   ')} {pico.green(`+${diff.addedLines}`)} {pico.dim('/')} {pico.red(`-${diff.removedLines}`)} {pico.dim('lines changed')} {pico.blue('│')}</Text>
        </Box>
        <Box flexDirection="column">
          {head.map((line, i) => (
            <Box key={`h-${i}`}>
              <Text>{line}</Text>
            </Box>
          ))}
          <Box>
            <Text dimColor>{COLLAPSE_MARKER} ({totalChanges - MAX_VISIBLE} lines collapsed) {COLLAPSE_MARKER}</Text>
          </Box>
          {tail.map((line, i) => (
            <Box key={`t-${i}`}>
              <Text>{line}</Text>
            </Box>
          ))}
        </Box>
        <Box>
          <Text color="blue">{pico.blue('└─')} {pico.blue('─'.repeat(58))} {pico.blue('┘')}</Text>
        </Box>
      </Box>
    );
  }

  // === 策略 3: 小文件 → 完整显示 ===
  const lines = diff.diffText.split('\n');
  const contentLines = lines.slice(4, -1);

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box>
        <Text color="blue">{pico.blue('┌─')} {pico.blue('─'.repeat(58))} {pico.blue('┐')}</Text>
      </Box>
      <Box>
        <Text color="blue">{pico.blue('│')} {pico.dim('📝 ')} {pico.cyan(pico.bold(diff.filePath))} {pico.blue('│')}</Text>
      </Box>
      <Box>
        <Text color="blue">{pico.blue('│')} {pico.dim('   ')} {pico.green(`+${diff.addedLines}`)} {pico.dim('/')} {pico.red(`-${diff.removedLines}`)} {pico.dim('lines changed')} {pico.blue('│')}</Text>
      </Box>
      <Box flexDirection="column">
        {contentLines.map((line, i) => (
          <Box key={i}>
            <Text>{line}</Text>
          </Box>
        ))}
      </Box>
      <Box>
        <Text color="blue">{pico.blue('└─')} {pico.blue('─'.repeat(58))} {pico.blue('┘')}</Text>
      </Box>
    </Box>
  );
}

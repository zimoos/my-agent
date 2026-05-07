/**
 * DiffBlock 组件
 * 
 * 在 Ink TUI 中渲染带颜色的 diff 输出。
 * 使用 Text 组件输出 ANSI 颜色字符串。
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DiffData } from '../state/types.js';

interface DiffBlockProps {
  diff: DiffData;
}

export function DiffBlock({ diff }: DiffBlockProps) {
  // 如果 diff 为空，不渲染
  if (!diff.diffText) {
    return null;
  }

  const lines = diff.diffText.split('\n');
  // 跳过 header 行（前4行）和 closing border（最后一行）
  const contentLines = lines.slice(4, -1);

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {contentLines.map((line: string, i: number) => (
        <Box key={i}>
          <Text>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

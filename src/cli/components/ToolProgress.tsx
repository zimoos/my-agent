import React from 'react';
import { Box, Text } from 'ink';
import type { DiffData } from '../state/types.js';

interface ToolProgressProps {
  name: string;
  ok: boolean;
  preview?: string;
  diff?: DiffData;
}

export function ToolProgress({ name, ok, preview, diff }: ToolProgressProps) {
  // 如果有 diff 数据，渲染 diff
  if (ok && diff && diff.diffText) {
    const lines = diff.diffText.split('\n');
    // 第二行是文件路径
    const filePathLine = lines[1] || '';
    
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color="blue">{'  '}</Text>
          <Text color="green" bold>✓</Text>
          <Text color="green">{name}</Text>
        </Box>
        <Box>
          <Text color="blue">{'    '}</Text>
          <Text color="cyan">{filePathLine.replace(/│/g, '│').trim() || diff.filePath}</Text>
        </Box>
        <Box>
          <Text dimColor>
            {'      '}
            <Text color="green" bold>{`+${diff.addedLines}`}</Text>
            <Text color="gray"> / </Text>
            <Text color="red" bold>{`-${diff.removedLines}`}</Text>
            <Text color="gray"> lines changed</Text>
          </Text>
        </Box>
        <Box flexDirection="column">
          {lines.slice(4, -1).map((line: string, i: number) => (
            <Box key={i}>
              <Text>{line}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    );
  }
  
  // 默认渲染
  return (
    <Text>
      <Text dimColor>{'  '}</Text>
      {ok ? (
        <Text dimColor color="green">
          ✓ {name}
        </Text>
      ) : (
        <Text dimColor color="red">
          ✗ {preview || name}
        </Text>
      )}
    </Text>
  );
}

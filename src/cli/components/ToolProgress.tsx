import React from 'react';
import { Box, Text } from 'ink';
import pico from 'picocolors';
import type { DiffData } from '../state/types.js';
import { DiffBlock } from './DiffBlock.js';

interface ToolProgressProps {
  name: string;
  ok: boolean;
  preview?: string;
  diff?: DiffData;
}

export function ToolProgress({ name, ok, preview, diff }: ToolProgressProps) {
  // 有 diff 数据时：显示摘要 + DiffBlock（自动折叠）
  if (ok && diff) {
    const totalChanges = diff.addedLines + diff.removedLines;
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="green" bold>✓</Text>
          <Text color="green"> {name}</Text>
        </Box>
        <Box>
          <Text color="cyan">{diff.filePath}</Text>
        </Box>
        <Box>
          <Text dimColor>
            {pico.green(`+${diff.addedLines}`)}
            {' / '}
            {pico.red(`-${diff.removedLines}`)}
            {' lines changed'}
            {diff.truncated ? ` ${pico.yellow('(truncated)' )}` : ''}
          </Text>
        </Box>
        {totalChanges > 0 && <DiffBlock diff={diff} />}
      </Box>
    );
  }

  // 默认渲染
  return (
    <Box>
      {ok ? (
        <Text color="green">✓ {name}</Text>
      ) : (
        <Text color="red">✗ {preview || name}</Text>
      )}
    </Box>
  );
}

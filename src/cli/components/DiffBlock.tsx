import React from 'react';
import { Box, Text } from 'ink';
import type { DiffData } from '../state/types.js';
import {
  buildDiffLines,
  truncateDiffContent,
  type RenderDiffLine,
} from '../utils/diff-lines.js';

interface DiffBlockProps {
  diff: DiffData;
}

export interface DiffLayout {
  boxColumns: number;
  frameContentColumns: number;
  diffContentColumns: number;
}

export function getDiffLayout(terminalColumns = process.stdout.columns || 80): DiffLayout {
  const boxColumns = Math.max(40, Math.min(120, terminalColumns - 4));
  const frameContentColumns = Math.max(20, boxColumns - 4);
  const diffContentColumns = Math.max(10, frameContentColumns - 6);
  return { boxColumns, frameContentColumns, diffContentColumns };
}

export function DiffBlock({ diff }: DiffBlockProps) {
  const lines = buildDiffLines(diff.diffText);
  const layout = getDiffLayout();

  return (
    <Box flexDirection="column" marginTop={1} width={layout.boxColumns}>
      <Box>
        <Text color="cyan">
          {truncateDiffContent(`[file] ${diff.filePath}`, layout.frameContentColumns)}
        </Text>
        <Text dimColor> +{diff.addedLines} / -{diff.removedLines}</Text>
      </Box>
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} layout={layout} />
      ))}
    </Box>
  );
}

function DiffLine({ line, layout }: { line: RenderDiffLine; layout: DiffLayout }) {
  if (line.kind === 'hunk') {
    return (
      <Box>
        <Text color="yellow">
          {truncateDiffContent(line.content, layout.frameContentColumns)}
        </Text>
      </Box>
    );
  }
  if (line.kind === 'file') {
    return (
      <Box>
        <Text dimColor>
          {truncateDiffContent(line.content, layout.frameContentColumns)}
        </Text>
      </Box>
    );
  }
  if (line.kind === 'meta') {
    return (
      <Box>
        <Text dimColor>
          {'     '}{truncateDiffContent(line.content, layout.diffContentColumns)}
        </Text>
      </Box>
    );
  }

  const color = line.kind === 'add' ? 'green' : line.kind === 'del' ? 'red' : undefined;
  const oldNo = line.oldLine !== undefined ? String(line.oldLine).padStart(4, ' ') : '    ';
  const newNo = line.newLine !== undefined ? String(line.newLine).padStart(4, ' ') : '    ';

  return (
    <Box>
      <Text dimColor={line.kind === 'context'} color={color}>
        {oldNo} {newNo} {line.sign} {truncateDiffContent(line.content, layout.diffContentColumns)}
      </Text>
    </Box>
  );
}

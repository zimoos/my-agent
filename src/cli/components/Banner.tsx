import React from 'react';
import { Box, Text } from 'ink';
import { VERSION } from '../../version.js';

interface BannerProps {
  model: string;
  baseURL: string;
  mcp: Array<{ name: string; toolCount: number }>;
}

const LOGO = [
  '  ███╗   ███╗ █████╗ ',
  '  ████╗ ████║██╔══██╗',
  '  ██╔████╔██║███████║',
  '  ██║╚██╔╝██║██╔══██║',
  '  ██║ ╚═╝ ██║██║  ██║',
  '  ╚═╝     ╚═╝╚═╝  ╚═╝',
];

export function Banner({ model, baseURL, mcp }: BannerProps) {
  const mcpStr =
    mcp.map((m) => `${m.name}(${m.toolCount})`).join(', ') || '(none)';
  return (
    <Box flexDirection="column" marginBottom={1}>
      {LOGO.slice(0, -1).map((line, i) => (
        <Text key={i} bold color="magenta">{line}</Text>
      ))}
      <Text>
        <Text bold color="magenta">{LOGO[LOGO.length - 1]}</Text>
        <Text dimColor>  v{VERSION}</Text>
      </Text>
      <Text> </Text>
      <Text dimColor>
        {'  '}<Text color="magenta">{model}</Text> <Text dimColor>· {baseURL}</Text>
      </Text>
      <Text dimColor>
        {'  '}<Text color="green">{mcpStr}</Text>
      </Text>
    </Box>
  );
}

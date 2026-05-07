import React from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../state/types.js';
import { ToolProgress } from './ToolProgress.js';
import { Separator } from './Separator.js';
import { Markdown } from './Markdown.js';
import { Banner } from './Banner.js';

interface MessageViewProps {
  message: Message;
}

export function MessageView({ message }: MessageViewProps) {
  switch (message.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="cyan">❯ </Text>
          <Text bold>{message.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Markdown source={message.markdown} />
        </Box>
      );
    case 'tool':
      return (
        <ToolProgress
          name={message.name}
          ok={message.ok}
          preview={message.preview}
          diff={message.diff}
        />
      );
    case 'system':
      return <Text dimColor>{message.text}</Text>;
    case 'separator':
      return <Separator elapsed={message.elapsed} />;
    case 'banner':
      return <Banner model={message.data.model} baseURL={message.data.baseURL} mcp={message.data.mcp} />;
  }
}

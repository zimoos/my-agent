import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { AgentConfig, McpConnection, Agent } from '../mcp/types.js';
import { createUiStore } from './state/store.js';
import { useAgent } from './hooks/useAgent.js';
import { useDebugLog } from './hooks/useDebugLog.js';
import {
  checkClipboardImage,
  getImageSize,
  imageToBase64DataUrl,
} from './hooks/useClipboard.js';
import type { UiImage } from './state/types.js';
import { Banner } from './components/Banner.js';
import { ChatHistory } from './components/ChatHistory.js';
import { ThinkingBar } from './components/ThinkingBar.js';
import { InputBox } from './components/InputBox.js';
import { StatusBar } from './components/StatusBar.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import type { PendingConfirm } from './hooks/useAgent.js';
import { isCommand, executeCommand } from './utils/commands.js';

export interface AppProps {
  config: AgentConfig;
  connections: McpConnection[];
  agent: Agent;
  debug?: boolean;
}

let sysMsgCounter = 0;
function nextSysId() {
  return `sys_${++sysMsgCounter}`;
}

export function App({ config, connections, agent, debug }: AppProps) {
  const app = useApp();
  const store = useMemo(() => {
    const s = createUiStore();
    const mcpStr = connections.map(c => ({ name: c.name, toolCount: c.tools.length }));
    s.pushMessage({
      kind: 'banner',
      id: 'banner',
      data: { model: config.model.model, baseURL: config.model.baseURL, mcp: mcpStr },
    });
    return s;
  }, []);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const { send, abort } = useAgent(agent, store, {
    onConfirm: (c) => setPendingConfirm(c),
  });
  const log = useDebugLog(!!debug);

  const state = useSyncExternalStore(store.subscribe, store.getState);
  const { messages, thinking, inFlightText } = state;

  const [pendingImages, setPendingImages] = useState<UiImage[]>([]);

  const handleConfirm = useCallback(
    (approved: boolean) => {
      if (!pendingConfirm) return;
      agent.respondConfirm(pendingConfirm.requestId, approved);
      setPendingConfirm(null);
    },
    [agent, pendingConfirm]
  );

  const handleSubmit = useCallback(
    (text: string) => {
      log(`submit: ${text}`);
      if (isCommand(text)) {
        (async () => {
          const result = await executeCommand(text, {
            agent,
            connections,
            config,
            exit: () => app.exit(),
          });
          if (text === '/clear') {
            store.clearMessages();
          }
          if (result !== null) {
            store.pushMessage({ kind: 'system', id: nextSysId(), text: result });
          }
        })();
        return;
      }
      if (pendingImages.length > 0) {
        const content = [
          { type: 'text' as const, text },
          ...pendingImages.map((img) => ({
            type: 'image_url' as const,
            image_url: { url: imageToBase64DataUrl(img.path) },
          })),
        ];
        (send as any)(content);
        setPendingImages([]);
      } else {
        send(text);
      }
    },
    [agent, connections, app, store, send, log, pendingImages]
  );

  useInput((_input, key) => {
    if (key.escape && thinking) {
      log('abort via ESC');
      abort();
    }
  });

  const thinkingRef = useRef(thinking);
  thinkingRef.current = thinking;

  useEffect(() => {
    process.stdout.write('\x1b[?2004h');
    return () => {
      process.stdout.write('\x1b[?2004l');
    };
  }, []);

  useEffect(() => {
    const PASTE_START = '\x1b[200~';
    const PASTE_END = '\x1b[201~';

    let pasteBuffer = '';
    let isPasting = false;

    const tryReadClipboardImage = () => {
      if (thinkingRef.current) return;
      const imgPath = checkClipboardImage();
      if (imgPath) {
        const size = getImageSize(imgPath);
        setPendingImages((prev) => [...prev, { path: imgPath, size }]);
        log(`clipboard image: ${imgPath} (${size}B)`);
      } else {
        log('clipboard: no image');
      }
    };

    const handlePasteComplete = (content: string) => {
      log(`bracketed paste: ${content.length}B`);
      if (content.trim() === '' && process.platform === 'darwin') {
        tryReadClipboardImage();
      }
    };

    const onData = (data: Buffer) => {
      const str = data.toString();

      if (isPasting) {
        pasteBuffer += str;
        if (pasteBuffer.includes(PASTE_END)) {
          const content = pasteBuffer.split(PASTE_END)[0];
          handlePasteComplete(content);
          isPasting = false;
          pasteBuffer = '';
        }
        return;
      }

      if (str.includes(PASTE_START)) {
        isPasting = true;
        pasteBuffer = str.split(PASTE_START).slice(1).join('');
        if (pasteBuffer.includes(PASTE_END)) {
          const content = pasteBuffer.split(PASTE_END)[0];
          handlePasteComplete(content);
          isPasting = false;
          pasteBuffer = '';
        }
        return;
      }

      if (str === '\x16') {
        tryReadClipboardImage();
      }
      if (str === '\x18') {
        setPendingImages([]);
        log('cleared pending images');
      }
    };
    process.stdin.on('data', onData);
    return () => { process.stdin.off('data', onData); };
  }, [log]);

  const mcpList = connections.map((c) => ({
    name: c.name,
    toolCount: c.tools.length,
  }));

  const taskStack = agent.getTaskStack();
  const taskCount = taskStack.pending().length + (taskStack.current() ? 1 : 0);

  return (
    <Box flexDirection="column">
      <ChatHistory messages={messages} />

      {inFlightText ? (
        <Box marginTop={1}>
          <Text>{inFlightText.replace(/\n{3,}/g, '\n\n').trimStart()}</Text>
        </Box>
      ) : null}

      {thinking ? (
        <ThinkingBar event={thinking.event} startedAt={thinking.startedAt} thinking={thinking.isThinking} thoughtDurationMs={thinking.thoughtDurationMs} />
      ) : null}

      {pendingConfirm ? (
        <ConfirmDialog
          cmd={pendingConfirm.cmd}
          reason={pendingConfirm.reason}
          onConfirm={handleConfirm}
        />
      ) : null}

      <InputBox
        onSubmit={handleSubmit}
        disabled={!!thinking || !!pendingConfirm}
        pendingImages={pendingImages}
      />

      <StatusBar
        model={config.model.model}
        taskCount={taskCount}
        debug={debug}
        contextUsed={agent.getContextUsage().used}
        contextTotal={agent.getContextUsage().total}
      />
    </Box>
  );
}

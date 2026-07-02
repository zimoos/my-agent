import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { AgentConfig, McpConnection, Agent } from '../mcp/types.js';
import type { SessionStore } from '../session/store.js';
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
import {
  getSessionUserPreview,
  SessionPicker,
  selectProjectSessions,
  type SessionPickerSession,
} from './components/SessionPicker.js';
import { ModelPicker } from './components/ModelPicker.js';
import type { PendingConfirm } from './hooks/useAgent.js';
import { isCommand, executeCommand } from './utils/commands.js';
import {
  listModelChoices,
  saveDefaultModelChoice,
  type ModelChoice,
} from './utils/modelProfiles.js';

export interface AppProps {
  config: AgentConfig;
  connections: McpConnection[];
  agent: Agent;
  sessionStore: SessionStore;
  currentSessionId: string;
  debug?: boolean;
  onSwitchSession?: (sessionId: string) => void;
  onRestartSession?: (sessionId: string) => void;
}

let sysMsgCounter = 0;
function nextSysId() {
  return `sys_${++sysMsgCounter}`;
}

export function App({ config, connections, agent, sessionStore, currentSessionId, debug, onSwitchSession, onRestartSession }: AppProps) {
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
  const [sessionPickerSessions, setSessionPickerSessions] = useState<SessionPickerSession[] | null>(null);
  const [modelPickerModels, setModelPickerModels] = useState<ModelChoice[] | null>(null);

  const handleConfirm = useCallback(
    (approved: boolean) => {
      if (!pendingConfirm) return;
      agent.respondConfirm(pendingConfirm.requestId, approved);
      setPendingConfirm(null);
    },
    [agent, pendingConfirm]
  );

  const handleRevertLastTurn = useCallback(() => {
    const removed = agent.revertLastTurnContextOnly();
    if (removed <= 0) return false;
    const updatedUi = store.revertLastTurn();
    log(`reverted last turn context (${removed} messages), ui=${updatedUi}`);
    return true;
  }, [agent, store, log]);

  const openModelPicker = useCallback(async () => {
    try {
      store.pushMessage({ kind: 'system', id: nextSysId(), text: '[正在查询模型列表...]' });
      const choices = await listModelChoices(config);
      setModelPickerModels(choices);
    } catch (err) {
      store.pushMessage({
        kind: 'system',
        id: nextSysId(),
        text: `Failed to list models: ${(err as Error).message}`,
      });
    }
  }, [config, store]);

  const switchModelChoice = useCallback((model: ModelChoice) => {
    setModelPickerModels(null);
    saveDefaultModelChoice(model);
    store.pushMessage({
      kind: 'system',
      id: nextSysId(),
      text: `[已切换默认模型: ${model.label}，正在重启当前会话]`,
    });
    log(`switch model: ${model.id}`);
    onRestartSession?.(currentSessionId);
    app.exit();
  }, [app, currentSessionId, log, onRestartSession, store]);

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
            revertLastTurn: handleRevertLastTurn,
            openModelPicker,
            switchModelChoice,
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
    [agent, connections, app, store, send, log, pendingImages, handleRevertLastTurn, config, openModelPicker, switchModelChoice]
  );

  const openSessionPicker = useCallback(() => {
    const allSessions = sessionStore.list(50);
    const currentCwd = allSessions.find((session) => session.id === currentSessionId)?.cwd ?? process.cwd();
    const sessions = selectProjectSessions(allSessions, currentSessionId, currentCwd);
    const pickerSessions = sessions.map((session) => ({
      ...session,
      preview: getSessionUserPreview(sessionStore.load(session.id)),
    }));
    const otherSessions = pickerSessions.filter((session) => session.id !== currentSessionId);
    if (otherSessions.length === 0) {
      store.pushMessage({
        kind: 'system',
        id: nextSysId(),
        text: '[当前项目没有其他可切换的会话]',
      });
      return;
    }
    setSessionPickerSessions(pickerSessions);
  }, [currentSessionId, sessionStore, store]);

  const handleSelectSession = useCallback((sessionId: string) => {
    setSessionPickerSessions(null);
    if (sessionId === currentSessionId) {
      store.pushMessage({
        kind: 'system',
        id: nextSysId(),
        text: '[仍在当前会话]',
      });
      return;
    }
    log(`switch session: ${sessionId}`);
    onSwitchSession?.(sessionId);
    app.exit();
  }, [app, currentSessionId, log, onSwitchSession, store]);

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
  const contextUsage = agent.getContextUsage();

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

      {sessionPickerSessions ? (
        <SessionPicker
          sessions={sessionPickerSessions}
          currentSessionId={currentSessionId}
          onSelect={handleSelectSession}
          onCancel={() => setSessionPickerSessions(null)}
        />
      ) : null}

      {modelPickerModels ? (
        <ModelPicker
          models={modelPickerModels}
          onSelect={switchModelChoice}
          onCancel={() => setModelPickerModels(null)}
        />
      ) : null}

      <InputBox
        onSubmit={handleSubmit}
        disabled={!!thinking || !!pendingConfirm || !!sessionPickerSessions || !!modelPickerModels}
        pendingImages={pendingImages}
        onClearPendingImages={() => setPendingImages([])}
        onOpenSessionPicker={openSessionPicker}
      />

      <StatusBar
        model={config.model.model}
        taskCount={taskCount}
        debug={debug}
        contextUsed={contextUsage.used}
        contextTotal={contextUsage.total}
        contextThreshold={contextUsage.compactThreshold}
        contextSource={contextUsage.source}
      />
    </Box>
  );
}

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
import { MemoryConsole } from './components/MemoryConsole.js';
import type { AgoraMemoryPatch, AgoraMemoryProfile } from '../provider/agora.js';
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
  const providerState =
    agent.getProviderState?.() ??
    sessionStore.list(100).find((session) => session.id === currentSessionId)?.providerState ??
    null;
  const memoryController = agent.getMemoryController?.() ?? null;

  const [pendingImages, setPendingImages] = useState<UiImage[]>([]);
  const [sessionPickerSessions, setSessionPickerSessions] = useState<SessionPickerSession[] | null>(null);
  const [modelPickerModels, setModelPickerModels] = useState<ModelChoice[] | null>(null);
  const [memoryConsole, setMemoryConsole] = useState<{
    profiles: AgoraMemoryProfile[];
    patches: AgoraMemoryPatch[];
  } | null>(null);
  const [memoryActivity, setMemoryActivity] = useState('');
  const lastUserActivityRef = useRef(Date.now());
  const intakeInFlightRef = useRef(false);

  const refreshMemoryConsole = useCallback(async () => {
    if (!memoryController) throw new Error('Agora memory controller is unavailable');
    const [profiles, patches] = await Promise.all([
      memoryController.listProfiles(),
      memoryController.listPatches(true),
    ]);
    setMemoryConsole({ profiles, patches });
  }, [memoryController]);

  const openMemoryConsole = useCallback(async () => {
    try {
      await refreshMemoryConsole();
    } catch (err) {
      store.pushMessage({ kind: 'system', id: nextSysId(), text: `Memory error: ${(err as Error).message}` });
    }
  }, [refreshMemoryConsole, store]);

  const runMemoryIntake = useCallback(async (profileId: string) => {
    if (!memoryController || intakeInFlightRef.current) return;
    intakeInFlightRef.current = true;
    try {
      const submitted = await memoryController.startIntake({ profile_id: profileId });
      const jobId = String(submitted.job_id ?? submitted.job?.id ?? '');
      if (!jobId) throw new Error('Agora did not return an intake job id');
      setMemoryActivity(`queued · ${jobId}`);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const current = await memoryController.finalizeIntake(jobId, profileId);
        const status = String(current.status ?? current.job?.status ?? '');
        const stage = String(current.stage ?? current.job?.stage ?? status);
        setMemoryActivity(stage);
        if (status === 'failed') throw new Error(current.error?.message ?? current.job?.error ?? stage);
        if (status === 'completed' || current.outcome) {
          setMemoryActivity(current.outcome === 'review_required' ? 'review required' : current.outcome ?? 'completed');
          const nextState = agent.getProviderState?.();
          if (nextState) sessionStore.updateProviderState(currentSessionId, nextState);
          await refreshMemoryConsole().catch(() => undefined);
          break;
        }
      }
    } catch (err) {
      setMemoryActivity(`failed · ${(err as Error).message}`);
    } finally {
      intakeInFlightRef.current = false;
    }
  }, [agent, currentSessionId, memoryController, refreshMemoryConsole, sessionStore]);

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
      let choices = await listModelChoices(config);
      if (memoryController?.getCapabilities().modelCatalog) {
        const models = await memoryController.listModels();
        const liveChoices: ModelChoice[] = models
          .filter((item) => typeof item.id === 'string')
          .map((item) => ({
            id: `agora-local/${item.id}`,
            credentialId: 'agora-local',
            provider: 'agora',
            baseURL: 'mcp-stdio://agora',
            model: String(item.id),
            label: `Agora/${item.name ?? item.id}`,
            current: config.model.provider === 'agora' && config.model.model === item.id,
            source: 'remote',
            status: typeof item.status === 'string' ? item.status : undefined,
          }));
        const liveIds = new Set(liveChoices.map((item) => item.id));
        choices = [...liveChoices, ...choices.filter((item) => !liveIds.has(item.id))];
      }
      setModelPickerModels(choices);
    } catch (err) {
      store.pushMessage({
        kind: 'system',
        id: nextSysId(),
        text: `Failed to list models: ${(err as Error).message}`,
      });
    }
  }, [config, memoryController, store]);

  const switchModelChoice = useCallback(async (model: ModelChoice) => {
    if (model.provider === 'agora' && model.status && model.status !== 'available') {
      if (!memoryController?.getCapabilities().modelDownload) {
        store.pushMessage({ kind: 'system', id: nextSysId(), text: '[Agora runtime 不支持模型下载，请升级 Agora]' });
        return;
      }
      setMemoryActivity(`下载模型 ${model.model}`);
      try {
        await memoryController.downloadModel(model.model, (event) => {
          setMemoryActivity(`下载模型 ${model.model} · ${event.progress ?? '?'}${event.total ? `/${event.total}` : ''}`);
        });
        setMemoryActivity(`模型 ${model.model} 已下载`);
      } catch (err) {
        setMemoryActivity(`下载失败 · ${(err as Error).message}`);
        return;
      }
    }
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
  }, [app, currentSessionId, log, memoryController, onRestartSession, store]);

  const handleSubmit = useCallback(
    (text: string) => {
      lastUserActivityRef.current = Date.now();
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
            openMemoryConsole,
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
    [agent, connections, app, store, send, log, pendingImages, handleRevertLastTurn, config, openModelPicker, openMemoryConsole, switchModelChoice]
  );

  useEffect(() => {
    if (!memoryController || config.model.provider?.toLowerCase() !== 'agora') return;
    const timer = setInterval(async () => {
      if (intakeInFlightRef.current || thinkingRef.current || pendingConfirm || sessionPickerSessions || modelPickerModels || memoryConsole) return;
      const profileId = agent.getProviderState?.()?.memory?.profile_id;
      if (!profileId) return;
      try {
        const profiles = await memoryController.listProfiles();
        const profile = profiles.find((item) => item.id === profileId);
        const policy = profile?.auto_intake_policy;
        if (!profile || !profile.writable_patch_family || !policy?.enabled) return;
        const idleSeconds = policy.idle_seconds ?? 60;
        if (Date.now() - lastUserActivityRef.current < idleSeconds * 1000) return;
        const status = await memoryController.getIntakeStatus();
        if (status.active_job) return;
        const turnsReady = Number(status.pending_user_turns ?? 0) >= Number(policy.min_user_turns ?? 4);
        const tokensReady = Number(status.pending_tokens ?? 0) >= Number(policy.min_pending_tokens ?? 2000);
        if (!turnsReady && !tokensReady) return;
        void runMemoryIntake(profileId);
      } catch (err) {
        setMemoryActivity(`stale · ${(err as Error).message}`);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [agent, config.model.provider, memoryConsole, memoryController, modelPickerModels, pendingConfirm, runMemoryIntake, sessionPickerSessions]);

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

      {memoryConsole ? (
        <MemoryConsole
          project={process.cwd()}
          profiles={memoryConsole.profiles}
          patches={memoryConsole.patches}
          activeProfileId={providerState?.memory?.profile_id}
          activity={memoryActivity}
          onUse={(profileId) => {
            void memoryController?.selectProfile(profileId).then(() => {
              setMemoryActivity('已选择 · 下一次真实对话生效');
              return refreshMemoryConsole();
            });
          }}
          onApply={(profileId, patchIds, writableFamily) => {
            void memoryController?.applyPatchSelection(profileId, patchIds, writableFamily).then(() => {
              setMemoryActivity('Patch 已更新 · 下一次真实对话生效');
              return refreshMemoryConsole();
            });
          }}
          onCreate={(name) => {
            const profileId = `ma-${name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'memory'}-${Date.now().toString(36)}`;
            void memoryController?.createProfile({ profile_id: profileId, name }).then(() => refreshMemoryConsole());
          }}
          onRename={(profileId, name) => {
            void memoryController?.renameProfile(profileId, name).then(() => refreshMemoryConsole());
          }}
          onAuto={(profileId, enabled) => {
            void memoryController?.setAutoPolicy(profileId, enabled).then(() => refreshMemoryConsole());
          }}
          onInternalize={(profileId) => { void runMemoryIntake(profileId); }}
          onCancel={() => setMemoryConsole(null)}
        />
      ) : null}

      <InputBox
        onSubmit={handleSubmit}
        disabled={!!thinking || !!pendingConfirm || !!sessionPickerSessions || !!modelPickerModels || !!memoryConsole}
        pendingImages={pendingImages}
        onClearPendingImages={() => setPendingImages([])}
        onOpenSessionPicker={openSessionPicker}
      />

      <StatusBar
        model={config.model.model}
        provider={config.model.provider}
        providerState={providerState}
        taskCount={taskCount}
        debug={debug}
        contextUsed={contextUsage.used}
        contextTotal={contextUsage.total}
        contextThreshold={contextUsage.compactThreshold}
        contextSource={contextUsage.source}
        memoryActivity={memoryActivity}
      />
    </Box>
  );
}

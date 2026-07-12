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
import type {
  AgoraMemory,
  AgoraMemoryIntakeTarget,
  AgoraMemoryPatch,
  AgoraMemoryProfile,
} from '../provider/agora.js';
import { agoraProjectProfileId } from '../provider/agora.js';
import { classifyAgoraBatchTargets, planAgoraAutoIntake } from '../provider/agora-auto-intake.js';
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
  const persistedProviderState = sessionStore.list(100).find((session) => session.id === currentSessionId)?.providerState;
  const providerState = agent.getProviderState?.() ?? persistedProviderState ?? null;
  const memoryController = agent.getMemoryController?.() ?? null;

  const [pendingImages, setPendingImages] = useState<UiImage[]>([]);
  const [sessionPickerSessions, setSessionPickerSessions] = useState<SessionPickerSession[] | null>(null);
  const [modelPickerModels, setModelPickerModels] = useState<ModelChoice[] | null>(null);
  const [memoryConsole, setMemoryConsole] = useState<{
    memories: AgoraMemory[];
    profiles: AgoraMemoryProfile[];
    patches: AgoraMemoryPatch[];
  } | null>(null);
  const [memoryActivity, setMemoryActivity] = useState('');
  const activeMemoryProfile = memoryConsole?.profiles.find(
    (profile) => profile.id === providerState?.memory?.profile_id
  );
  const memoryProfileId = activeMemoryProfile?.id ?? agoraProjectProfileId(process.cwd());
  const lastUserActivityRef = useRef(Date.now());
  const intakeInFlightRef = useRef(false);

  const refreshMemoryConsole = useCallback(async () => {
    if (!memoryController) throw new Error('Agora memory controller is unavailable');
    const capabilities = memoryController.getCapabilities();
    if (!capabilities.memoryV2) {
      throw new Error(`Agora Memory v2 不可用（当前模式: ${capabilities.runtimeMode}），基础对话仍可使用。`);
    }
    const [memories, profiles, patches] = await Promise.all([
      memoryController.listMemories(),
      memoryController.listProfiles(),
      memoryController.listPatches(true),
    ]);
    setMemoryConsole({ memories, profiles, patches });
  }, [memoryController]);

  const openMemoryConsole = useCallback(async () => {
    try {
      await refreshMemoryConsole();
    } catch (err) {
      store.pushMessage({ kind: 'system', id: nextSysId(), text: `Memory error: ${(err as Error).message}` });
    }
  }, [refreshMemoryConsole, store]);

  const persistMemoryRuntimeState = useCallback((memoryPatch: Record<string, unknown>) => {
    memoryController?.updateLocalMemoryState(memoryPatch);
    const existing = agent.getProviderState?.() ??
      sessionStore.list(100).find((session) => session.id === currentSessionId)?.providerState ??
      { provider_id: 'agora' };
    sessionStore.updateProviderState(currentSessionId, {
      ...existing,
      memory: { ...(existing.memory ?? {}), ...memoryPatch },
    });
  }, [agent, currentSessionId, memoryController, sessionStore]);

  const monitorMemoryBatch = useCallback(async (
    batchId: string,
    profileId: string,
    runtimeSourceEnd: number,
    localSourceEnd: number,
    selectedPatchIds: string[],
    automatic: boolean
  ) => {
    if (!memoryController || intakeInFlightRef.current) return;
    intakeInFlightRef.current = true;
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const batch = await memoryController.getBatchIntake(batchId);
        const classified = classifyAgoraBatchTargets(batch.targets);
        const done = classified.completed.length;
        setMemoryActivity(`内化中 ${done}/${batch.targets.length}`);
        persistMemoryRuntimeState({
          active_batch: { batch_id: batchId, profile_id: profileId, source_end: runtimeSourceEnd, local_source_end: localSourceEnd, selected_patch_ids: selectedPatchIds, automatic, targets: batch.targets },
        });
        if (!classified.terminal) continue;

        const blockers = classified.blockers;
        const profiles = await memoryController.listProfiles();
        const currentProfile = profiles.find((profile) => profile.id === profileId);
        const selectionUnchanged = Boolean(currentProfile) &&
          selectedPatchIds.length === currentProfile?.active_memory_patch_ids.length &&
          selectedPatchIds.every((id, index) => id === currentProfile?.active_memory_patch_ids[index]);
        if (selectionUnchanged) await memoryController.applyCompletedBatch(batch, profileId);
        if (blockers.length === 0) {
          persistMemoryRuntimeState({
            active_batch: undefined,
            ...(automatic ? {
              last_auto_intake_message_end: localSourceEnd,
              last_auto_intake_runtime_message_end: runtimeSourceEnd,
            } : {}),
          });
          setMemoryActivity(`内化完成 ${done}/${batch.targets.length}${selectionUnchanged ? ' · 下一次对话验证挂载' : ' · 当前组合已变化，未自动覆盖'}`);
        } else {
          persistMemoryRuntimeState({
            active_batch: { batch_id: batchId, profile_id: profileId, source_end: runtimeSourceEnd, local_source_end: localSourceEnd, selected_patch_ids: selectedPatchIds, automatic, targets: batch.targets },
          });
          setMemoryActivity(`待处理 ${blockers.length}/${batch.targets.length} · 成功目标不会重复内化`);
        }
        await refreshMemoryConsole().catch(() => undefined);
        break;
      }
    } catch (err) {
      setMemoryActivity(`failed · ${(err as Error).message}`);
    } finally {
      intakeInFlightRef.current = false;
    }
  }, [memoryController, persistMemoryRuntimeState, refreshMemoryConsole]);

  const startMemoryBatch = useCallback(async (
    targets: AgoraMemoryIntakeTarget[],
    profileId: string,
    automatic = false,
    sourceStart?: number,
    sourceEnd?: number,
    localSourceEnd?: number
  ) => {
    if (!memoryController || intakeInFlightRef.current) throw new Error('已有内化任务正在执行。');
    const profiles = await memoryController.listProfiles();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error('当前项目尚未建立 Memory 组合。');
    const localEnd = localSourceEnd ?? sessionStore.load(currentSessionId).length;
    const persisted = sessionStore.list(100).find((session) => session.id === currentSessionId)?.providerState;
    const end = sourceEnd ?? Number(
      agent.getProviderState?.()?.memory?.runtime_message_count ??
      persisted?.memory?.runtime_message_count ??
      0
    );
    if (!Number.isInteger(end) || end <= 0) throw new Error('Agora runtime 尚未确认可内化的 source range；请先完成一次对话。');
    const batch = await memoryController.startBatchIntake({
      targets,
      ...(Number.isInteger(sourceStart) ? { source_message_start: sourceStart } : {}),
      ...(Number.isInteger(end) && end > 0 ? { source_message_end: end } : {}),
    });
    setMemoryActivity(`内化已提交 0/${batch.targets.length}`);
    persistMemoryRuntimeState({
      active_batch: {
        batch_id: batch.batch_id,
        profile_id: profileId,
        source_start: sourceStart ?? 0,
        source_end: end,
        local_source_end: localEnd,
        selected_patch_ids: profile.active_memory_patch_ids,
        automatic,
        targets: batch.targets,
      },
    });
    void monitorMemoryBatch(batch.batch_id, profileId, end, localEnd, [...profile.active_memory_patch_ids], automatic);
  }, [agent, currentSessionId, memoryController, monitorMemoryBatch, persistMemoryRuntimeState, sessionStore]);

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
            startMemoryIntake: (targets) => startMemoryBatch(targets, memoryProfileId),
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
    [agent, connections, app, store, send, log, pendingImages, handleRevertLastTurn, config, memoryProfileId, openModelPicker, openMemoryConsole, startMemoryBatch, switchModelChoice]
  );

  useEffect(() => {
    if (!memoryController || config.model.provider?.toLowerCase() !== 'agora') return;
    const timer = setInterval(async () => {
      if (intakeInFlightRef.current || thinkingRef.current || pendingConfirm || sessionPickerSessions || modelPickerModels || memoryConsole) return;
      if (!memoryController.getCapabilities().memoryV2) return;
      const persistedState = sessionStore.list(100).find((session) => session.id === currentSessionId)?.providerState;
      const runtimeState = persistedState ?? agent.getProviderState?.();
      const activeBatch = runtimeState?.memory?.active_batch as Record<string, any> | undefined;
      if (activeBatch?.batch_id) {
        const targets = Array.isArray(activeBatch.targets) ? activeBatch.targets : [];
        const unresolved = targets.some((target: any) => !['completed', 'noop', 'review', 'conflict', 'failed'].includes(String(target?.status)));
        if (unresolved) {
          void monitorMemoryBatch(
            String(activeBatch.batch_id),
            String(activeBatch.profile_id),
            Number(activeBatch.source_end ?? 0),
            Number(activeBatch.local_source_end ?? 0),
            Array.isArray(activeBatch.selected_patch_ids) ? activeBatch.selected_patch_ids.map(String) : [],
            Boolean(activeBatch.automatic)
          );
        }
        return;
      }
      const profileId = runtimeState?.memory?.profile_id;
      if (!profileId) return;
      try {
        const profiles = await memoryController.listProfiles();
        const profile = profiles.find((item) => item.id === profileId);
        const policy = profile?.auto_intake_policy;
        const targetIds = profile?.auto_intake_target_memory_ids ?? [];
        if (!profile || !policy?.enabled || targetIds.length === 0) return;
        const idleSeconds = policy.idle_seconds ?? 60;
        if (Date.now() - lastUserActivityRef.current < idleSeconds * 1000) return;
        const messages = sessionStore.load(currentSessionId);
        const [memories, patches] = await Promise.all([
          memoryController.listMemories(),
          memoryController.listPatches(true),
        ]);
        const plan = planAgoraAutoIntake({
          messages,
          checkpointEnd: Number(runtimeState?.memory?.last_auto_intake_message_end ?? 0),
          profile,
          memories,
          patches,
        });
        if (!plan.ready) return;
        const runtimeEnd = Number(runtimeState?.memory?.runtime_message_count ?? 0);
        const runtimeStart = Number(runtimeState?.memory?.last_auto_intake_runtime_message_end ?? 0);
        if (runtimeStart > 0 && runtimeStart >= runtimeEnd) {
          setMemoryActivity('自动内化已暂停 · Agora source 窗口发生回退，请手动确认新范围，未重复内化');
          return;
        }
        if (runtimeEnd <= runtimeStart) return;
        await startMemoryBatch(plan.targets, profileId, true, runtimeStart, runtimeEnd, plan.sourceEnd);
      } catch (err) {
        setMemoryActivity(`stale · ${(err as Error).message}`);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [agent, config.model.provider, currentSessionId, memoryConsole, memoryController, modelPickerModels, monitorMemoryBatch, pendingConfirm, sessionPickerSessions, sessionStore, startMemoryBatch]);

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
          memories={memoryConsole.memories}
          patches={memoryConsole.patches}
          profile={activeMemoryProfile}
          verifiedPatchIds={providerState?.memory?.active_memory_patch_ids}
          verificationStatus={providerState?.memory?.status}
          activity={memoryActivity}
          activeBatch={persistedProviderState?.memory?.active_batch as Record<string, any> | undefined}
          sourceRange={{ start: 0, end: Number(providerState?.memory?.runtime_message_count ?? 0) }}
          busy={Boolean(thinking || pendingConfirm)}
          onApply={async (memoryIds) => {
            if (!memoryController) throw new Error('Agora Memory controller unavailable');
            await memoryController.mountMemories(memoryProfileId, memoryIds, 'project');
            setMemoryActivity('记忆组合已更新 · 下一次真实对话验证 · 基座无需重载');
            await refreshMemoryConsole();
          }}
          onCreate={async (name) => {
            if (!memoryController) throw new Error('Agora Memory controller unavailable');
            await memoryController.createMemory(name);
            await refreshMemoryConsole();
          }}
          onRename={async (memoryId, name) => {
            if (!memoryController) throw new Error('Agora Memory controller unavailable');
            await memoryController.renameMemory(memoryId, name);
            await refreshMemoryConsole();
          }}
          onAuto={async (enabled, targetIds) => {
            if (!memoryController) throw new Error('Agora Memory controller unavailable');
            if (!activeMemoryProfile) {
              await memoryController.mountMemories(memoryProfileId, [], 'project');
            }
            if (enabled && targetIds.length === 0) throw new Error('开启自动内化前请先用 a 选择至少一个目标。');
            await memoryController.setAutoPolicy(memoryProfileId, enabled, targetIds);
            setMemoryActivity(enabled ? `自动内化已开启 · ${targetIds.length} 个目标` : '自动内化已关闭');
            await refreshMemoryConsole();
          }}
          onInternalize={async (targets) => {
            await startMemoryBatch(targets, memoryProfileId);
          }}
          onRollback={async (memory, targetPatchId) => {
            if (!memoryController || !memory.head_patch_id) throw new Error('Memory 没有可回滚的当前版本。');
            await memoryController.rollbackMemory(memory.id, memory.head_patch_id, targetPatchId);
            setMemoryActivity('Memory head 已回滚 · 当前会话挂载未被自动覆盖');
            await refreshMemoryConsole();
          }}
          onRetryBlocked={async () => {
            if (!memoryController) throw new Error('Agora Memory controller unavailable');
            const active = persistedProviderState?.memory?.active_batch as Record<string, any> | undefined;
            const rawTargets = Array.isArray(active?.targets) ? active.targets : [];
            const retryable = rawTargets.filter((target: any) =>
              ['review', 'conflict'].includes(String(target?.status)) ||
              (target?.status === 'failed' && target?.error?.retryable !== false)
            );
            if (retryable.length === 0) throw new Error('没有可重试的失败目标。');
            const targets: AgoraMemoryIntakeTarget[] = [];
            for (const target of retryable) {
              if (target.mode === 'create') {
                targets.push({
                  mode: 'create',
                  name: String(target.memory_name ?? target.name ?? ''),
                  memory_id: typeof target.memory_id === 'string' ? target.memory_id : undefined,
                  output_name: String(target.output_name),
                });
              } else {
                const memory = await memoryController.getMemory(String(target.memory_id));
                targets.push({
                  mode: 'increment',
                  memory_id: memory.id,
                  expected_parent_patch_id: memory.head_patch_id ?? null,
                  output_name: String(target.output_name),
                });
              }
            }
            await startMemoryBatch(
              targets,
              String(active?.profile_id ?? memoryProfileId),
              Boolean(active?.automatic),
              Number(active?.source_start ?? 0),
              Number(active?.source_end ?? 0),
              Number(active?.local_source_end ?? sessionStore.load(currentSessionId).length)
            );
          }}
          onAbandonBlocked={async () => {
            const active = persistedProviderState?.memory?.active_batch as Record<string, any> | undefined;
            if (!active) throw new Error('没有待处理的内化目标。');
            persistMemoryRuntimeState({
              active_batch: undefined,
              ...(active.automatic ? {
                last_auto_intake_message_end: Number(active.local_source_end ?? 0),
                last_auto_intake_runtime_message_end: Number(active.source_end ?? 0),
              } : {}),
            });
            setMemoryActivity('未完成目标已明确放弃；成功目标保留，自动 checkpoint 已按本轮范围推进');
            await refreshMemoryConsole();
          }}
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
        animateMemory={!thinking && !pendingConfirm}
      />
    </Box>
  );
}

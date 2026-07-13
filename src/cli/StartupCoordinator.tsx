import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import type { BootstrapPreparation, BootstrapResult } from '../index.js';
import { hydrateBootstrap, shutdown } from '../index.js';
import type { AppProps } from './App.js';
import { InputBox } from './components/InputBox.js';
import { ModelPicker } from './components/ModelPicker.js';
import { listModelChoices, saveDefaultModelChoice, type ModelChoice } from './utils/modelProfiles.js';

export interface StartupCoordinatorProps {
  prepared: BootstrapPreparation;
  debug?: boolean;
  onReady?: (boot: BootstrapResult) => void;
  onSwitchSession?: (sessionId: string) => void;
  onRestartSession?: (sessionId: string) => void;
}

type StartupState =
  | { status: 'connecting'; attempt: number }
  | { status: 'failed'; attempt: number; error: string }
  | { status: 'ready'; attempt: number; boot: BootstrapResult; AppComponent: React.ComponentType<AppProps> };

export function StartupCoordinator({
  prepared,
  debug,
  onReady,
  onSwitchSession,
  onRestartSession,
}: StartupCoordinatorProps) {
  const app = useApp();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<StartupState>({ status: 'connecting', attempt: 0 });
  const [queuedPrompt, setQueuedPrompt] = useState('');
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [modelChoices, setModelChoices] = useState<ModelChoice[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'connecting', attempt });
    void Promise.allSettled([
      hydrateBootstrap(prepared),
      import('./App.js').then((module) => module.App),
    ]).then(async ([bootResult, componentResult]) => {
      if (bootResult.status === 'rejected') {
        if (!cancelled) {
          setState({ status: 'failed', attempt, error: bootResult.reason instanceof Error ? bootResult.reason.message : String(bootResult.reason) });
        }
        return;
      }
      const boot = bootResult.value;
      if (componentResult.status === 'rejected') {
        await shutdown(boot.connections, boot.agent);
        if (!cancelled) {
          setState({ status: 'failed', attempt, error: componentResult.reason instanceof Error ? componentResult.reason.message : String(componentResult.reason) });
        }
        return;
      }
      if (cancelled) {
        void shutdown(boot.connections, boot.agent);
        return;
      }
      setState({ status: 'ready', attempt, boot, AppComponent: componentResult.value });
      onReady?.(boot);
    });
    return () => {
      cancelled = true;
      // Once ready, the outer CLI lifecycle owns shutdown. Before hand-off,
      // the settled branch above closes any runtime that completed late.
    };
  // `prepared` is immutable for one outer session lifecycle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, prepared]);

  const submitDuringStartup = useCallback((text: string) => {
    if (text === '/retry') {
      setNotice('正在重新连接 runtime…');
      setAttempt((value) => value + 1);
      return;
    }
    if (text === '/quit') {
      app.exit();
      return;
    }
    if (text === '/model') {
      void listModelChoices(prepared.config)
        .then(setModelChoices)
        .catch((error) => setNotice(`模型列表失败: ${(error as Error).message}`));
      return;
    }
    if (!queuedPrompt) {
      setQueuedPrompt(text);
      setNotice('首条消息已安全排队，runtime ready 后自动发送。');
    } else {
      setDraft(text);
      setNotice('仅排队一条消息；新输入已保留为草稿。');
    }
  }, [app, prepared.config, queuedPrompt]);

  if (state.status === 'ready') {
    const ReadyApp = state.AppComponent;
    return (
      <ReadyApp
        config={state.boot.config}
        connections={state.boot.connections}
        agent={state.boot.agent}
        sessionStore={prepared.sessionStore}
        currentSessionId={state.boot.sessionId}
        debug={debug}
        onSwitchSession={onSwitchSession}
        onRestartSession={onRestartSession}
        initialPrompt={queuedPrompt || undefined}
        initialDraft={draft || undefined}
        startupStatus={state.boot.connectionFailures.length > 0
          ? `degraded · MCP failed: ${state.boot.connectionFailures.map((failure) => `${failure.name}: ${failure.error.replace(/\s+/g, ' ').slice(0, 120)}`).join('；')}`
          : 'ready'}
      />
    );
  }

  const contextWindow = prepared.config.model.contextWindow ?? 0;
  const failure = state.status === 'failed' ? state.error : '';
  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text bold color="magenta">MA</Text>
        <Text dimColor> · 可输入 · runtime {state.status === 'connecting' ? '连接中' : '连接失败'}</Text>
      </Box>
      <InputBox
        onSubmit={submitDuringStartup}
        initialValue={draft}
        onValueChange={setDraft}
      />
      {notice ? <Text color="cyan">  {notice}</Text> : null}
      {queuedPrompt ? <Text dimColor>  已排队: {queuedPrompt.slice(0, 100)}</Text> : null}
      {failure ? (
        <Box flexDirection="column" paddingX={1}>
          <Text color="red">启动失败: {failure}</Text>
          <Text dimColor>/retry 重试 · /model 切换 Provider/模型 · /quit 退出；草稿不会丢失</Text>
        </Box>
      ) : null}
      <Text dimColor>
        {'  '}Provider: {prepared.config.model.provider ?? 'openai'} · Model: {prepared.config.model.model}
        {contextWindow > 0 ? ` · win ${Math.round(contextWindow / 1000)}k` : ''}
      </Text>
      <Text dimColor>
        {'  '}{prepared.resumed ? '恢复' : '新建'} session {prepared.sessionId}
        {prepared.createdDefault ? ' · 已创建 ~/.my-agent/config.json' : ''}
      </Text>
      <Text dimColor>{'  '}runtime 启动在后台进行 · 模型权重仅在首次对话加载</Text>
      {modelChoices ? (
        <ModelPicker
          models={modelChoices}
          onCancel={() => setModelChoices(null)}
          onSelect={(choice) => {
            saveDefaultModelChoice(choice);
            onRestartSession?.(prepared.sessionId);
            app.exit();
          }}
        />
      ) : null}
    </Box>
  );
}

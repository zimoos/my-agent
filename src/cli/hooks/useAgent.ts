import { useCallback, useRef } from 'react';
import type { Agent, ChatContent } from '../../mcp/types.js';
import type { AgentEvent } from '../../agent/events.js';
import type { UiStore } from '../state/store.js';
import { makeToolResultPreview, parseToolResultDiff } from '../diff-parser.js';

function extractToolPath(_name: string, args: Record<string, any>): string | undefined {
  const path = args.path || args.file_path || args.filePath || args.dir_path || args.directory;
  if (typeof path !== 'string' || !path.trim()) return undefined;
  const p = path.trim();
  if (p.length <= 60) return p;
  const parts = p.split('/');
  return '…/' + parts.slice(-2).join('/');
}

function seconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

function progressLabel(message: string, progress?: number, total?: number): string {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return message;
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
    return `${message} · ${Math.round((progress / total) * 100)}%`;
  }
  return message;
}

export interface PendingConfirm {
  requestId: string;
  cmd: string;
  reason: string;
}

export interface UseAgentOptions {
  onConfirm?: (c: PendingConfirm) => void;
}

let msgCounter = 0;
function nextId() {
  return `m_${++msgCounter}`;
}

export function applyAgentEvent(
  store: UiStore,
  event: AgentEvent,
  opts: UseAgentOptions
) {
  switch (event.type) {
    case 'task:start':
      store.updateThinking({ event: event.prompt.slice(0, 60) || '执行任务' });
      break;
    case 'tool:confirm':
      store.updateThinking({ event: '等待用户确认' });
      opts.onConfirm?.({
        requestId: event.requestId,
        cmd: event.cmd,
        reason: event.reason,
      });
      break;
    case 'compact:done':
      store.pushMessage({
        kind: 'system',
        id: nextId(),
        text: `[compact] freed ~${event.freed} tokens`,
      });
      break;
    case 'provider:attempt':
      store.updateThinking({
        event: event.attempt <= 1
          ? `等待模型响应 · ${seconds(event.timeoutMs)}s 超时`
          : `等待模型响应（重试 ${event.attempt - 1}/${Math.max(1, event.maxAttempts - 1)}）· ${seconds(event.timeoutMs)}s 超时`,
      });
      break;
    case 'provider:retry':
      store.pushMessage({
        kind: 'system',
        id: nextId(),
        text: `[provider] 第 ${event.attempt}/${event.maxRetries} 次重试将在 ${seconds(event.delayMs)}s 后开始：${event.error}`,
      });
      store.updateThinking({
        event: `准备重试 ${event.attempt}/${event.maxRetries}`,
      });
      break;
    case 'provider:progress':
      store.updateThinking({
        event: progressLabel(event.message, event.progress, event.total),
        isThinking: false,
        thoughtDurationMs: null,
      });
      break;
    case 'progress': {
      const pending = store.flushInFlight();
      if (pending.trim()) {
        store.pushMessage({ kind: 'assistant', id: nextId(), markdown: pending, elapsedMs: 0 });
      }
      store.pushMessage({
        kind: 'system',
        id: nextId(),
        text: `[progress] ${event.message}`,
      });
      store.updateThinking({ event: '继续执行中' });
      break;
    }
    case 'context:usage':
      break;
    case 'tool:call':
      store.updateThinking({
        event: `调用 ${event.name.replace('__', ' → ')}`,
        toolName: event.name.replace('__', ' → '),
        toolPath: extractToolPath(event.name, event.args),
      });
      break;
    case 'tool:result': {
      // Flush accumulated text BEFORE tool message to maintain chronological order
      const pending = store.flushInFlight();
      if (pending.trim()) {
        store.pushMessage({ kind: 'assistant', id: nextId(), markdown: pending, elapsedMs: 0 });
      }
      const thinking = store.getState().thinking;
      const toolName = thinking?.toolName || '';
      if (event.ok && toolName === 'enter_plan_mode') {
        store.updateThinking({ event: '等待方案确认' });
        break;
      }
      const preview = makeToolResultPreview(event.content);
      const diffData = event.ok
        ? event.artifact ?? parseToolResultDiff(event.content)
        : undefined;

      store.pushMessage({
        kind: 'tool',
        id: nextId(),
        name: toolName,
        ok: event.ok,
        preview: preview || (event.ok ? '完成' : '失败'),
        path: thinking?.toolPath,
        diff: diffData,
      });
      store.updateThinking({ event: event.ok ? '分析结果中' : '处理错误中' });
      break;
    }
    case 'workspace:diff':
      store.pushMessage({
        kind: 'workspace-diff',
        id: nextId(),
        files: event.artifact.files,
        summary: event.artifact.summary,
        truncated: event.artifact.truncated,
      });
      break;
    case 'plan': {
      const pending = store.flushInFlight();
      if (pending.trim()) {
        store.pushMessage({ kind: 'assistant', id: nextId(), markdown: pending, elapsedMs: 0 });
      }
      if (event.content.trim()) {
        store.pushMessage({
          kind: 'assistant',
          id: nextId(),
          markdown: event.content,
          elapsedMs: 0,
        });
      }
      store.updateThinking({ event: '等待方案确认' });
      break;
    }
    case 'token':
      store.appendToken(event.text);
      break;
    case 'text':
      store.appendToken(event.content);
      break;
    case 'task:done': {
      const md = store.flushInFlight();
      const elapsed = store.getState().thinking;
      const ms = elapsed ? Date.now() - elapsed.startedAt : 0;
      if (md.trim()) {
        store.pushMessage({
          kind: 'assistant',
          id: nextId(),
          markdown: md,
          elapsedMs: ms,
        });
      }
      const secs = Math.floor(ms / 1000);
      store.pushMessage({
        kind: 'separator',
        id: nextId(),
        elapsed: `${secs}s`,
      });
      break;
    }
    case 'task:failed': {
      const md = store.flushInFlight();
      if (md.trim()) {
        store.pushMessage({
          kind: 'assistant',
          id: nextId(),
          markdown: md,
          elapsedMs: 0,
        });
      }
      store.pushMessage({
        kind: 'system',
        id: nextId(),
        text: `[error] ${event.error}`,
      });
      store.pushMessage({ kind: 'separator', id: nextId(), elapsed: '0s' });
      break;
    }
    case 'task:aborted':
    case 'aborted':
      store.flushInFlight();
      store.pushMessage({ kind: 'system', id: nextId(), text: '[中断]' });
      break;
    case 'warning':
      store.pushMessage({ kind: 'system', id: nextId(), text: `[警告] ${event.message}` });
      break;
    case 'thinking:start':
      store.updateThinking({ event: store.getState().thinking?.event || '思考中', isThinking: true });
      break;
    case 'thinking:end':
      store.updateThinking({ isThinking: false, thoughtDurationMs: event.durationMs });
      break;
  }
}

export function useAgent(
  agent: Agent,
  store: UiStore,
  options: UseAgentOptions = {}
) {
  const abortRef = useRef<AbortController | null>(null);
  const optsRef = useRef<UseAgentOptions>(options);
  optsRef.current = options;

  const send = useCallback(
    async (content: ChatContent) => {
      const displayText =
        typeof content === 'string'
          ? content
          : (content.find((p) => p.type === 'text') as
              | { type: 'text'; text: string }
              | undefined)?.text || '[图片]';
      abortRef.current = new AbortController();
      store.pushMessage({ kind: 'user', id: nextId(), text: displayText });
      store.startThinking();

      try {
        for await (const event of agent.chat(content, abortRef.current.signal)) {
          applyAgentEvent(store, event, optsRef.current);
          if (abortRef.current.signal.aborted) break;
        }
      } catch (err: any) {
        if (err.name !== 'AbortError' && !abortRef.current?.signal.aborted) {
          store.pushMessage({
            kind: 'system',
            id: nextId(),
            text: `[error] ${err.message}`,
          });
        }
      } finally {
        store.stopThinking();
        abortRef.current = null;
      }
    },
    [agent, store]
  );

  const abort = useCallback(() => abortRef.current?.abort(), []);

  return { send, abort };
}

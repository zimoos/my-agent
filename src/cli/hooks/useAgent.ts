import { useCallback, useRef } from 'react';
import type { Agent, ChatContent } from '../../mcp/types.js';
import type { AgentEvent } from '../../agent/events.js';
import type { UiStore } from '../state/store.js';

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

function applyEvent(
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
    case 'tool:call':
      store.updateThinking({
        event: `调用 ${event.name.replace('__', ' → ')}`,
        toolName: event.name.replace('__', ' → '),
      });
      break;
    case 'tool:result': {
      // Flush accumulated text BEFORE tool message to maintain chronological order
      const pending = store.flushInFlight();
      if (pending.trim()) {
        store.pushMessage({ kind: 'assistant', id: nextId(), markdown: pending, elapsedMs: 0 });
      }
      const preview = event.content
        .replace(/<[^>]*>/g, '')
        .trim()
        .split('\n')[0]
        .slice(0, 50);
      
      // 解析 diff 信息
      let diffData: import('../state/types.js').DiffData | undefined;
      if (event.ok) {
        const diffMatch = event.content.match(/--- Diff ---\s*\n([\s\S]*)$/);
        if (diffMatch) {
          const diffText = diffMatch[1];
          // 解析文件路径
          const fileMatch = event.content.match(/(?:已编辑|已覆盖|已写入)\s+(.+?)[（\(]/);
          const filePath = fileMatch ? fileMatch[1].trim() : '';
          // 解析统计信息
          const addedMatch = diffText.match(/\+(\d+)/);
          const removedMatch = diffText.match(/-(\d+)/);
          const addedLines = addedMatch ? parseInt(addedMatch[1], 10) : 0;
          const removedLines = removedMatch ? parseInt(removedMatch[1], 10) : 0;
          
          diffData = {
            filePath,
            addedLines,
            removedLines,
            diffText,
            truncated: diffText.includes('collapsed') || diffText.includes('truncated'),
          };
        }
      }
      
      store.pushMessage({
        kind: 'tool',
        id: nextId(),
        name: store.getState().thinking?.toolName || '',
        ok: event.ok,
        preview: preview || (event.ok ? '完成' : '失败'),
        diff: diffData,
      });
      store.updateThinking({ event: event.ok ? '分析结果中' : '处理错误中' });
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
          applyEvent(store, event, optsRef.current);
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

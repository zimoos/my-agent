import { randomUUID } from 'node:crypto';
import type { BootstrapPreparation } from '../index.js';
import type { Agent, AgentEvent, ChatContent, McpConnection } from '../mcp/types.js';
import { createTaskStack } from '../task-stack.js';
import type { SessionPoolEntry } from '../agent/context-manager.js';
import { openMaSession } from './ma-session.js';
import { createLocalSessionEnvironment } from './local-session.js';
import type { RuntimeEvent } from './public-types.js';
import type { TurnScope } from './contracts.js';
import { publicRuntimeError } from './errors.js';

/** Legacy UI shape only. It delegates each user Turn once; Pi owns every model/tool iteration. */
export async function createMaAgentCompatibility(prepared: BootstrapPreparation, connections: McpConnection[]): Promise<Agent> {
  const stack = createTaskStack();
  let current: TurnScope | undefined;
  let pushEvent: ((event: AgentEvent) => void) | undefined;
  const taskEntries = new Map<string, Set<string>>();
  const confirmations = new Map<string, (approved: boolean) => void>();
  const local = await createLocalSessionEnvironment(prepared, connections, async (request, reason, signal) => {
    if (!process.stdin.isTTY && prepared.confirmationChannel !== 'host') return false;
    const requestId = randomUUID();
    return new Promise<boolean>(resolve => {
      const finish = (approved: boolean) => { confirmations.delete(requestId); signal?.removeEventListener('abort', abort); resolve(approved); };
      const abort = () => finish(false);
      confirmations.set(requestId, finish); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { finish(false); return; }
      pushEvent?.({ type: 'tool:confirm', requestId, reason,
        cmd: String(request.args.command ?? request.args.cmd ?? request.source.toolName) });
    });
  });
  let session;
  try { session = await openMaSession({ bootstrap: local.bootstrap, host: local.host, providerRuntime: local.runtime, connections }); }
  catch (error) { await local.runtime.close?.(); throw error; }
  let usedTokens = 0;
  let pendingContext: Promise<unknown> = Promise.resolve();
  const contextEdit = (input: Parameters<typeof session.editContext>[0]) => {
    if (current) throw new Error('MA_SESSION_BUSY');
    pendingContext = pendingContext.then(() => session.editContext(input));
    void pendingContext.catch(() => {});
  };
  const toEvents = (event: RuntimeEvent): AgentEvent[] => {
    switch (event.kind) {
      case 'assistant.delta': return typeof event.payload.text === 'string' ? [{ type: 'token', text: event.payload.text }] : [];
      case 'tool.started': return [{ type: 'tool:call', name: String(event.payload.name), args: {} }];
      case 'tool.completed': {
        const content = event.payload.content as Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
        return [{ type: 'tool:result', ok: event.payload.status === 'succeeded',
          content: Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '',
          ...(Array.isArray(content) ? { contentBlocks: content } : {}) }];
      }
      case 'usage.recorded': {
        const usage = event.payload.usage as { prompt_tokens?: number } | null;
        if (typeof usage?.prompt_tokens === 'number') usedTokens = usage.prompt_tokens;
        return [{ type: 'context:usage', used: usedTokens, total: local.bootstrap.capability.contextWindow,
          compactThreshold: Math.floor(local.bootstrap.capability.contextWindow * 0.8), source: 'pi/provider-usage' }];
      }
      case 'context.compacting': return [{ type: 'progress', message: '正在通过当前模型整理上下文…' }];
      case 'context.compacted': return [{ type: 'progress', message: '上下文整理操作已结束。' }];
      default: return [];
    }
  };
  session.subscribe(event => { for (const projected of toEvents(event)) pushEvent?.(projected); });
  const pool = (all = false): SessionPoolEntry[] => session.inspectHistory({ all }).flatMap((entry, i) => {
    if (entry.type !== 'message' && entry.type !== 'custom_message') return [];
    const message = (entry.type === 'custom_message' ? { role: 'user', content: entry.content, timestamp: Date.parse(String(entry.timestamp)) } : entry.message) as { role: string; content: unknown; timestamp?: number };
    const role = message.role === 'toolResult' ? 'tool' : message.role === 'user' || message.role === 'assistant' ? message.role : 'system';
    return [{ id: String(entry.id), i, sessionId: session.sessionId, createdAt: message.timestamp ?? 0, role,
      text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content), keywords: [] }];
  });
  return {
    async *chat(userMessage: ChatContent, signal, _options) {
      if (current) throw new Error('MA_SESSION_BUSY');
      if (_options?.reasoningDepth === 'deep') throw new Error('Choose an explicitly configured reasoning profile before starting a new MA session.');
      await pendingContext;
      if (current) throw new Error('MA_SESSION_BUSY');
      const parts = typeof userMessage === 'string' ? [{ type: 'text' as const, text: userMessage }] : userMessage.map(block => {
        if (block.type === 'text') return { type: 'text' as const, text: block.text };
        const match = /^data:(image\/[^;]+);base64,([\s\S]+)$/.exec(block.image_url.url);
        if (!match) throw new Error('MA_INPUT_INVALID');
        return { type: 'image' as const, mimeType: match[1], data: match[2] };
      });
      const turn = local.nextTurn(); current = turn;
      const task = stack.push({ prompt: typeof userMessage === 'string' ? userMessage : '[multimodal input]', messageAnchor: pool().length }); stack.pop();
      const previousEntries = new Set(session.inspectHistory({ all: true }).map(entry => String(entry.id)));
      const queue: AgentEvent[] = [];
      let wake: (() => void) | undefined; let finished = false; let failure: unknown; let outcome;
      pushEvent = event => { queue.push(event); wake?.(); wake = undefined; };
      const abort = () => { void session.abort(turn.turnId).catch(() => {}); };
      const run = session.prompt({ content: parts }, turn).then(result => { outcome = result; }, error => { failure = error; })
        .finally(() => { finished = true; wake?.(); wake = undefined; });
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      yield { type: 'task:start', taskId: task.id, prompt: task.prompt };
      try {
        while (!finished || queue.length) {
          while (queue.length) yield queue.shift()!;
          if (!finished) await new Promise<void>(resolve => { wake = resolve; });
        }
        await run;
        if (failure) throw failure;
        if (outcome!.status === 'completed') { stack.markDone(task.id, 'Completed'); yield { type: 'task:done', taskId: task.id }; }
        else if (outcome!.status === 'cancelled') { stack.markFailed(task.id, 'Cancelled'); yield { type: 'task:aborted', taskId: task.id }; }
        else { const message = outcome!.error?.message ?? 'Execution remains unresolved.'; stack.markFailed(task.id, message); yield { type: 'task:failed', taskId: task.id, error: message }; }
      } catch (error) {
        const safe = publicRuntimeError(error); stack.markFailed(task.id, safe.message); yield { type: 'task:failed', taskId: task.id, error: `${safe.message} (${safe.code})` };
      } finally {
        signal?.removeEventListener('abort', abort); if (!finished) { abort(); await run; }
        taskEntries.set(task.id, new Set(session.inspectHistory({ all: true }).map(entry => String(entry.id)).filter(id => !previousEntries.has(id))));
        current = undefined; pushEvent = undefined;
      }
    },
    reset() { contextEdit({ action: 'clear' }); },
    getTaskStack: () => stack,
    getArchive: taskId => {
      const ids = taskEntries.get(taskId);
      return ids ? pool(true).filter(entry => ids.has(entry.id)).map(entry => ({ role: entry.role, content: entry.text })) : [];
    },
    abortAll() { for (const done of confirmations.values()) done(false); if (current) void session.abort(current.turnId).catch(() => {}); return stack.abortAll(); },
    revertLastTurnContextOnly() { const entries = pool(); const lastUser = [...entries].reverse().find(entry => entry.role === 'user'); contextEdit({ action: 'revert' }); return lastUser ? entries.length - lastUser.i! : entries.length; },
    respondConfirm(requestId, approved) { confirmations.get(requestId)?.(approved); },
    getProviderState: () => session.providerState(),
    getMemoryController: () => local.runtime.getMemoryController?.() ?? null,
    getContextUsage: () => ({ used: usedTokens, total: local.bootstrap.capability.contextWindow,
      compactThreshold: Math.floor(local.bootstrap.capability.contextWindow * 0.8), source: 'pi/provider-usage' }),
    inspectContext: () => JSON.stringify(session.inspectHistory(), null, 2),
    searchContext: query => pool(true).filter(entry => entry.text.includes(query)),
    recallContext(id) { const entry = pool(true).find(item => item.id === id); if (!entry) throw new Error('Context entry not found'); contextEdit({ action: 'pin', text: entry.text }); return entry.text; },
    pinContext(text) { contextEdit({ action: 'pin', text }); return text; },
    activeContext: () => pool().map(entry => ({ i: entry.i!, role: entry.role, mode: 'raw', content: entry.text, updatedAt: entry.createdAt })),
    poolContext: limit => limit === undefined ? pool(true) : pool(true).slice(0, limit),
    dropContext(i) {
      const entries = pool(); const lastUser = [...entries].reverse().find(entry => entry.role === 'user');
      if (!lastUser || i < lastUser.i! || !entries.some(entry => entry.i === i)) throw new Error('Only the latest complete user turn can be removed; earlier history remains archived.');
      contextEdit({ action: 'revert' }); return 'Latest user turn removed from active context; execution records remain archived.';
    },
    clearActiveContext() { contextEdit({ action: 'clear' }); return 'Active context cleared; the previous branch and execution records remain archived.'; },
    async close() {
      let failure: unknown; try { await pendingContext; } catch (error) { failure = error; }
      try { await session.close(); } finally { await local.runtime.close?.(); }
      if (failure) throw failure;
    },
  };
}

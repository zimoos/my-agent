import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { TurnScope } from './contracts.js';
import type { ModelCallContext } from './contracts.js';
import type { MaSession, OpenMaSessionOptions, RuntimeEvent } from './public-types.js';
import { openMaSession } from './ma-session.js';
import { publicRuntimeError } from './errors.js';
import { cloneRuntimeJson, ownData } from './data.js';
import type { MaMemoryAction } from './memory-control.js';

export interface MaAcpRuntimeOptions extends OpenMaSessionOptions {
  /** Host resolves this from its persisted binding, never from prompt text or free-form _meta. */
  resolveTurn(input: { sessionId: string; promptId?: string; purpose?: ModelCallContext['modelPurpose'] | 'completion' }): Promise<TurnScope>;
}

export function createMaAcpAgent(connection: acp.AgentSideConnection, options: MaAcpRuntimeOptions): acp.Agent & { shutdown(): Promise<void> } {
  let session: MaSession | undefined;
  let opening: Promise<MaSession> | undefined;
  let pending = false;
  let pendingDone: Promise<void> | undefined;
  let finishPending: (() => void) | undefined;
  const beginPending = () => { pending = true; pendingDone = new Promise<void>(resolve => { finishPending = resolve; }); };
  const endPending = () => { pending = false; currentTurn = undefined; finishPending?.(); finishPending = undefined; pendingDone = undefined; };
  let closed = false;
  let cancelled = false;
  let currentTurn: TurnScope | undefined;
  let notifications: Promise<void> = Promise.resolve();
  let notificationFailure = false;
  const deliver = (work: () => Promise<void>) => {
    notifications = notifications.then(work).catch(() => { notificationFailure = true; });
  };
  const tools = new Map<string, acp.ToolCall>();
  const send = (sessionId: string, update: acp.SessionUpdate): void => {
    deliver(() => connection.sessionUpdate({ sessionId, update }));
  };
  const project = (event: RuntimeEvent): void => {
    deliver(() => connection.extNotification('zimoos.com/ma-runtime/v2', { event: cloneRuntimeJson(event) }));
    const meta = { ma: { protocolVersion: event.protocolVersion, eventId: event.eventId, seq: event.seq,
      sessionId: event.sessionId, engineSessionId: event.engineSessionId,
      ...(event.operationId ? { operationId: event.operationId } : {}),
      ...(event.turnId ? { turnId: event.turnId, epoch: event.epoch } : {}),
      ...(event.callId ? { callId: event.callId } : {}),
      ...(event.logicalCallId ? { logicalCallId: event.logicalCallId } : {}),
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.executionId ? { executionId: event.executionId } : {}),
      kind: event.kind } };
    if (event.kind === 'assistant.delta' && typeof event.payload.text === 'string') {
      send(event.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.payload.text }, _meta: meta });
    } else if (event.kind === 'tool.started' && event.executionId) {
      const tool: acp.ToolCall = { toolCallId: event.executionId, title: String(event.payload.name ?? 'Tool action'),
        kind: 'other', status: 'in_progress', _meta: meta };
      tools.set(event.executionId, tool);
      send(event.sessionId, { sessionUpdate: 'tool_call', ...tool });
    } else if ((event.kind === 'tool.progress' || event.kind === 'tool.completed') && event.executionId) {
      if (!tools.has(event.executionId)) {
        const tool: acp.ToolCall = { toolCallId: event.executionId, title: 'Tool action', kind: 'other', status: 'pending', _meta: meta };
        tools.set(event.executionId, tool);
        send(event.sessionId, { sessionUpdate: 'tool_call', ...tool });
      }
      const content: acp.ToolCallContent[] = [];
      if (Array.isArray(event.payload.content)) {
        for (const block of event.payload.content) {
          if (block?.type === 'text' && typeof block.text === 'string') content.push({ type: 'content', content: { type: 'text', text: block.text } });
          if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
            content.push({ type: 'content', content: { type: 'image', data: block.data, mimeType: block.mimeType } });
          }
        }
      }
      send(event.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: event.executionId,
        status: event.kind === 'tool.progress' || event.payload.status === 'unknown' ? 'in_progress' : event.payload.status === 'succeeded' ? 'completed' : 'failed',
        ...(content.length ? { content } : {}), _meta: meta });
      if (event.kind === 'tool.completed') tools.delete(event.executionId);
    } else if (event.kind === 'turn.completed' && ownData(event.payload.notice, 'code') === 'MA_CONTEXT_UNCHANGED'
      && typeof ownData(event.payload.notice, 'message') === 'string') {
      send(event.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ownData(event.payload.notice, 'message') as string }, _meta: meta });
    } else if ((event.kind === 'turn.failed' || event.kind === 'turn.paused') && event.payload.error) {
      const error = event.payload.error as { code?: string; message?: string };
      send(event.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text',
        text: `${error.message ?? 'This turn needs attention.'}${error.code ? ` (${error.code})` : ''}` }, _meta: meta });
    }
  };
  const requireSession = (id: string): MaSession => {
    if (!session || session.sessionId !== id) throw acp.RequestError.invalidParams(undefined, 'Unknown MA session');
    return session;
  };
  const openSession = async (cwd: string, expectedId?: string): Promise<MaSession> => {
    if (closed) throw acp.RequestError.invalidParams(undefined, 'MA session has been closed');
    if (resolve(cwd) !== options.bootstrap.scope.canonicalCwd
      || (expectedId && expectedId !== options.bootstrap.scope.maSessionId)) {
      throw acp.RequestError.invalidParams(undefined, 'Session identity or workspace does not match the trusted bootstrap');
    }
    if (!opening) {
      opening = openMaSession(options).then(async value => {
        if (closed) { await value.close(); throw new Error('MA_SESSION_CLOSED'); }
        session = value; value.subscribe(project); return value;
      }).catch(error => {
        const safe = publicRuntimeError(error);
        throw acp.RequestError.invalidParams({ ma: safe }, safe.message);
      });
    }
    return opening;
  };
  return {
    async initialize() {
      return { protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: 'ma', title: 'MTEAM Agent', version: '0.3.0' },
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: false, sse: false },
          promptCapabilities: { image: options.bootstrap.capability.input.includes('image'), embeddedContext: false },
          sessionCapabilities: { close: {} } } };
    },
    async authenticate() { return {}; },
    async newSession(params) {
      if (params.mcpServers.length) throw acp.RequestError.invalidParams(undefined, 'MCP servers must come from the trusted MA bootstrap');
      const value = await openSession(params.cwd);
      return { sessionId: value.sessionId };
    },
    async loadSession(params) {
      const value = await openSession(params.cwd, params.sessionId);
      // Loading a paused session must keep the ACP control channel alive so the
      // trusted Host can invoke the explicit recovery extension. The session
      // itself continues to fence prompts while recovery evidence is unresolved.
      const recovery = await value.recover();
      return { _meta: { ma: { recovery: cloneRuntimeJson(recovery) } } };
    },
    async prompt(params: acp.PromptRequest) {
      const value = requireSession(params.sessionId);
      if (pending) throw acp.RequestError.invalidParams(undefined, 'A prompt is already active');
      beginPending(); cancelled = false;
      try {
        const turn = cloneRuntimeJson(await options.resolveTurn({ sessionId: params.sessionId,
          ...(params.messageId ? { promptId: params.messageId } : {}) }));
        currentTurn = turn;
        if (cancelled) { await options.host.revokeTurn(turn); return { stopReason: 'cancelled' }; }
        const content = params.prompt.map(block => {
          if (block.type === 'text') return { type: 'text' as const, text: block.text };
          if (block.type === 'image') return { type: 'image' as const, data: block.data, mimeType: block.mimeType };
          throw new Error('MA_INPUT_INVALID');
        });
        const outcome = await value.prompt({ content }, turn);
        await notifications;
        if (notificationFailure) throw new Error('MA_HOST_EVENT_DELIVERY_FAILED');
        if (outcome.status === 'cancelled') return { stopReason: 'cancelled', userMessageId: params.messageId };
        if (outcome.status !== 'completed') throw acp.RequestError.invalidParams({ ma: outcome.error },
          outcome.error?.message ?? 'MA execution requires attention');
        return { stopReason: 'end_turn', userMessageId: params.messageId };
      } catch (error) {
        if (error instanceof acp.RequestError) throw error;
        const safe = publicRuntimeError(error);
        throw acp.RequestError.invalidParams({ ma: safe }, safe.message);
      } finally { endPending(); }
    },
    async cancel(params) {
      requireSession(params.sessionId);
      cancelled = true;
      if (currentTurn) await session!.abort(currentTurn.turnId);
    },
    async extMethod(method, params) {
      const input = cloneRuntimeJson(params);
      if (typeof input.sessionId !== 'string') throw acp.RequestError.invalidParams(undefined, 'MA session identity is required');
      const value = requireSession(input.sessionId);
      if (method === 'zimoos.com/ma-runtime/v2' && input.action === 'model.receipt'
        && typeof input.callId === 'string' && Object.keys(input).every(key => ['sessionId', 'action', 'callId'].includes(key))) {
        return { execution: await value.inspectModelExecution(input.callId) };
      }
      if (method === 'zimoos.com/ma-runtime/v2' && input.action === 'recover'
        && Object.keys(input).every(key => key === 'sessionId' || key === 'action')) return { ...await value.recover() };
      if (method === 'zimoos.com/ma-runtime/v2' && ['context.clear', 'context.revert', 'context.pin'].includes(String(input.action))) {
        if (pending || closed || Object.keys(input).some(key => !['action', 'sessionId', 'text'].includes(key))
          || (input.action === 'context.pin' ? typeof input.text !== 'string' : Object.hasOwn(input, 'text'))) {
          throw acp.RequestError.invalidParams(undefined, 'Invalid context action or busy session');
        }
        return { ...await value.editContext({ action: input.action === 'context.clear' ? 'clear' : input.action === 'context.revert' ? 'revert' : 'pin',
          ...(input.action === 'context.pin' ? { text: input.text as string } : {}) }) };
      }
      if (method === 'zimoos.com/ma-runtime/v2' && (input.action === 'compact' || input.action === 'branch_summary' || input.action === 'completion')) {
        if (pending || closed) throw acp.RequestError.invalidParams(undefined, 'MA session is busy or closed');
        if (Object.keys(input).some(key => !['action', 'sessionId', 'instructions', 'targetEntryId'].includes(key))
          || (input.instructions !== undefined && typeof input.instructions !== 'string')
          || (input.action === 'branch_summary' && typeof input.targetEntryId !== 'string')
          || (input.action === 'completion' && Object.keys(input).some(key => !['action', 'sessionId'].includes(key)))) {
          throw acp.RequestError.invalidParams(undefined, 'Invalid context operation');
        }
        beginPending(); cancelled = false;
        try {
          const turn = await options.resolveTurn({ sessionId: input.sessionId, purpose: input.action === 'compact' ? 'compaction' : input.action === 'completion' ? 'completion' : 'branch_summary' });
          currentTurn = turn;
          if (cancelled) { await options.host.revokeTurn(turn); return { status: 'cancelled' }; }
          const settings = typeof input.instructions === 'string' ? { instructions: input.instructions } : {};
          const outcome = input.action === 'completion' ? await value.completeProtected(turn)
            : input.action === 'compact' ? await value.compact(settings, turn)
            : await value.summarizeBranch({ ...settings, targetEntryId: input.targetEntryId as string }, turn);
          await notifications;
          return { ...outcome };
        } finally { endPending(); }
      }
      if (method === 'zimoos.com/ma-memory/v1') return { ...await value.memory(input as unknown as MaMemoryAction) };
      throw acp.RequestError.invalidParams(undefined, 'Unsupported MA ACP extension');
    },
    async closeSession(params) {
      closed = true; cancelled = true;
      await requireSession(params.sessionId).close();
      await pendingDone;
      session = undefined;
      return {};
    },
    async shutdown() {
      closed = true; cancelled = true;
      await opening?.catch(() => undefined);
      await session?.close(); await pendingDone; await notifications.catch(() => {});
    },
  };
}

export async function runMaAcpServer(options: MaAcpRuntimeOptions): Promise<void> {
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  let agent: ReturnType<typeof createMaAcpAgent> | undefined;
  new acp.AgentSideConnection(connection => (agent = createMaAcpAgent(connection, options)), acp.ndJsonStream(output, input));
  await new Promise<void>(done => process.stdin.once('end', done));
  await agent?.shutdown();
}

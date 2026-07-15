import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { bootstrap, shutdown, type BootstrapResult } from '../index.js';
import type {
  Agent as MaAgent,
  AgentEvent,
  ChatContent,
  McpServerConfig,
} from '../mcp/types.js';
import { VERSION } from '../version.js';

interface MaAcpSession {
  boot: BootstrapResult;
  pendingPrompt: AbortController | null;
  pendingTool: acp.ToolCall | null;
  failed: boolean;
}

export interface MaAcpServerOptions {
  configPath?: string;
  sessionDir?: string;
  bootstrapSession?: typeof bootstrap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function systemPromptFromMeta(meta: unknown): string | undefined {
  if (!isRecord(meta) || !isRecord(meta.mteam)) return undefined;
  return typeof meta.mteam.systemPrompt === 'string'
    ? meta.mteam.systemPrompt
    : undefined;
}

function mcpServersFromAcp(servers: acp.McpServer[], cwd: string): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    if ('type' in server && server.type) {
      throw new Error(`MA ACP currently supports stdio MCP only: ${server.name}`);
    }
    if (!server.command) throw new Error(`MCP server command is required: ${server.name}`);
    out[server.name] = {
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map((item) => [item.name, item.value])),
      cwd,
    };
  }
  return out;
}

function promptContent(blocks: acp.ContentBlock[]): ChatContent {
  const parts: Exclude<ChatContent, string> = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text });
        break;
      case 'image':
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${block.mimeType};base64,${block.data}` },
        });
        break;
      case 'resource_link':
        parts.push({
          type: 'text',
          text: `[Resource: ${block.title ?? block.name}] ${block.uri}`,
        });
        break;
      case 'resource':
        parts.push({
          type: 'text',
          text: 'text' in block.resource
            ? block.resource.text
            : `[Embedded resource: ${block.resource.uri ?? 'binary'}]`,
        });
        break;
      case 'audio':
        throw new Error('MA ACP does not support audio prompts');
    }
  }
  if (parts.length === 1 && parts[0]?.type === 'text') return parts[0].text;
  return parts;
}

function toolKind(name: string): acp.ToolKind {
  const lower = name.toLowerCase();
  if (/(read|current|get|list)/.test(lower)) return 'read';
  if (/(write|edit|patch|create)/.test(lower)) return 'edit';
  if (/(delete|remove)/.test(lower)) return 'delete';
  if (/(grep|search|find)/.test(lower)) return 'search';
  if (/(exec|command|shell|terminal)/.test(lower)) return 'execute';
  if (/(fetch|http|web)/.test(lower)) return 'fetch';
  return 'other';
}

function toolLocations(args: Record<string, unknown>): acp.ToolCallLocation[] | undefined {
  for (const key of ['path', 'filePath', 'file', 'cwd']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return [{ path: value }];
  }
  return undefined;
}

function planEntries(content: string): acp.PlanEntry[] {
  const entries = content
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .map((line): acp.PlanEntry => ({
      content: line,
      priority: 'medium',
      status: 'pending',
    }));
  return entries.length > 0
    ? entries
    : [{ content: content.trim() || 'Complete the requested task', priority: 'medium', status: 'pending' }];
}

function resultContent(event: Extract<AgentEvent, { type: 'tool:result' }>): acp.ToolCallContent[] {
  return [{
    type: 'content',
    content: { type: 'text', text: event.content },
  }];
}

export class MaAcpAgent implements acp.Agent {
  private readonly sessions = new Map<string, MaAcpSession>();

  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly options: MaAcpServerOptions = {},
  ) {}

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'ma', title: 'MTEAM Agent', version: VERSION },
      agentCapabilities: {
        loadSession: false,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { close: {} },
      },
    };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    if (!isAbsolute(params.cwd)) throw new Error('ACP session cwd must be absolute');
    const cwd = resolve(params.cwd);
    const boot = await (this.options.bootstrapSession ?? bootstrap)(this.options.configPath, {
      cwd,
      mcpServers: mcpServersFromAcp(params.mcpServers, cwd),
      systemPrompt: systemPromptFromMeta(params._meta),
      sessionDir: this.options.sessionDir,
      confirmationChannel: 'host',
      configMode: 'host-only',
      loadAgentInstructions: false,
      debugLogging: false,
    });
    this.sessions.set(boot.sessionId, {
      boot,
      pendingPrompt: null,
      pendingTool: null,
      failed: false,
    });
    return { sessionId: boot.sessionId };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.requireSession(params.sessionId);
    if (session.pendingPrompt) throw new Error(`Session ${params.sessionId} is already processing a prompt`);
    const pending = new AbortController();
    session.pendingPrompt = pending;
    session.pendingTool = null;
    session.failed = false;
    try {
      for await (const event of session.boot.agent.chat(promptContent(params.prompt), pending.signal)) {
        await this.forwardEvent(params.sessionId, session, event);
      }
      if (pending.signal.aborted) return { stopReason: 'cancelled', userMessageId: params.messageId };
      return {
        stopReason: session.failed ? 'refusal' : 'end_turn',
        userMessageId: params.messageId,
      };
    } catch (error) {
      if (pending.signal.aborted) return { stopReason: 'cancelled', userMessageId: params.messageId };
      throw error;
    } finally {
      session.pendingPrompt = null;
      session.pendingTool = null;
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return;
    session.pendingPrompt?.abort();
    session.boot.agent.abortAll();
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return {};
    session.pendingPrompt?.abort();
    session.boot.agent.abortAll();
    await shutdown(session.boot.connections, session.boot.agent);
    this.sessions.delete(params.sessionId);
    return {};
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async (session) => {
      session.pendingPrompt?.abort();
      session.boot.agent.abortAll();
      await shutdown(session.boot.connections, session.boot.agent);
    }));
  }

  private requireSession(sessionId: string): MaAcpSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return session;
  }

  private async send(sessionId: string, update: acp.SessionUpdate): Promise<void> {
    await this.connection.sessionUpdate({ sessionId, update });
  }

  private async forwardEvent(
    sessionId: string,
    session: MaAcpSession,
    event: AgentEvent,
  ): Promise<void> {
    switch (event.type) {
      case 'token':
        await this.send(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: event.text },
        });
        return;
      case 'text':
        await this.send(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: event.content },
        });
        return;
      case 'ask_user':
        await this.send(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: event.question },
        });
        return;
      case 'progress':
      case 'warning':
        await this.send(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: event.message },
        });
        return;
      case 'provider:progress':
        await this.send(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: event.message },
        });
        return;
      case 'provider:attempt':
        await this.send(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: `Model request ${event.attempt}/${event.maxAttempts}` },
        });
        return;
      case 'provider:retry':
        await this.send(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: `Retrying model request: ${event.error}` },
        });
        return;
      case 'compact:done':
        await this.send(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: `Context compacted (${event.freed} tokens freed)` },
        });
        return;
      case 'context:usage':
        await this.send(sessionId, {
          sessionUpdate: 'usage_update',
          used: event.used,
          size: event.total,
        });
        return;
      case 'plan':
        await this.send(sessionId, {
          sessionUpdate: 'plan',
          entries: planEntries(event.content),
        });
        return;
      case 'tool:call': {
        const toolCall: acp.ToolCall = {
          toolCallId: `ma_tool_${randomUUID()}`,
          title: event.name,
          kind: toolKind(event.name),
          status: 'in_progress',
          rawInput: event.args,
          locations: toolLocations(event.args),
        };
        session.pendingTool = toolCall;
        await this.send(sessionId, { sessionUpdate: 'tool_call', ...toolCall });
        return;
      }
      case 'tool:confirm': {
        const toolCall = session.pendingTool ?? {
          toolCallId: `ma_tool_${randomUUID()}`,
          title: event.cmd,
          kind: 'execute' as const,
          status: 'in_progress' as const,
          rawInput: { command: event.cmd },
        };
        let approved = false;
        try {
          const response = await this.connection.requestPermission({
            sessionId,
            toolCall,
            options: [
              { kind: 'allow_once', name: 'Allow once', optionId: 'allow' },
              { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
            ],
          });
          approved = response.outcome.outcome === 'selected'
            && response.outcome.optionId === 'allow';
        } catch {
          approved = false;
        }
        session.boot.agent.respondConfirm(event.requestId, approved);
        return;
      }
      case 'tool:result': {
        const toolCallId = session.pendingTool?.toolCallId ?? `ma_tool_${randomUUID()}`;
        await this.send(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: event.ok ? 'completed' : 'failed',
          content: resultContent(event),
          rawOutput: event.structuredContent ?? event.content,
        });
        session.pendingTool = null;
        return;
      }
      case 'workspace:diff':
        await this.send(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: event.artifact.summary },
        });
        return;
      case 'task:failed':
        session.failed = true;
        await this.send(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: event.error },
        });
        return;
      case 'task:aborted':
      case 'aborted':
        session.pendingPrompt?.abort();
        return;
      case 'task:start':
      case 'task:done':
      case 'thinking:start':
      case 'thinking:end':
        return;
    }
  }
}

export async function runAcpServer(options: MaAcpServerOptions = {}): Promise<void> {
  const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  let agent: MaAcpAgent | null = null;
  const stream = acp.ndJsonStream(input, output);
  new acp.AgentSideConnection((connection) => {
    agent = new MaAcpAgent(connection, options);
    return agent;
  }, stream);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await agent?.shutdown();
  };
  const onSignal = (): void => {
    void stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  await new Promise<void>((done) => process.stdin.once('end', done));
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  await stop();
}

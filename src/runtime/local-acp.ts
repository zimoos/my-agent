import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { prepareBootstrap } from '../index.js';
import { connectMcpServer } from '../mcp/client.js';
import type { McpConnection, McpServerConfig } from '../mcp/types.js';
import { createLocalSessionEnvironment } from './local-session.js';
import { createMaAcpAgent } from './acp-agent.js';
import { publicRuntimeError } from './errors.js';
import { VERSION } from '../version.js';

export interface StandaloneAcpOptions { configPath?: string; sessionDir?: string }
type Delegate = ReturnType<typeof createMaAcpAgent>;

/** Standalone ACP's trusted local Host; MTEAM uses its own Host through my-agent/host. */
export function createStandaloneMaAcpAgent(connection: acp.AgentSideConnection, options: StandaloneAcpOptions = {}): acp.Agent & { shutdown(): Promise<void> } {
  const sessions = new Map<string, { agent: Delegate; close(): Promise<void> }>();
  const opening = new Set<Promise<unknown>>();
  let closed = false;
  const requireSession = (id: string) => {
    const value = sessions.get(id);
    if (!value || closed) throw acp.RequestError.invalidParams(undefined, 'Unknown or closed MA session');
    return value;
  };
  const open = async (params: acp.NewSessionRequest | acp.LoadSessionRequest, resume?: string) => {
    if (closed) throw acp.RequestError.invalidParams(undefined, 'MA server is closing');
    if (resume && sessions.has(resume)) return sessions.get(resume)!.agent;
    const cwd = realpathSync(params.cwd);
    const servers: Record<string, McpServerConfig> = {};
    for (const server of params.mcpServers) {
      if (Object.hasOwn(servers, server.name) || !server.name || server.name === '__proto__') throw new Error('MA_BOOTSTRAP_INVALID');
      if ('type' in server && server.type) {
        if (server.type !== 'http') throw acp.RequestError.invalidParams(undefined, 'Only stdio and Streamable HTTP MCP are supported');
        servers[server.name] = { transport: 'http', url: server.url,
          headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) };
      } else {
        servers[server.name] = { transport: 'stdio', command: server.command, args: server.args,
          env: Object.fromEntries(server.env.map(item => [item.name, item.value])), cwd };
      }
    }
    const prepared = prepareBootstrap(options.configPath, { cwd, sessionDir: options.sessionDir,
      ...(resume ? { resume } : {}), mcpServers: servers, confirmationChannel: 'host' });
    if (resume && (!prepared.resumed || prepared.sessionId !== resume)) throw acp.RequestError.invalidParams(undefined, 'Saved session not found');
    const connections: McpConnection[] = [];
    let cleanupRuntime: (() => Promise<void>) | undefined;
    let delegate: Delegate | undefined;
    try {
      for (const [name, config] of Object.entries(prepared.config.mcpServers)) connections.push(await connectMcpServer(name, config));
      const local = await createLocalSessionEnvironment(prepared, connections, async (request, reason, signal) => {
        if (signal?.aborted || closed) return false;
        let abort: (() => void) | undefined;
        const cancelled = new Promise<boolean>(resolve => {
          abort = () => resolve(false);
          signal?.addEventListener('abort', abort, { once: true });
        });
        try {
          const permission = connection.requestPermission({ sessionId: prepared.sessionId,
            toolCall: { toolCallId: `permission_${randomUUID().replaceAll('-', '')}`, title: reason,
              kind: 'other', status: 'pending', rawInput: { source: request.source, argsSha256: request.argsSha256 } },
            options: [{ kind: 'allow_once', name: 'Allow once', optionId: 'allow' },
              { kind: 'reject_once', name: 'Reject', optionId: 'reject' }] })
            .then(result => result.outcome.outcome === 'selected' && result.outcome.optionId === 'allow', () => false);
          return await Promise.race([permission, cancelled]);
        } finally { if (abort) signal?.removeEventListener('abort', abort); }
      });
      cleanupRuntime = async () => { await local.runtime.close?.(); };
      delegate = createMaAcpAgent(connection, { bootstrap: local.bootstrap, host: local.host,
        providerRuntime: local.runtime, connections, resolveTurn: async () => local.nextTurn() });
      if (resume) await delegate.loadSession!({ ...params, sessionId: resume, mcpServers: [] });
      else await delegate.newSession({ ...params, mcpServers: [] });
      if (closed) throw new Error('MA_SESSION_CLOSED');
      const agent = delegate;
      const runtimeClose = cleanupRuntime;
      sessions.set(prepared.sessionId, { agent, async close() {
        try { await agent.shutdown(); } finally {
          try { await runtimeClose(); } finally { await Promise.allSettled(connections.map(value => value.close())); }
        }
      } });
      return agent;
    } catch (error) {
      await delegate?.shutdown().catch(() => {});
      await cleanupRuntime?.().catch(() => {});
      await Promise.allSettled(connections.map(value => value.close()));
      if (error instanceof acp.RequestError) throw error;
      const safe = publicRuntimeError(error);
      throw acp.RequestError.invalidParams({ ma: safe }, safe.message);
    }
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    opening.add(promise); void promise.then(() => opening.delete(promise), () => opening.delete(promise)); return promise;
  };
  return {
    async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'ma', title: 'MTEAM Agent', version: VERSION },
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false },
        promptCapabilities: { image: true, embeddedContext: false }, sessionCapabilities: { close: {} } } }; },
    async authenticate() { return {}; },
    async newSession(params) {
      const agent = await track(open(params));
      return agent.newSession({ ...params, mcpServers: [] });
    },
    async loadSession(params) { await track(open(params, params.sessionId)); return {}; },
    prompt(params) { return requireSession(params.sessionId).agent.prompt(params); },
    cancel(params) { return requireSession(params.sessionId).agent.cancel(params); },
    async extMethod(method, params) {
      if (typeof params.sessionId !== 'string') throw acp.RequestError.invalidParams(undefined, 'MA session identity required');
      return requireSession(params.sessionId).agent.extMethod!(method, params);
    },
    async closeSession(params) {
      const value = requireSession(params.sessionId); await value.close(); sessions.delete(params.sessionId); return {};
    },
    async shutdown() {
      closed = true;
      await Promise.allSettled([...opening]);
      await Promise.allSettled([...sessions.values()].map(value => value.close())); sessions.clear();
    },
  };
}

export async function runStandaloneMaAcpServer(options: StandaloneAcpOptions = {}): Promise<void> {
  let agent: ReturnType<typeof createStandaloneMaAcpAgent> | undefined;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  new acp.AgentSideConnection(connection => (agent = createStandaloneMaAcpAgent(connection, options)), acp.ndJsonStream(output, input));
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= agent?.shutdown() ?? Promise.resolve();
  const onSignal = () => { void stop().finally(() => process.exit(0)); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try { await new Promise<void>(resolve => { process.stdin.once('end', resolve); process.stdin.once('close', resolve); }); }
  finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); await stop(); }
}

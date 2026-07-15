import { loadConfigDetailed, loadHostConfigDetailed, resolveConfigPath } from './config.js';
import { connectMcpServer } from './mcp/client.js';
import { createSessionStore } from './session/store.js';
import { resolveModelCapabilities } from './provider/capabilities.js';
import type { AgentConfig, McpConnection, Agent, McpServerConfig } from './mcp/types.js';

export interface BootstrapOptions {
  resume?: string | true;
  cwd?: string;
  mcpServers?: Record<string, McpServerConfig>;
  systemPrompt?: string;
  sessionDir?: string;
  confirmationChannel?: 'tty' | 'host';
  configMode?: 'layered' | 'host-only';
}

export interface BootstrapResult {
  config: AgentConfig;
  configPath: string | null;
  configSources: string[];
  createdDefault: boolean;
  connections: McpConnection[];
  agent: Agent;
  sessionId: string;
  resumed: boolean;
  connectionFailures: Array<{ name: string; error: string }>;
}

export interface BootstrapPreparation {
  config: AgentConfig;
  configPath: string | null;
  configSources: string[];
  createdDefault: boolean;
  sessionStore: ReturnType<typeof createSessionStore>;
  sessionId: string;
  resumeMessages?: any[];
  resumed: boolean;
  contextWindowConfigured?: boolean;
  cwd: string;
  confirmationChannel?: 'tty' | 'host';
}

export function prepareBootstrap(
  configPath?: string,
  opts: BootstrapOptions = {}
): BootstrapPreparation {
  const { config, sources, createdDefault } = opts.configMode === 'host-only'
    ? loadHostConfigDetailed(configPath)
    : loadConfigDetailed(configPath);
  const resolved = opts.configMode === 'host-only'
    ? sources[0] ?? null
    : resolveConfigPath(configPath);
  const cwd = opts.cwd ?? process.cwd();
  if (opts.mcpServers) config.mcpServers = opts.mcpServers;
  if (opts.systemPrompt !== undefined) config.systemPrompt = opts.systemPrompt;
  const contextWindowConfigured = typeof config.model.contextWindow === 'number' && config.model.contextWindow > 0;
  const capabilities = resolveModelCapabilities(config.model);
  config.model.contextWindow = capabilities.contextWindow;
  config.model.contextWindowSource = capabilities.contextWindowSource;
  config.model.requestBodyByteLimit = capabilities.requestBodyByteLimit;
  config.model.requestBodyByteLimitSource = capabilities.requestBodyByteLimitSource;

  const sessionStore = createSessionStore(opts.sessionDir);
  let sessionId: string;
  let resumeMessages: any[] | undefined;
  let resumed = false;

  if (opts.resume !== undefined) {
    const target = typeof opts.resume === 'string' ? opts.resume : sessionStore.latest();
    if (target) {
      const msgs = sessionStore.load(target);
      if (msgs.length > 0) {
        resumeMessages = msgs;
        sessionId = target;
        resumed = true;
      } else {
        sessionId = sessionStore.create({
          createdAt: Date.now(),
          cwd,
          model: config.model.model,
        });
      }
    } else {
      sessionId = sessionStore.create({
        createdAt: Date.now(),
        cwd,
        model: config.model.model,
      });
    }
  } else {
    sessionId = sessionStore.create({
      createdAt: Date.now(),
      cwd,
      model: config.model.model,
    });
  }

  return {
    config,
    configPath: resolved,
    configSources: sources,
    createdDefault,
    sessionStore,
    sessionId,
    resumeMessages,
    resumed,
    contextWindowConfigured,
    cwd,
    confirmationChannel: opts.confirmationChannel,
  };
}

async function hydrateRemoteModelConfig(config: AgentConfig, detectContextWindow: boolean): Promise<void> {
  if (config.model.provider?.toLowerCase() === 'agora') return;
  let lmStudioContextWindow: number | undefined;
  try {
    const res = await fetch(`${config.model.baseURL}/models`, { signal: AbortSignal.timeout(300) });
    const data = await res.json() as { data: Array<{ id: string }> };
    const available = data.data.map((model) => model.id);
    if (available.length > 0 && !available.includes(config.model.model)) {
      config.model.model = available[0];
    }
  } catch {
    // Provider availability is resolved by the first chat request.
  }
  if (detectContextWindow) {
    try {
      const base = config.model.baseURL.replace(/\/v1\/?$/, '');
      const res = await fetch(`${base}/api/v0/models`, { signal: AbortSignal.timeout(300) });
      const data = await res.json() as { data: Array<{ id: string; max_context_length?: number }> };
      lmStudioContextWindow = data.data.find((model) => model.id === config.model.model)?.max_context_length;
    } catch {
      // LM Studio native metadata is optional.
    }
  }
  const capabilities = resolveModelCapabilities(config.model, { lmStudioContextWindow });
  config.model.contextWindow = capabilities.contextWindow;
  config.model.contextWindowSource = capabilities.contextWindowSource;
  config.model.requestBodyByteLimit = capabilities.requestBodyByteLimit;
  config.model.requestBodyByteLimitSource = capabilities.requestBodyByteLimitSource;
}

export async function hydrateBootstrap(prepared: BootstrapPreparation): Promise<BootstrapResult> {
  const modelConfigReady = hydrateRemoteModelConfig(prepared.config, !prepared.contextWindowConfigured);
  const entries = Object.entries(prepared.config.mcpServers ?? {}) as Array<[string, McpServerConfig]>;
  const connectionsReady = Promise.allSettled(
    entries.map(async ([name, serverConfig]) => ({ name, connection: await connectMcpServer(name, serverConfig) })),
  );
  const [, settled] = await Promise.all([modelConfigReady, connectionsReady]);
  const connections: McpConnection[] = [];
  const connectionFailures: Array<{ name: string; error: string }> = [];
  settled.forEach((result, index) => {
    const name = entries[index]?.[0] ?? `mcp-${index}`;
    if (result.status === 'fulfilled') connections.push(result.value.connection);
    else connectionFailures.push({ name, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  });
  try {
    const { createAgent } = await import('./agent.js');
    const agent = await createAgent(prepared.config, connections, {
      resumeMessages: prepared.resumeMessages,
      sessionStore: prepared.sessionStore,
      sessionId: prepared.sessionId,
      cwd: prepared.cwd,
      confirmationChannel: prepared.confirmationChannel,
    });
    return {
      config: prepared.config,
      configPath: prepared.configPath,
      configSources: prepared.configSources,
      createdDefault: prepared.createdDefault,
      connections,
      agent,
      sessionId: prepared.sessionId,
      resumed: prepared.resumed,
      connectionFailures,
    };
  } catch (error) {
    await shutdown(connections);
    throw error;
  }
}

export async function bootstrap(
  configPath?: string,
  opts: BootstrapOptions = {}
): Promise<BootstrapResult> {
  return hydrateBootstrap(prepareBootstrap(configPath, opts));
}

export async function shutdown(connections: McpConnection[], agent?: Agent): Promise<void> {
  try {
    await agent?.close();
  } catch {
    /* ignore */
  }
  for (const conn of connections) {
    try {
      await conn.close();
    } catch {
      /* ignore */
    }
  }
}

export { loadConfig, loadConfigDetailed, resolveConfigPath } from './config.js';

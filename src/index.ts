import { loadConfigDetailed, resolveConfigPath } from './config.js';
import { connectMcpServer } from './mcp/client.js';
import { createAgent } from './agent.js';
import { createSessionStore } from './session/store.js';
import { resolveModelCapabilities } from './provider/capabilities.js';
import type { AgentConfig, McpConnection, Agent, McpServerConfig } from './mcp/types.js';

export interface BootstrapOptions {
  resume?: string | true;
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
}

export async function bootstrap(
  configPath?: string,
  opts: BootstrapOptions = {}
): Promise<BootstrapResult> {
  const { config, sources, createdDefault } = loadConfigDetailed(configPath);
  const resolved = resolveConfigPath(configPath);

  // Auto-detect model from server
  try {
    const res = await fetch(`${config.model.baseURL}/models`);
    const data = await res.json() as { data: Array<{ id: string }> };
    const available = data.data.map(m => m.id);
    if (available.length > 0) {
      const configured = config.model.model;
      if (available.includes(configured)) {
        // configured model available, keep it
      } else if (available.length === 1) {
        config.model.model = available[0];
        process.stderr.write(`\x1b[33m[info] auto-selected model: ${available[0]}\x1b[0m\n`);
      } else {
        config.model.model = available[0];
        process.stderr.write(`\x1b[33m[info] "${configured}" not found, using: ${available[0]}\x1b[0m\n`);
      }
    }
  } catch {
    // server unreachable, keep config as-is
  }

  let lmStudioContextWindow: number | undefined;

  // Auto-detect context window from LM Studio native API
  if (!config.model.contextWindow) {
    try {
      const base = config.model.baseURL.replace(/\/v1\/?$/, '');
      const res = await fetch(`${base}/api/v0/models`);
      const data = await res.json() as {
        data: Array<{ id: string; max_context_length?: number }>;
      };
      const found = data.data.find((m) => m.id === config.model.model);
      if (found?.max_context_length) {
        lmStudioContextWindow = found.max_context_length;
        process.stderr.write(
          `\x1b[33m[info] auto-detected context window: ${found.max_context_length}\x1b[0m\n`
        );
      }
    } catch {
      // native API unavailable, use default
    }
  }

  const capabilities = resolveModelCapabilities(config.model, { lmStudioContextWindow });
  config.model.contextWindow = capabilities.contextWindow;
  config.model.contextWindowSource = capabilities.contextWindowSource;

  const entries = Object.entries(config.mcpServers ?? {}) as Array<[string, McpServerConfig]>;
  const connections: McpConnection[] = [];
  for (const [name, serverConfig] of entries) {
    try {
      const conn = await connectMcpServer(name, serverConfig);
      connections.push(conn);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\x1b[33m[warn] mcp "${name}" failed to connect: ${msg}\x1b[0m\n`);
    }
  }

  const sessionStore = createSessionStore();
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
          cwd: process.cwd(),
          model: config.model.model,
        });
      }
    } else {
      sessionId = sessionStore.create({
        createdAt: Date.now(),
        cwd: process.cwd(),
        model: config.model.model,
      });
    }
  } else {
    sessionId = sessionStore.create({
      createdAt: Date.now(),
      cwd: process.cwd(),
      model: config.model.model,
    });
  }

  const agent = await createAgent(config, connections, {
    resumeMessages,
    sessionStore,
    sessionId,
  });

  return {
    config,
    configPath: resolved,
    configSources: sources,
    createdDefault,
    connections,
    agent,
    sessionId,
    resumed,
  };
}

export async function shutdown(connections: McpConnection[]): Promise<void> {
  for (const conn of connections) {
    try {
      await conn.close();
    } catch {
      /* ignore */
    }
  }
}

export { loadConfig, loadConfigDetailed, resolveConfigPath } from './config.js';

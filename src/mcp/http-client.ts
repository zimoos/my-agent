import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { VERSION } from '../version.js';
import type { McpConnection, McpServerConfig } from './types.js';
import { collectMcpTools, normalizeMcpCallResult, mcpRequestTimeout } from './client.js';

/** Official MCP HTTP transport; no tools/call replay or stdio fallback after an uncertain write. */
export async function connectHttpMcpServer(name: string, config: McpServerConfig): Promise<McpConnection> {
  if (!config.url || config.command) throw new Error('MCP HTTP requires one explicit URL and no stdio command');
  const url = new URL(config.url);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const octets = hostname.split('.');
  const loopback = hostname === 'localhost' || hostname === '::1'
    || (octets.length === 4 && octets[0] === '127' && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255));
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) {
    throw new Error('MCP remote transport requires HTTPS; HTTP is allowed only for an explicit loopback host');
  }
  const timeout = mcpRequestTimeout(config);
  const client = new Client({ name: 'my-agent', version: VERSION }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { ...config.headers }, redirect: 'error' },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  try {
    await client.connect(transport);
    const tools = await collectMcpTools(params => client.listTools(params));
    return {
      name, tools,
      capabilities: { transport: 'http', cancellation: 'request-only', server: { ...client.getServerCapabilities() } },
      async call(toolName, args, signal, onProgress, transportMeta) {
        signal?.throwIfAborted();
        return normalizeMcpCallResult(await client.callTool({ name: toolName, arguments: args,
          ...(transportMeta ? { _meta: transportMeta } : {}) }, undefined, {
          signal, timeout, resetTimeoutOnProgress: false,
          onprogress: onProgress ? progress => onProgress({ ...progress, progressToken: `${name}:http`, raw: progress }) : undefined,
        }));
      },
      async close() { await client.close(); },
    };
  } catch (error) { await client.close().catch(() => {}); throw error; }
}

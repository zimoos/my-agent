import { spawn, type ChildProcess } from 'node:child_process';
import { setMaxListeners } from 'node:events';
import * as fs from 'node:fs';
import { VERSION } from '../version.js';
import type {
  McpConnection,
  McpServerConfig,
  McpTool,
  McpCallResult,
  McpProgressEvent,
  ToolContentBlock,
} from './types.js';

const signalLimitApplied = new WeakSet<AbortSignal>();

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

const REQUEST_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = '2024-11-05';
export function mcpRequestTimeout(config: McpServerConfig): number {
  const value = config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1000 || value > 3_600_000) throw new Error('MCP timeout must be an integer between 1000 and 3600000 milliseconds');
  return value;
}
const MAX_TOOL_IMAGE_BASE64_CHARS = 24 * 1024 * 1024;
const SAFE_IMAGE_MIME = /^image\/(?:png|jpeg|webp)$/;

function toolContentBlock(value: unknown): ToolContentBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const block = value as Record<string, unknown>;
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if (block.type !== 'image'
    || typeof block.data !== 'string'
    || block.data.length === 0
    || block.data.length > MAX_TOOL_IMAGE_BASE64_CHARS
    || typeof block.mimeType !== 'string'
    || !SAFE_IMAGE_MIME.test(block.mimeType)) return null;
  return {
    type: 'image',
    data: block.data,
    mimeType: block.mimeType,
    ...(typeof block.uri === 'string' ? { uri: block.uri } : {}),
  };
}

export function buildMcpEnv(extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  // A server receives only its approved environment, never unrelated Host/model credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'TZ', 'TERM', 'COLORTERM', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, extraEnv);
  const extraCerts = env.NODE_EXTRA_CA_CERTS;
  if (extraCerts) {
    try {
      fs.accessSync(extraCerts, fs.constants.R_OK);
    } catch {
      delete env.NODE_EXTRA_CA_CERTS;
    }
  }
  return env;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  progressToken?: string | number;
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function withProgressToken(params: any, progressToken: string | number): any {
  const out =
    params && typeof params === 'object' && !Array.isArray(params)
      ? { ...params }
      : {};
  const currentMeta =
    out._meta && typeof out._meta === 'object' && !Array.isArray(out._meta)
      ? out._meta
      : {};
  out._meta = { ...currentMeta, progressToken };
  return out;
}

export class McpClient implements McpConnection {
  name: string;
  process: ChildProcess;
  tools: McpTool[] = [];
  capabilities: NonNullable<McpConnection['capabilities']> = { transport: 'stdio', cancellation: 'request-only', server: {} };

  private nextId = 1;
  private pending = new Map<number, Pending>();
  private progressHandlers = new Map<string | number, (event: McpProgressEvent) => void>();
  private buffer = '';
  private closed = false;
  private requestTimeoutMs: number;

  constructor(name: string, proc: ChildProcess, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
    this.name = name;
    this.process = proc;
    this.requestTimeoutMs = requestTimeoutMs;

    proc.stdout!.setEncoding('utf-8');
    proc.stdout!.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stdout!.on('error', () => {});

    if (proc.stderr) {
      proc.stderr.setEncoding('utf-8');
      proc.stderr.on('data', (chunk: string) => {
        process.stderr.write(`[mcp:${name}] ${chunk}`);
      });
    }

    proc.on('exit', (code, signal) => {
      this.closed = true;
      const err = new Error(
        `MCP server '${name}' exited (code=${code}, signal=${signal})`
      );
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.progressHandlers.clear();
    });

    proc.on('error', (err) => {
      process.stderr.write(`[mcp:${name}] spawn error: ${err.message}\n`);
    });
  }

  private onStdout(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    let msg: JsonRpcResponse | JsonRpcNotification;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`[mcp:${this.name}] invalid JSON line: ${line}\n`);
      return;
    }
    if (typeof (msg as JsonRpcResponse).id !== 'number') {
      this.handleNotification(msg as JsonRpcNotification);
      return;
    }
    const response = msg as JsonRpcResponse;
    const p = this.pending.get(response.id);
    if (!p) return;
    this.pending.delete(response.id);
    clearTimeout(p.timer);
    if (response.error) {
      p.reject(
        new Error(`MCP '${this.name}' ${p.method} error: ${response.error.message}`)
      );
    } else {
      p.resolve(response.result);
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    if (
      msg.method !== 'notifications/progress' &&
      msg.method !== '$/progress'
    ) {
      return;
    }
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    const progressToken = params.progressToken ?? params.progress_token ?? params.token;
    if (typeof progressToken !== 'string' && typeof progressToken !== 'number') return;
    const handler = this.progressHandlers.get(progressToken);
    if (!handler) return;
    handler({
      progressToken,
      progress: finiteNumber(params.progress),
      total: finiteNumber(params.total),
      message: typeof params.message === 'string' ? params.message : undefined,
      raw: params,
    });
  }

  private send(obj: JsonRpcRequest | JsonRpcNotification): void {
    if (this.closed || !this.process.stdin || this.process.stdin.destroyed) {
      throw new Error(`MCP '${this.name}' stdin is closed`);
    }
    this.process.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(
    method: string,
    params?: any,
    signal?: AbortSignal,
    onProgress?: (event: McpProgressEvent) => void
  ): Promise<any> {
    const id = this.nextId++;
    const progressToken = onProgress ? `${this.name}:${method}:${id}` : undefined;
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params: progressToken === undefined ? params : withProgressToken(params, progressToken),
    };

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }

      const timer = setTimeout(() => {
        try { this.notify('notifications/cancelled', { requestId: id, reason: 'Request deadline reached' }); } catch { /* Still unknown. */ }
        this.pending.delete(id);
        if (progressToken !== undefined) this.progressHandlers.delete(progressToken);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        reject(new Error(`MCP '${this.name}' ${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      const wrappedResolve = (value: any) => {
        if (progressToken !== undefined) this.progressHandlers.delete(progressToken);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const wrappedReject = (err: Error) => {
        if (progressToken !== undefined) this.progressHandlers.delete(progressToken);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        reject(err);
      };

      let onAbort: (() => void) | null = null;
      if (signal) {
        if (!signalLimitApplied.has(signal)) {
          setMaxListeners(50, signal);
          signalLimitApplied.add(signal);
        }
        onAbort = () => {
          try { this.notify('notifications/cancelled', { requestId: id, reason: 'Caller cancelled' }); } catch { /* Outcome remains unknown. */ }
          clearTimeout(timer);
          this.pending.delete(id);
          if (progressToken !== undefined) this.progressHandlers.delete(progressToken);
          reject(new DOMException('aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (progressToken !== undefined && onProgress) {
        this.progressHandlers.set(progressToken, onProgress);
      }
      this.pending.set(id, {
        resolve: wrappedResolve,
        reject: wrappedReject,
        timer,
        method,
        progressToken,
      });
      try {
        this.send(req);
      } catch (err) {
        this.pending.delete(id);
        if (progressToken !== undefined) this.progressHandlers.delete(progressToken);
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params?: any): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async initialize(): Promise<void> {
    const initialized = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'my-agent', version: VERSION },
    });
    this.capabilities.server = initialized?.capabilities ?? {};
    try {
      this.notify('notifications/initialized');
    } catch {
      /* some servers do not require this */
    }
  }

  async listTools(): Promise<McpTool[]> {
    this.tools = await collectMcpTools(params => this.request('tools/list', params));
    return this.tools;
  }

  async call(
    toolName: string,
    args: Record<string, any>,
    signal?: AbortSignal,
    onProgress?: (event: McpProgressEvent) => void,
    transportMeta?: Record<string, unknown>
  ): Promise<McpCallResult> {
    const result = await this.request(
      'tools/call',
      { name: toolName, arguments: args ?? {}, ...(transportMeta ? { _meta: transportMeta } : {}) },
      signal,
      onProgress
    );
    return normalizeMcpCallResult(result);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP '${this.name}' connection closing`));
    }
    this.pending.clear();
    this.progressHandlers.clear();
    try { this.process.stdin?.end(); } catch { /* ignore */ }
    if (this.process.exitCode === null && this.process.signalCode === null) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          this.process.off('exit', finish);
          resolve();
        };
        const t = setTimeout(() => {
          try { this.process.kill('SIGKILL'); } catch { /* ignore */ }
          finish();
        }, 2000);
        this.process.once('exit', finish);
        try { this.process.kill('SIGTERM'); } catch { finish(); }
        if (this.process.exitCode !== null || this.process.signalCode !== null) finish();
      });
    }
  }
}

export async function collectMcpTools(list: (params: { cursor?: string }) => Promise<any>): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 1024; page++) {
    const result = await list(cursor ? { cursor } : {});
    if (!Array.isArray(result?.tools)) throw new Error('MCP tools/list returned an invalid catalog');
    for (const tool of result.tools) {
      if (typeof tool?.name !== 'string' || !tool.name || names.has(tool.name)
        || !tool.inputSchema || typeof tool.inputSchema !== 'object') throw new Error('MCP tool catalog is invalid or ambiguous');
      names.add(tool.name);
      tools.push({ name: tool.name, description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool._meta ? { _meta: tool._meta } : {}) });
    }
    if (result.nextCursor === undefined) return tools;
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error('MCP pagination did not advance');
    cursor = result.nextCursor as string; cursors.add(cursor);
  }
  throw new Error('MCP catalog exceeds the supported pagination limit');
}

export function normalizeMcpCallResult(result: any): McpCallResult {
    const contentArr = Array.isArray(result?.content) ? result.content : [];
    const contentBlocks = contentArr
      .map(toolContentBlock)
      .filter((block: ToolContentBlock | null): block is ToolContentBlock => block !== null);
    const text = contentArr
      .map((c: any) => {
        if (typeof c?.text === 'string') return c.text;
        if (c?.type === 'text') return String(c.text ?? '');
        if (c?.type === 'image') return `[image:${String(c.mimeType ?? 'unknown')}]`;
        return JSON.stringify(c);
      })
      .join('\n');
    const callResult: McpCallResult = {
      content: text,
      isError: Boolean(result?.isError),
      ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
    };
    if (Object.prototype.hasOwnProperty.call(result ?? {}, 'structuredContent')) {
      callResult.structuredContent = result.structuredContent;
    }
    if (Object.prototype.hasOwnProperty.call(result ?? {}, '_meta')) {
      callResult._meta = result._meta;
    }
    return callResult;
}

export async function connectMcpServer(
  name: string,
  config: McpServerConfig
): Promise<McpConnection> {
  if (config.transport === 'http' || config.url) {
    const { connectHttpMcpServer } = await import('./http-client.js');
    return connectHttpMcpServer(name, config);
  }
  if (typeof config.command !== 'string' || !config.command) throw new Error('MCP stdio command is required');
  mcpRequestTimeout(config);
  const child = spawn(config.command, config.args ?? [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildMcpEnv(config.env),
    cwd: config.cwd,
  });

  const client = new McpClient(name, child, mcpRequestTimeout(config));

  try {
    await client.initialize();
    await client.listTools();
  } catch (err) {
    await client.close();
    throw new Error(
      `Failed to connect MCP server '${name}': ${(err as Error).message}`
    );
  }

  return client;
}

export async function callTool(
  connection: McpConnection,
  toolName: string,
  args: Record<string, any>
): Promise<McpCallResult> {
  return connection.call(toolName, args);
}

export async function disconnectMcpServer(connection: McpConnection): Promise<void> {
  await connection.close();
}

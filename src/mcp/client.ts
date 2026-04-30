import { spawn, type ChildProcess } from 'node:child_process';
import { setMaxListeners } from 'node:events';
import type {
  McpConnection,
  McpServerConfig,
  McpTool,
  McpCallResult,
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

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class McpClient implements McpConnection {
  name: string;
  process: ChildProcess;
  tools: McpTool[] = [];

  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private closed = false;

  constructor(name: string, proc: ChildProcess) {
    this.name = name;
    this.process = proc;

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
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`[mcp:${this.name}] invalid JSON line: ${line}\n`);
      return;
    }
    if (typeof msg.id !== 'number') {
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(
        new Error(`MCP '${this.name}' ${p.method} error: ${msg.error.message}`)
      );
    } else {
      p.resolve(msg.result);
    }
  }

  private send(obj: JsonRpcRequest | JsonRpcNotification): void {
    if (this.closed || !this.process.stdin || this.process.stdin.destroyed) {
      throw new Error(`MCP '${this.name}' stdin is closed`);
    }
    this.process.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method: string, params?: any, signal?: AbortSignal): Promise<any> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        reject(new Error(`MCP '${this.name}' ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      const wrappedResolve = (value: any) => {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const wrappedReject = (err: Error) => {
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
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new DOMException('aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, {
        resolve: wrappedResolve,
        reject: wrappedReject,
        timer,
        method,
      });
      try {
        this.send(req);
      } catch (err) {
        this.pending.delete(id);
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
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'my-agent', version: '1.0.0' },
    });
    try {
      this.notify('notifications/initialized');
    } catch {
      /* some servers do not require this */
    }
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request('tools/list', {});
    const raw = Array.isArray(result?.tools) ? result.tools : [];
    this.tools = raw.map((t: any) => ({
      name: String(t.name),
      description: String(t.description ?? ''),
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
    return this.tools;
  }

  async call(
    toolName: string,
    args: Record<string, any>,
    signal?: AbortSignal
  ): Promise<McpCallResult> {
    const result = await this.request(
      'tools/call',
      { name: toolName, arguments: args ?? {} },
      signal
    );
    const contentArr = Array.isArray(result?.content) ? result.content : [];
    const text = contentArr
      .map((c: any) => {
        if (typeof c?.text === 'string') return c.text;
        if (c?.type === 'text') return String(c.text ?? '');
        return JSON.stringify(c);
      })
      .join('\n');
    return {
      content: text,
      isError: Boolean(result?.isError),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP '${this.name}' connection closing`));
    }
    this.pending.clear();
    try {
      this.process.stdin?.end();
    } catch {
      /* ignore */
    }
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            this.process.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          resolve();
        }, 2000);
        this.process.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}

export async function connectMcpServer(
  name: string,
  config: McpServerConfig
): Promise<McpConnection> {
  const child = spawn(config.command, config.args ?? [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(config.env ?? {}) },
    cwd: config.cwd,
  });

  const client = new McpClient(name, child);

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

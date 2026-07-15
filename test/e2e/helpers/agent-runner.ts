import { bootstrap, shutdown } from '../../../src/index.js';
import type { AgentEvent } from '../../../src/agent/events.js';

export interface RunResult {
  events: AgentEvent[];
  finalText: string;
  toolCalls: Array<{ name: string; args: any; ok: boolean }>;
  apiCalls: number;
  elapsed: number;
}

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  configPath?: string;
}

export async function runAgent(
  userInput: string,
  opts: RunOptions = {}
): Promise<RunResult> {
  const timeout = opts.timeout ?? 180000;
  const originalCwd = process.cwd();
  if (opts.cwd) process.chdir(opts.cwd);

  const started = Date.now();
  const boot = await bootstrap(opts.configPath);
  const { agent, connections } = boot;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);

  const events: AgentEvent[] = [];
  const pendingTools = new Map<string, { name: string; args: any }>();
  const toolOrder: string[] = [];
  const toolCalls: Array<{ name: string; args: any; ok: boolean }> = [];
  const textParts: string[] = [];

  try {
    for await (const ev of agent.chat(userInput, ac.signal)) {
      events.push(ev);
      if (ev.type === 'tool:call') {
        const key = `${ev.name}:${toolOrder.length}`;
        toolOrder.push(key);
        pendingTools.set(key, { name: ev.name, args: ev.args });
      } else if (ev.type === 'tool:result') {
        const key = toolOrder.shift();
        if (key) {
          const p = pendingTools.get(key);
          pendingTools.delete(key);
          if (p) toolCalls.push({ name: p.name, args: p.args, ok: ev.ok });
        } else {
          toolCalls.push({ name: '<unknown>', args: {}, ok: ev.ok });
        }
      } else if (ev.type === 'token') {
        textParts.push(ev.text);
      } else if (ev.type === 'text') {
        textParts.push(ev.content);
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      await shutdown(connections, agent);
    } catch {}
    if (opts.cwd) process.chdir(originalCwd);
  }

  const finalText = textParts.join('');
  const apiCalls = events.filter(
    (e) => e.type === 'tool:call' || e.type === 'task:done'
  ).length;

  return {
    events,
    finalText,
    toolCalls,
    apiCalls,
    elapsed: Date.now() - started,
  };
}

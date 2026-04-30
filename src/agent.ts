import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionUserMessageParam,
} from 'openai/resources/chat/completions';
import type {
  Agent,
  AgentConfig,
  ArchivedMessage,
  ChatContent,
  McpConnection,
} from './mcp/types.js';
import { createTaskStack, type Task, type TaskStack } from './task-stack.js';
import type { AgentEvent } from './agent/events.js';
import {
  normalizeArguments,
  ensureToolCallId,
  normalizeToolCalls,
} from './agent/normalize.js';
import { compactToolResult } from './agent/compact.js';
import { classifyCommand, isWhitelisted } from './agent/dangerGuard.js';
import {
  STACK_STATE_PREFIX,
  renderStackState,
  removeLastStackStateMessage,
} from './agent/stack-render.js';
import { loadAgentMd } from './agent/memdir.js';
import { estimateTokens } from './agent/tokenCount.js';
import { summarizeRange } from './agent/summarize.js';
import { createTodoList } from './agent/todo.js';
import type { SessionStore } from './session/store.js';

export interface CreateAgentOptions {
  resumeMessages?: ChatCompletionMessageParam[];
  sessionStore?: SessionStore;
  sessionId?: string;
}

const TOOL_NAME_SEP = '__';
const DEFAULT_MAX_LOOPS = 200;
const CREATE_TASK_TOOL_NAME = 'create_task';
const DANGER_EXEC_TOOLS = new Set<string>([
  'exec-mcp__execute_command',
  'exec__execute_command',
]);

function extractCommand(args: Record<string, any>): string {
  if (!args) return '';
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  return '';
}

function isTtyInteractive(): boolean {
  return Boolean((process.stdin as any)?.isTTY);
}
const DEFAULT_CONTEXT_WINDOW = 32768;
const COMPACT_TRIGGER_RATIO = 0.75;
const COMPACT_KEEP_LAST_N = 6;
const COMPACT_MAX_FAILURES = 2;
const COMPACT_MIN_SUMMARY_CHARS = 50;

function findSafeCutIndex(
  messages: ChatCompletionMessageParam[],
  desiredCut: number
): number {
  let cut = Math.max(1, Math.min(desiredCut, messages.length));
  while (cut < messages.length && messages[cut].role === 'tool') {
    cut += 1;
  }
  return cut;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  delay = 1000
): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as any)?.status;
      if (i < retries && (status === 500 || status === 502 || status === 503)) {
        await new Promise((r) => setTimeout(r, delay * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

function cleanErrorMessage(msg: string): string {
  let clean = msg.replace(/<[^>]*>/g, '').trim();
  clean = clean.replace(/\s+/g, ' ');
  return clean.slice(0, 200) || 'unknown error';
}

const CREATE_TASK_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: CREATE_TASK_TOOL_NAME,
    description:
      '把子任务压栈，当前任务完成后再执行。只有复杂任务需要拆分时才调用，简单问答直接回答不要调。不要重复已在栈里的任务。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '子任务的完整指令，带上所需上下文。',
        },
        reason: {
          type: 'string',
          description: '为什么需要拆这个子任务（一句话）。',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
};

interface BuiltinToolContext {
  stack: TaskStack;
  currentTask: Task;
  todoList: ReturnType<typeof createTodoList>;
}

interface BuiltinTool {
  definition: ChatCompletionTool;
  handler: (
    args: Record<string, any>,
    ctx: BuiltinToolContext
  ) => { content: string; isError: boolean };
}

const builtinTools = new Map<string, BuiltinTool>();

builtinTools.set(CREATE_TASK_TOOL_NAME, {
  definition: CREATE_TASK_TOOL,
  handler: (args, ctx) => {
    const promptArg =
      typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const reasonArg =
      typeof args.reason === 'string' ? args.reason : undefined;
    if (!promptArg) {
      return {
        content: 'Error: create_task requires a non-empty "prompt"',
        isError: true,
      };
    }
    try {
      const newTask = ctx.stack.push({
        prompt: promptArg,
        reason: reasonArg,
        parentId: ctx.currentTask.id,
        messageAnchor: -1,
      });
      return {
        content: JSON.stringify({
          ok: true,
          taskId: newTask.id,
          stackSize: ctx.stack.size(),
        }),
        isError: false,
      };
    } catch (err) {
      return { content: `Error: ${(err as Error).message}`, isError: true };
    }
  },
});

const ASK_USER_PREFIX = '[ask_user] ';
const PLAN_OPEN = '[plan]\n';

builtinTools.set('ask_user', {
  definition: {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        '向用户提问以澄清需求。当任务描述不清楚、有多种理解方式、或需要用户确认时使用。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题' },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
  },
  handler: (args) => {
    const q = typeof args.question === 'string' ? args.question.trim() : '';
    if (!q) return { content: 'Error: question is required', isError: true };
    return { content: `${ASK_USER_PREFIX}${q}`, isError: false };
  },
});

builtinTools.set('todo_write', {
  definition: {
    type: 'function',
    function: {
      name: 'todo_write',
      description: '管理待办列表。用于规划工作步骤、跟踪进度。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'complete', 'remove', 'list'],
            description: '操作类型',
          },
          text: { type: 'string', description: 'add 时的待办内容' },
          id: { type: 'string', description: 'complete/remove 时的 ID' },
        },
        required: ['action'],
      },
    },
  },
  handler: (args, ctx) => {
    const action = typeof args.action === 'string' ? args.action : '';
    const todo = ctx.todoList;
    if (action === 'add') {
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text)
        return { content: 'Error: text is required for add', isError: true };
      const item = todo.add(text);
      return {
        content: `added ${item.id}\n\n${todo.format()}`,
        isError: false,
      };
    }
    if (action === 'complete') {
      const id = typeof args.id === 'string' ? args.id : '';
      if (!id)
        return { content: 'Error: id is required for complete', isError: true };
      const ok = todo.complete(id);
      if (!ok) return { content: `Error: todo ${id} not found`, isError: true };
      return { content: `completed ${id}\n\n${todo.format()}`, isError: false };
    }
    if (action === 'remove') {
      const id = typeof args.id === 'string' ? args.id : '';
      if (!id)
        return { content: 'Error: id is required for remove', isError: true };
      const ok = todo.remove(id);
      if (!ok) return { content: `Error: todo ${id} not found`, isError: true };
      return { content: `removed ${id}\n\n${todo.format()}`, isError: false };
    }
    if (action === 'list') {
      return { content: todo.format(), isError: false };
    }
    return { content: `Error: unknown action '${action}'`, isError: true };
  },
});

builtinTools.set('enter_plan_mode', {
  definition: {
    type: 'function',
    function: {
      name: 'enter_plan_mode',
      description:
        '进入方案模式。复杂任务开始前调用，输出方案让用户确认后再执行。',
      parameters: {
        type: 'object',
        properties: {
          plan: { type: 'string', description: '方案内容（Markdown 格式）' },
        },
        required: ['plan'],
      },
    },
  },
  handler: (args) => {
    const plan = typeof args.plan === 'string' ? args.plan.trim() : '';
    if (!plan) return { content: 'Error: plan is required', isError: true };
    return {
      content: `${PLAN_OPEN}${plan}\n[/plan]\n\n等待用户确认...`,
      isError: false,
    };
  },
});

function mcpToolsToOpenAI(connections: McpConnection[]): ChatCompletionTool[] {
  const out: ChatCompletionTool[] = [];
  for (const conn of connections) {
    for (const tool of conn.tools) {
      out.push({
        type: 'function',
        function: {
          name: `${conn.name}${TOOL_NAME_SEP}${tool.name}`,
          description: tool.description || tool.name,
          parameters:
            tool.inputSchema && typeof tool.inputSchema === 'object'
              ? (tool.inputSchema as Record<string, any>)
              : { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

function findToolSchema(
  connections: McpConnection[],
  fullName: string
): Record<string, any> | null {
  const sepIdx = fullName.indexOf(TOOL_NAME_SEP);
  if (sepIdx > 0) {
    const serverName = fullName.slice(0, sepIdx);
    const toolName = fullName.slice(sepIdx + TOOL_NAME_SEP.length);
    const conn = connections.find((c) => c.name === serverName);
    const tool = conn?.tools.find((t) => t.name === toolName);
    if (tool?.inputSchema) return tool.inputSchema as Record<string, any>;
  }
  for (const conn of connections) {
    const tool = conn.tools.find((t) => t.name === fullName);
    if (tool?.inputSchema) return tool.inputSchema as Record<string, any>;
  }
  return null;
}

function routeToolCall(
  connections: McpConnection[],
  fullName: string
): { conn: McpConnection; toolName: string } | null {
  // Try exact match with prefix (e.g. fs__list_directory)
  const sepIdx = fullName.indexOf(TOOL_NAME_SEP);
  if (sepIdx > 0) {
    const serverName = fullName.slice(0, sepIdx);
    const toolName = fullName.slice(sepIdx + TOOL_NAME_SEP.length);
    const conn = connections.find((c) => c.name === serverName);
    if (conn && conn.tools.some((t) => t.name === toolName)) {
      return { conn, toolName };
    }
  }
  // Fallback: model called tool without prefix (e.g. list_directory)
  for (const conn of connections) {
    const tool = conn.tools.find((t) => t.name === fullName);
    if (tool) return { conn, toolName: fullName };
  }
  return null;
}

export async function createAgent(
  config: AgentConfig,
  connections: McpConnection[],
  options: CreateAgentOptions = {}
): Promise<Agent> {
  const client = new OpenAI({
    baseURL: config.model.baseURL,
    apiKey: config.model.apiKey,
  });

  const mcpTools = mcpToolsToOpenAI(connections);
  const tools: ChatCompletionTool[] = [
    ...mcpTools,
    ...[...builtinTools.values()].map((b) => b.definition),
  ];
  const maxLoops = config.maxLoops ?? DEFAULT_MAX_LOOPS;
  const baseSystemPrompt =
    config.systemPrompt ??
    [
      'You are MA, a local CLI assistant. You help users with software engineering tasks using tools (execute commands, read/write files, search code).',
      '',
      '# How you work',
      '- ALWAYS think about what the user truly needs. If you don\'t understand, ask immediately. NEVER deviate from the real need just to complete the immediate task!!!',
      '- You are goal-driven. Tool calls are means, not ends.',
      '- Keep working until the user\'s goal is fully achieved.',
      '- Only stop when you have exhausted all approaches or the situation is truly unresolvable — then explain why.',
      '- Read before write: always read_file before modifying. Never guess file contents.',
      '- Investigate before answering: use tools to gather info before responding about a project.',
      '- On failure: diagnose the cause, try a different approach. Do not blindly retry the same thing.',
      '',
      '# Tool usage (critical)',
      '- Prefer dedicated tools over execute_command: read_file for reading, write_file for writing, file_edit for editing, grep for searching, list_directory for listing.',
      '- Use execute_command only for shell operations (install deps, run tests, git, etc.).',
      '- Always provide complete parameters: read_file needs path (e.g. ./package.json), list_directory uses . for cwd.',
      '- Call multiple independent tools in parallel for efficiency.',
      '- On tool error: read the error, try a different approach.',
      '',
      '# Output style',
      '- After using tools, give a complete answer based on results. Never call tools then stay silent.',
      '- Use Markdown formatting (headings, code blocks, lists).',
      '- No pleasantries, no filler phrases like "if you need anything else...".',
      '- Reply in the same language the user uses.',
      '',
      '# Code standards',
      '- Only change what is needed. Do not refactor unrelated code.',
      '- No unnecessary comments, type annotations, or error handling.',
      '- No speculative design for hypothetical future requirements.',
      '- Verify your work: run tests, check output. Never claim "should be fine" without evidence.',
      '',
      '# Safety',
      '- Confirm before destructive operations (delete files, force push, reset --hard).',
      '- Do not write code with security vulnerabilities (injection, XSS, etc.).',
      '- Do not expose internal state (task stack, system messages) to the user.',
    ].join('\n');
  const cwd = process.cwd();
  const agentMd = loadAgentMd(cwd);
  const envInfo = `\n\n# Environment\n当前工作目录: ${cwd}\n平台: ${process.platform}\nNode: ${process.version}`;
  const systemPrompt = agentMd
    ? `${baseSystemPrompt}${envInfo}\n\n# Project Context\n${agentMd}`
    : `${baseSystemPrompt}${envInfo}`;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];
  if (options.resumeMessages && options.resumeMessages.length > 0) {
    for (const m of options.resumeMessages) {
      if (m.role === 'system') continue;
      messages.push(m);
    }
  }
  const sessionStore = options.sessionStore;
  const sessionId = options.sessionId;
  let persistedCount = messages.length;

  function persistPending(): void {
    if (!sessionStore || !sessionId) {
      persistedCount = messages.length;
      return;
    }
    for (let i = persistedCount; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'system') continue;
      try {
        sessionStore.append(sessionId, m);
      } catch {
        /* ignore persist failures */
      }
    }
    persistedCount = messages.length;
  }

  const stack = createTaskStack();
  const todoList = createTodoList();
  const taskArchive = new Map<string, ChatCompletionMessageParam[]>();
  const pendingConfirms = new Map<string, (approved: boolean) => void>();
  let confirmCounter = 0;
  const nextConfirmId = () => `cf_${++confirmCounter}`;

  function respondConfirm(requestId: string, approved: boolean): void {
    const resolver = pendingConfirms.get(requestId);
    if (!resolver) return;
    pendingConfirms.delete(requestId);
    resolver(approved);
  }

  function awaitConfirm(
    requestId: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      pendingConfirms.set(requestId, resolve);
      if (signal) {
        const onAbort = () => {
          if (pendingConfirms.delete(requestId)) resolve(false);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
  const contextWindow = config.model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const compactThreshold = Math.floor(contextWindow * COMPACT_TRIGGER_RATIO);
  let compactFailures = 0;
  let compactDisabled = false;

  async function maybeCompact(
    signal?: AbortSignal,
    fallbackUserContent?: string
  ): Promise<{ compacted: boolean; freed: number }> {
    if (compactDisabled) return { compacted: false, freed: 0 };
    const before = estimateTokens(messages);
    if (before <= compactThreshold) return { compacted: false, freed: 0 };

    const keepLastN = Math.min(COMPACT_KEEP_LAST_N, messages.length - 1);
    const desiredCut = messages.length - keepLastN;
    const cut = findSafeCutIndex(messages, desiredCut);
    if (cut <= 1 || cut >= messages.length) return { compacted: false, freed: 0 };

    const middle = messages.slice(1, cut);
    if (middle.length === 0) return { compacted: false, freed: 0 };

    try {
      const summary = await summarizeRange(
        client,
        config.model.model,
        middle,
        signal
      );
      if (!summary || summary.length < COMPACT_MIN_SUMMARY_CHARS) {
        compactFailures += 1;
        if (compactFailures >= COMPACT_MAX_FAILURES) compactDisabled = true;
        return { compacted: false, freed: 0 };
      }
      messages.splice(1, cut - 1, {
        role: 'system',
        content: `[compact summary]\n${summary}`,
      });

      // Safety: ensure at least one user message remains after compact.
      // Without this, Qwen3 jinja templates throw "No user query found in messages".
      const hasUser = messages.some((m) => m.role === 'user');
      if (!hasUser && fallbackUserContent) {
        const userContent = fallbackUserContent.slice(0, 200);
        // Insert right after the summary (index 2) to maintain message order
        messages.splice(2, 0, { role: 'user', content: userContent });
      }

      compactFailures = 0;
      const after = estimateTokens(messages);
      return { compacted: true, freed: Math.max(0, before - after) };
    } catch {
      compactFailures += 1;
      if (compactFailures >= COMPACT_MAX_FAILURES) compactDisabled = true;
      return { compacted: false, freed: 0 };
    }
  }

  function foldMessages(anchor: number, taskId: string, summary: string): void {
    if (anchor < 0 || anchor > messages.length) return;
    const folded = messages.splice(anchor);
    taskArchive.set(taskId, folded);
    // Preserve user question in summary for context continuity
    const userMsg = folded.find(m => m.role === 'user');
    const userQ = userMsg && typeof userMsg.content === 'string' ? userMsg.content : '';
    const foldSummary = userQ
      ? `[conversation] User asked: "${userQ.slice(0, 100)}" → ${summary || '(no answer)'}`
      : `[stack:completed ${taskId}] Summary: ${summary}`;
    messages.push({ role: 'system', content: foldSummary });
    persistedCount = messages.length;
  }

  async function* runTask(
    task: Task,
    rootUserMessage: ChatContent,
    signal?: AbortSignal
  ): AsyncGenerator<AgentEvent, { text: string; hitMaxLoops: boolean }, unknown> {
    const errorHistory = new Map<string, number>();
    const MAX_SAME_ERROR = 2;

    let openingContent: ChatCompletionUserMessageParam['content'];
    if (task.parentId) {
      openingContent = `（子任务）${task.prompt}`;
    } else if (typeof rootUserMessage === 'string') {
      openingContent = rootUserMessage;
    } else {
      openingContent = rootUserMessage as unknown as ChatCompletionUserMessageParam['content'];
    }
    messages.push({ role: 'user', content: openingContent });
    persistPending();

    let finalText = '';
    let emptyArgsRetries = 0;
    let tempOverride: number | undefined;

    for (let loop = 0; loop < maxLoops; loop++) {
      // Warn agent when approaching loop limit by appending to system prompt
      const remaining = maxLoops - loop;
      let loopWarning = '';
      if (remaining === 5) {
        loopWarning = `\n\n[WARNING] You have only 5 loops remaining (${loop}/${maxLoops} used). If you are stuck in a loop, stop and summarize what you have done so far. If you still need more steps to complete the task, continue working.`;
      }

      const compactResult = await maybeCompact(signal, task.prompt);
      if (compactResult.compacted) {
        yield { type: 'compact:done', freed: compactResult.freed };
      }

      const stateStr = renderStackState(stack);
      const suffix = (stateStr || '') + loopWarning;
      const requestMessages = suffix
        ? [{ ...messages[0], content: (messages[0] as any).content + '\n' + suffix }, ...messages.slice(1)]
        : [...messages];

      const request: Parameters<typeof client.chat.completions.create>[0] = {
        model: config.model.model,
        messages: requestMessages,
        temperature: tempOverride ?? config.model.temperature ?? 0.6,
        frequency_penalty: tempOverride !== undefined ? 0 : (config.model.frequencyPenalty ?? 1.1),
        ...(config.model.maxTokens ? { max_tokens: config.model.maxTokens } : {}),
      };
      if (tools.length > 0) {
        request.tools = tools;
        request.tool_choice = 'auto';
      }

      // Debug: dump messages before API call
      // Always log API requests for debugging
      try {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const logFile = process.env.MA_DEBUG || path.join(os.homedir(), '.my-agent', 'api-debug.log');
        const dbg = requestMessages.map((m: any) => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 200) : m.content, tool_calls: m.tool_calls?.length, tool_call_id: m.tool_call_id }));
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] API REQUEST messages (${requestMessages.length}):\n${JSON.stringify(dbg, null, 2)}\n\n`);
      } catch { /* ignore */ }

      let stream;
      try {
        stream = await withRetry(() =>
          client.chat.completions.create(
            { ...request, stream: true },
            { signal }
          )
        );
      } catch (retryErr) {
        const status = (retryErr as any)?.status;
        if (status === 500 && messages.length > 4) {
          // 500 after retries — truncate preserving system(0) + first user + last N
          const keep = Math.max(4, Math.floor(messages.length / 2));
          const firstUserIdx = messages.findIndex(
            (m, i) => i > 0 && m.role === 'user'
          );
          const tailStart = Math.max(
            firstUserIdx > 0 ? firstUserIdx + 1 : 1,
            messages.length - keep
          );
          const originalLen = messages.length;
          const newMessages: ChatCompletionMessageParam[] = [messages[0]];
          if (firstUserIdx > 1) {
            newMessages.push({
              role: 'system',
              content: '[context truncated due to server error]',
            });
          }
          if (firstUserIdx > 0) {
            newMessages.push(messages[firstUserIdx]);
          }
          for (let i = tailStart; i < originalLen; i++) {
            newMessages.push(messages[i]);
          }
          messages.length = 0;
          messages.push(...newMessages);

          const stateStr2 = renderStackState(stack);
          request.messages = stateStr2
            ? [{ ...messages[0], content: (messages[0] as any).content + '\n' + stateStr2 }, ...messages.slice(1)]
            : messages;
          stream = await client.chat.completions.create(
            { ...request, stream: true },
            { signal }
          );
        } else {
          throw retryErr;
        }
      }

      let contentBuf = '';
      const toolAcc = new Map<
        number,
        { id: string; name: string; argsBuf: string }
      >();

      let isThinking = false;
      let thinkingViaReasoning = false;
      let thinkingStartTime = 0;

      for await (const chunk of stream as any) {
        const delta = chunk?.choices?.[0]?.delta;
        if (!delta) continue;

        // Handle reasoning_content field (Qwen/Gemma thinking mode)
        if (typeof (delta as any).reasoning_content === 'string' && (delta as any).reasoning_content.length > 0) {
          if (!isThinking) {
            isThinking = true;
            thinkingViaReasoning = true;
            thinkingStartTime = Date.now();
            yield { type: 'thinking:start' };
          }
          continue;
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          // If thinking was started via reasoning_content, content appearing means thinking ended
          if (isThinking && thinkingViaReasoning) {
            isThinking = false;
            thinkingViaReasoning = false;
            yield { type: 'thinking:end', durationMs: Date.now() - thinkingStartTime };
          }

          let text = delta.content;

          // Simple thinking token filter (strip inline markers for Gemma)
          if (text.includes('<|channel>thought') || text.includes('<think>')) {
            if (!isThinking) {
              isThinking = true;
              thinkingStartTime = Date.now();
              yield { type: 'thinking:start' };
            }
            text = text.replace(/<\|channel>thought/g, '').replace(/<think>/g, '');
          }
          if (text.includes('<channel|>') || text.includes('</think>')) {
            text = text.replace(/<channel\|>/g, '').replace(/<\/think>/g, '');
            if (isThinking) {
              isThinking = false;
              yield { type: 'thinking:end', durationMs: Date.now() - thinkingStartTime };
            }
          }

          // If currently thinking, skip content
          if (isThinking) continue;

          // Emit non-empty content
          if (text.length > 0) {
            contentBuf += text;
            yield { type: 'token', text };
          }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            let cur = toolAcc.get(idx);
            if (!cur) {
              cur = { id: '', name: '', argsBuf: '' };
              toolAcc.set(idx, cur);
            }
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.argsBuf += tc.function.arguments;
          }
        }
      }

      // Close unclosed thinking state
      if (isThinking) {
        isThinking = false;
        yield { type: 'thinking:end', durationMs: Date.now() - thinkingStartTime };
      }

      const assembled = [...toolAcc.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, v]) => ({
          id: v.id,
          type: 'function' as const,
          function: { name: v.name, arguments: v.argsBuf },
        }));
      const toolCalls = normalizeToolCalls(assembled);

      if (!toolCalls) {
        // If content is empty/whitespace after tool use, nudge model to answer
        if (contentBuf.trim().length === 0 && loop > 0) {
          messages.push({ role: 'assistant', content: contentBuf });
          messages.push({ role: 'user', content: 'Please provide your answer based on the tool results above.' });
          persistPending();
          continue; // one more loop to get actual answer
        }
        messages.push({ role: 'assistant', content: contentBuf });
        persistPending();
        finalText = contentBuf;
        return { text: finalText, hitMaxLoops: false };
      }

      messages.push({
        role: 'assistant',
        content: contentBuf.trim() || '',
        tool_calls: toolCalls,
      });

      // P0-b: If ALL tool_calls have empty args, pop the assistant message and retry
      // with lower temperature. Don't let model see its own empty-args history.
      const allEmpty = toolCalls.every((tc) => {
        const a = normalizeArguments(tc.function.arguments);
        return Object.keys(a).length === 0;
      });
      if (allEmpty && emptyArgsRetries < 2) {
        emptyArgsRetries += 1;
        messages.pop(); // remove the assistant message with empty tool_calls
        tempOverride = 0.1; // force low temperature for next request
        continue; // re-enter loop without incrementing any error state
      }
      emptyArgsRetries = 0;
      tempOverride = undefined;

      for (const tc of toolCalls) {
        const fullName = tc.function.name;
        const args = normalizeArguments(tc.function.arguments);

        const callKey = `${fullName}:${JSON.stringify(args)}`;
        const prevErrors = errorHistory.get(callKey) || 0;
        if (prevErrors >= MAX_SAME_ERROR) {
          const blockedResult = `已尝试 ${prevErrors} 次均失败，请换个路径或方式。`;
          yield { type: 'tool:call', name: fullName, args };
          yield { type: 'tool:result', ok: false, content: blockedResult };
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: blockedResult,
          });
          continue;
        }

        yield { type: 'tool:call', name: fullName, args };

        let toolResult = '';
        let isError = false;
        let skipExecute = false;

        if (DANGER_EXEC_TOOLS.has(fullName)) {
          const cmd = extractCommand(args);
          const mode = config.danger?.mode ?? 'confirm';
          if (cmd && mode !== 'off') {
            const allow = config.danger?.allow;
            const result = classifyCommand(cmd);
            if (result.dangerous && !isWhitelisted(cmd, allow)) {
              const reason = result.reason ?? 'dangerous command';
              if (mode === 'deny' || !isTtyInteractive()) {
                toolResult = `[blocked] ${reason}`;
                isError = true;
                skipExecute = true;
              } else {
                const requestId = nextConfirmId();
                yield {
                  type: 'tool:confirm',
                  requestId,
                  cmd,
                  reason,
                };
                const approved = await awaitConfirm(requestId, signal);
                if (!approved) {
                  toolResult = `[user denied] ${reason}`;
                  isError = true;
                  skipExecute = true;
                }
              }
            }
          }
        }

        if (!skipExecute) {
          const builtin = builtinTools.get(fullName);
          if (builtin) {
            const r = builtin.handler(args, {
              stack,
              currentTask: task,
              todoList,
            });
            toolResult = r.content;
            isError = r.isError;
            if (!isError && fullName === 'ask_user') {
              yield {
                type: 'ask_user',
                question: toolResult.slice(ASK_USER_PREFIX.length),
              };
            } else if (!isError && fullName === 'enter_plan_mode') {
              const planArg =
                typeof args.plan === 'string' ? args.plan.trim() : '';
              yield { type: 'plan', content: planArg };
            }
          } else {
            const route = routeToolCall(connections, fullName);
            if (!route) {
              toolResult = `Error: unknown tool '${fullName}'`;
              isError = true;
            } else {
              try {
                const r = await route.conn.call(route.toolName, args, signal);
                toolResult = r.content;
                isError = r.isError;
              } catch (err) {
                toolResult = `Error: ${(err as Error).message}`;
                isError = true;
              }
            }
          }
        }

        const short =
          toolResult.length > 400 ? toolResult.slice(0, 400) + '...' : toolResult;
        yield { type: 'tool:result', ok: !isError, content: short };
        const compacted = compactToolResult(toolResult);
        if (compacted.startsWith('data:image/')) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: [{ type: 'image_url', image_url: { url: compacted } }] as any,
          });
        } else {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: compacted,
          });
        }

        if (isError) {
          const newCount = prevErrors + 1;
          errorHistory.set(callKey, newCount);
        } else {
          errorHistory.delete(callKey);
        }
      }
      persistPending();
    }

    const stop = `[agent] task [${task.id}] reached max loop count (${maxLoops}), aborting`;
    messages.push({ role: 'assistant', content: stop });
    persistPending();
    yield { type: 'text', content: stop };
    finalText = stop;
    return { text: finalText, hitMaxLoops: true };
  }

  async function* chat(
    userMessage: ChatContent,
    signal?: AbortSignal
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const rootPromptText =
      typeof userMessage === 'string'
        ? userMessage
        : (userMessage.find((p) => p.type === 'text') as
            | { type: 'text'; text: string }
            | undefined)?.text || '[图片]';
    try {
      stack.push({
        prompt: rootPromptText,
        messageAnchor: -1,
      });
    } catch (err) {
      yield {
        type: 'text',
        content: `[agent] failed to push root task: ${(err as Error).message}`,
      };
      return;
    }

    outer: while (stack.size() > 0) {
      if (signal?.aborted) break;

      const task = stack.pop();
      if (!task) break;

      task.messageAnchor = messages.length;

      yield { type: 'task:start', taskId: task.id, prompt: task.prompt };

      let taskText = '';
      let hitMaxLoops = false;
      let failed = false;
      let failMessage = '';
      let aborted = false;

      try {
        const gen = runTask(task, userMessage, signal);
        while (true) {
          const { value, done } = await gen.next();
          if (done) {
            const result = value ?? { text: '', hitMaxLoops: false };
            taskText = result.text ?? '';
            hitMaxLoops = result.hitMaxLoops === true;
            break;
          }
          yield value as AgentEvent;
        }
      } catch (err) {
        const name = (err as any)?.name;
        if (signal?.aborted || name === 'AbortError') {
          aborted = true;
        } else {
          failed = true;
          failMessage = (err as Error).message;
        }
      }

      if (aborted) {
        stack.markFailed(task.id, 'aborted');
        foldMessages(task.messageAnchor, task.id, 'ABORTED');
        yield { type: 'task:aborted', taskId: task.id };
        yield { type: 'aborted' };
        stack.abortAll();
        break outer;
      }

      if (failed) {
        const cleanError = cleanErrorMessage(failMessage);
        stack.markFailed(task.id, cleanError);
        foldMessages(
          task.messageAnchor,
          task.id,
          `FAILED: ${cleanError}`
        );
        yield { type: 'task:failed', taskId: task.id, error: cleanError };
      } else if (hitMaxLoops) {
        stack.markFailed(task.id, taskText);
        foldMessages(task.messageAnchor, task.id, taskText);
        yield { type: 'task:failed', taskId: task.id, error: 'max loops' };
      } else {
        stack.markDone(task.id, taskText);
        foldMessages(task.messageAnchor, task.id, taskText || '(no output)');
        const next = stack.peek();
        yield {
          type: 'task:done',
          taskId: task.id,
          next: next ? next.id : undefined,
        };
      }
    }

    removeLastStackStateMessage(messages);
  }

  function reset(): void {
    messages.length = 0;
    messages.push({ role: 'system', content: systemPrompt });
    persistedCount = messages.length;
    stack.clear();
    taskArchive.clear();
  }

  function getTaskStack(): TaskStack {
    return stack;
  }

  function getArchive(taskId: string): ArchivedMessage[] | null {
    const arr = taskArchive.get(taskId);
    if (!arr) return null;
    return arr.slice() as unknown as ArchivedMessage[];
  }

  function abortAll(): number {
    return stack.abortAll();
  }

  function getContextUsage(): { used: number; total: number } {
    return {
      used: estimateTokens(messages),
      total: config.model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    };
  }

  return { chat, reset, getTaskStack, getArchive, abortAll, respondConfirm, getContextUsage };
}

export const __internal__ = {
  mcpToolsToOpenAI,
  routeToolCall,
  normalizeArguments,
  ensureToolCallId,
  normalizeToolCalls,
  renderStackState,
  removeLastStackStateMessage,
  compactToolResult,
  CREATE_TASK_TOOL,
  STACK_STATE_PREFIX,
};

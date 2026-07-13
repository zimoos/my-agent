import type {
  ChatCompletionCreateParamsStreaming,
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
} from './agent/stack-render.js';
import { MessageStore } from './agent/message-store.js';
import {
  DEFAULT_REQUEST_ENVELOPE_RESERVE_BYTES,
  RequestContextBuilder,
  RequestContextOverflowError,
  type RequestContextBuildResult,
} from './agent/request-context-builder.js';
import { estimateSerializedBytes } from './agent/tokenCount.js';
import { ErrorTracker } from './agent/error-tracker.js';
import { StreamParser } from './agent/stream-parser.js';
import { ToolCallRepair } from './agent/tool-repair.js';
import { ToolExecutor } from './agent/tool-executor.js';
import { findToolSchema, mcpToolFunctionName, routeToolCall } from './agent/tool-router.js';
import { resolveProviderCodec } from './provider/detect.js';
import {
  createProviderRuntime,
  type ProviderRuntimeEvent,
} from './provider/runtime.js';
import type { AgoraMemoryController } from './provider/agora.js';
import { DEFAULT_CONTEXT_WINDOW, resolveModelCapabilities } from './provider/capabilities.js';
import { loadAgentMd } from './agent/memdir.js';
import { createTodoList } from './agent/todo.js';
import {
  collectWorkspaceSnapshot,
  diffWorkspaceSnapshots,
} from './agent/workspace-diff.js';
import { prefixHash } from './agent/prefix-hash.js';
import type { SessionStore } from './session/store.js';
import {
  createContextManager,
  type ContextManager,
} from './agent/context-manager.js';
import { RuntimeContextSlotStore } from './agent/runtime-context-slots.js';
import { CompletionObligationAudit } from './agent/completion-obligations.js';
import { FileReadLedger } from './agent/file-read-ledger.js';
import { join } from 'node:path';

export interface CreateAgentOptions {
  resumeMessages?: ChatCompletionMessageParam[];
  sessionStore?: SessionStore;
  sessionId?: string;
}

const DEFAULT_MAX_LOOPS = 500;
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

const COMPACT_TRIGGER_RATIO = 0.75;
const PROGRESS_TOOL_STREAK = 4;
const PROGRESS_IDLE_MS = 10_000;
const MAX_AUTOMATIC_LENGTH_CONTINUATIONS = 8;
const CONTINUATION_NUDGE_PREFIX = '[MA internal continuation request]';

interface ContextUsageSnapshot {
  used: number;
  total: number;
  compactThreshold: number;
  source: string;
}

interface ToolProgressRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  preview: string;
}

interface TaskDiagnostics {
  recentTools: ToolProgressRecord[];
  totalTools: number;
  lastContext?: ContextUsageSnapshot;
}

interface MissingActionEvidence {
  tool: string;
  toolCallId: string;
  operation: string;
  status: 'missing' | 'failed';
}

interface TaskRunResult {
  text: string;
  hitMaxLoops: boolean;
  missingEvidence?: MissingActionEvidence[];
  completionObligationFailure?: string;
}

function buildMissingEvidenceFailure(items: MissingActionEvidence[]): string {
  const calls = items
    .map((item) =>
      `${item.tool} (${item.toolCallId}, operation=${item.operation}, final=${item.status})`
    )
    .join(', ');
  return [
    `missing_evidence: cannot complete this action task because the latest attempt for ${calls} did not produce a successful verified result.`,
    'Re-run the action with an MCP tool that returns structuredContent["my-agent/evidence"] containing a non-empty operation and status="verified".',
  ].join(' ');
}

function cleanErrorMessage(msg: string): string {
  let clean = msg.replace(/<[^>]*>/g, '').trim();
  clean = clean.replace(/\s+/g, ' ');
  return clean.slice(0, 200) || 'unknown error';
}

function compactArgSummary(args: Record<string, unknown>): string {
  for (const key of ['path', 'file', 'filePath', 'directory', 'dir_path', 'cwd', 'cmd', 'command']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      const text = value.trim().replace(/\s+/g, ' ');
      return text.length > 80 ? ` ${text.slice(0, 77)}...` : ` ${text}`;
    }
  }
  return '';
}

function normalizeContinuationText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function isLikelyContinuationRepeat(previous: string, current: string): boolean {
  const prev = normalizeContinuationText(previous);
  const cur = normalizeContinuationText(current);
  if (prev.length < 48 || cur.length < 48) return false;

  const curPrefix = cur.slice(0, Math.min(180, cur.length));
  if (curPrefix.length >= 48 && prev.includes(curPrefix)) return true;

  const prevPrefix = prev.slice(0, Math.min(180, prev.length));
  const shared = commonPrefixLength(prevPrefix, curPrefix);
  return shared >= Math.min(100, Math.floor(Math.min(prevPrefix.length, curPrefix.length) * 0.8));
}

function buildContinuationNudge(previous: string): string {
  const normalized = previous.trim();
  const tail = normalized.slice(Math.max(0, normalized.length - 800));
  return [
    CONTINUATION_NUDGE_PREFIX,
    'The previous assistant response was cut off by the output token limit.',
    'Continue exactly from the cutoff point. Do not repeat earlier sentences, headings, preambles, plans, or tool results.',
    'If the task is complete, finish with the remaining concise conclusion only.',
    'Last visible tail:',
    tail,
  ].join('\n');
}

function buildImmediateToolNudge(previous: string): string {
  const normalized = previous.trim();
  const tail = normalized.slice(Math.max(0, normalized.length - 800));
  return [
    '[MA internal action request]',
    'Your previous response was cut off while describing an unfinished action, but it did not include a tool call.',
    'Do not continue the plan or explain the next step. Call exactly one appropriate tool now to make concrete progress.',
    'For a large file or long operation, perform the first safe part with a tool and continue in later turns.',
    'Last visible tail:',
    tail,
  ].join('\n');
}

function compactResultPreview(content: string): string {
  const oneLine = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  return oneLine.length > 90 ? `${oneLine.slice(0, 87)}...` : oneLine;
}

function buildProgressMessage(records: ToolProgressRecord[], totalTools: number): string {
  const recent = records.slice(-3).map((item) => {
    const arg = compactArgSummary(item.args);
    const status = item.ok ? '完成' : '失败';
    const preview = item.preview ? `：${item.preview}` : '';
    return `${item.name}${arg} ${status}${preview}`;
  });
  return `已执行 ${totalTools} 个工具调用，最近：${recent.join('；')}。继续基于这些结果推进。`;
}

function failureNextStep(error: string): string {
  if (/request context is too large|request body|bytes|images?/i.test(error)) {
    return '请减少本轮图片数量，或压缩图片后重试；已完成的工具结果和历史记录仍会保留。';
  }
  if (/context|compact|compaction|上下文/i.test(error)) {
    return '建议先减少本轮活跃上下文、扩大模型 contextWindow，或检查压缩策略是否能移出非关键工具结果。';
  }
  if (/timeout|retry|network|provider|abort/i.test(error)) {
    return '建议先确认 provider 可用性、超时/重试配置和当前网络状态，再重新执行同一任务。';
  }
  if (/max\s*loops?|最大循环/i.test(error)) {
    return '建议缩小任务范围，检查是否存在重复工具调用或缺少停止条件。';
  }
  return '建议根据失败点缩小复现输入，保留当前工具结果后继续定位。';
}

function buildFailureSummary(
  error: string,
  diagnostics: TaskDiagnostics
): string {
  const done = diagnostics.totalTools > 0
    ? buildProgressMessage(diagnostics.recentTools, diagnostics.totalTools).replace(/。继续基于这些结果推进。$/, '')
    : '尚未完成可记录的工具调用';
  const ctx = diagnostics.lastContext
    ? `当前上下文约 ${diagnostics.lastContext.used}/${diagnostics.lastContext.compactThreshold} tokens（窗口 ${diagnostics.lastContext.total}，来源 ${diagnostics.lastContext.source}）。`
    : '';
  return [
    '[失败总结]',
    `已完成：${done}。${ctx}`,
    `失败点：${error}`,
    `下一步：${failureNextStep(error)}`,
  ].filter(Boolean).join('\n');
}

function providerEventToAgentEvent(event: ProviderRuntimeEvent): AgentEvent {
  if (event.type === 'progress') {
    return {
      type: 'provider:progress',
      provider: event.provider,
      phase: event.phase,
      message: event.message,
      progress: event.progress,
      total: event.total,
    };
  }
  if (event.type === 'attempt') {
    return {
      type: 'provider:attempt',
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      timeoutMs: event.timeoutMs,
      stream: event.stream,
    };
  }
  return {
    type: 'provider:retry',
    attempt: event.attempt,
    nextAttempt: event.nextAttempt,
    retriesLeft: event.retriesLeft,
    maxRetries: event.maxRetries,
    delayMs: event.delayMs,
    error: cleanErrorMessage(event.error),
    stream: event.stream,
  };
}

async function* drainProviderEvents<T>(
  factory: (
    onProviderEvent: (event: ProviderRuntimeEvent) => void
  ) => AsyncGenerator<AgentEvent, T, unknown>
): AsyncGenerator<AgentEvent, T, unknown> {
  type QueueItem =
    | { kind: 'event'; event: AgentEvent }
    | { kind: 'done'; value: T }
    | { kind: 'error'; error: unknown };

  const queue: QueueItem[] = [];
  let wake: (() => void) | null = null;
  const push = (item: QueueItem) => {
    queue.push(item);
    if (wake) {
      wake();
      wake = null;
    }
  };

  void (async () => {
    try {
      const gen = factory((event) =>
        push({ kind: 'event', event: providerEventToAgentEvent(event) })
      );
      while (true) {
        const next = await gen.next();
        if (next.done) {
          push({ kind: 'done', value: next.value });
          return;
        }
        push({ kind: 'event', event: next.value });
      }
    } catch (err) {
      push({ kind: 'error', error: err });
    }
  })();

  while (true) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    const item = queue.shift();
    if (!item) continue;
    if (item.kind === 'event') {
      yield item.event;
      continue;
    }
    if (item.kind === 'done') return item.value;
    throw item.error;
  }
}

async function appendDebugLog(content: string): Promise<void> {
  try {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const logFile = process.env.MA_DEBUG || path.join(os.homedir(), '.my-agent', 'api-debug.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${content}\n`);
  } catch {
    /* ignore debug log failures */
  }
}

function textFromChatContent(content: ChatContent): string {
  if (typeof content === 'string') return content;
  const text = content.find((p) => p.type === 'text');
  return text?.type === 'text' ? text.text : '';
}

function mentionsConcreteFileOrPath(text: string): boolean {
  return /(?:^|[\s"'`(])(?:\.{0,2}\/)?[\w@.-]+\/[\w@./-]+/.test(text) ||
    /\b[\w@.-]+\.(?:js|jsx|ts|tsx|json|md|txt|ya?ml|css|html|mjs|cjs)\b/i.test(text) ||
    /\b(?:README|package\.json|src|test|tests|docs|config\.json)\b/i.test(text);
}

function recentHistoryMentionsFile(messages: ChatCompletionMessageParam[]): boolean {
  return messages.some((m) => {
    if (m.role !== 'user') return false;
    const content = typeof m.content === 'string' ? m.content : '';
    return mentionsConcreteFileOrPath(content);
  });
}

function clarificationForAmbiguousPrompt(
  prompt: string,
  priorMessages: ChatCompletionMessageParam[],
): string | null {
  const trimmed = prompt.trim();
  if (!trimmed) return null;

  if (
    /(?:刚才|之前|上面|那个|这个).{0,12}(?:文件|路径)/.test(trimmed) &&
    !mentionsConcreteFileOrPath(trimmed) &&
    !recentHistoryMentionsFile(priorMessages)
  ) {
    return '我还不知道你指的是哪个文件。请提供具体文件路径或文件名，我再继续读取。';
  }

  const vagueProductionConfig =
    /(?:配置|config|设置).{0,12}(?:线上|生产|production|prod)|(?:线上|生产|production|prod).{0,12}(?:配置|config|设置)/i;
  const mutatingIntent = /(?:帮我|请|把|将|改|修改|调整|配置|make|change|update|set)/i;
  if (
    vagueProductionConfig.test(trimmed) &&
    mutatingIntent.test(trimmed) &&
    !mentionsConcreteFileOrPath(trimmed) &&
    !/[=:=]\s*[\w./:-]+/.test(trimmed)
  ) {
    return '这条需求还缺少关键信息：请提供要改的配置文件、线上环境的目标值，以及是否有不能改的范围？确认后我再动手。';
  }

  return null;
}

function userAskedForConcreteToolWork(prompt: string): boolean {
  return /(?:读|读取|查看|列出|搜索|搜|grep|执行|运行|统计|创建|写|写入|修改|编辑|替换|修复|实现|测试|read|list|search|grep|run|execute|count|create|write|edit|replace|fix|implement|test)/i.test(prompt);
}

function looksLikeVerbalToolIntent(text: string): boolean {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return false;
  if (/[?？]|请(?:提供|确认|告诉)|需要(?:你|确认|提供)|无法|不能|不存在|没有找到/.test(compact)) {
    return false;
  }
  if (/(?:结果|如下|内容|已经|已完成|完成|找到|共有|共\s*\d+|输出|行数)/.test(compact)) {
    return false;
  }
  const chineseIntent = /(?:我|让我|好的，我|接下来|现在).{0,12}(?:先|来|会|去|准备|继续|再)?\s*(?:读|读取|查看|列|列出|搜索|搜|执行|运行|统计|创建|写|写入|修改|编辑|替换|修复|实现|检查)/.test(compact);
  const englishIntent = /(?:i(?:'ll| will| need to)|let me|now i|next i).{0,40}\b(?:read|list|search|run|execute|count|create|write|edit|replace|fix|implement|check|verify)\b/i.test(compact);
  return chineseIntent || englishIntent;
}

function getRequiredArgs(
  tools: ChatCompletionTool[],
  name: string
): string[] {
  const tool = tools.find((t) => t.function.name === name);
  const required = (tool?.function.parameters as any)?.required;
  return Array.isArray(required)
    ? required.filter((arg): arg is string => typeof arg === 'string')
    : [];
}

function missingRequiredArgs(
  tools: ChatCompletionTool[],
  name: string,
  args: Record<string, any>
): string[] {
  return getRequiredArgs(tools, name).filter((arg) => {
    const value = args[arg];
    return (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim().length === 0)
    );
  });
}

function shouldRetryEmptyArguments(
  tools: ChatCompletionTool[],
  name: string
): boolean {
  return getRequiredArgs(tools, name).length > 0;
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
  contextManager: ContextManager;
}

interface BuiltinTool {
  definition: ChatCompletionTool;
  handler: (
    args: Record<string, any>,
    ctx: BuiltinToolContext
  ) => { content: string; isError: boolean } | Promise<{ content: string; isError: boolean }>;
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

function isMutatingTool(name: string): boolean {
  // Exec commands and write/edit/delete tools should never be storm-suppressed
  if (DANGER_EXEC_TOOLS.has(name)) return true;
  const lower = name.toLowerCase();
  return /_(write|edit|delete|create|remove|move|rename)_/.test('_' + lower + '_');
}

function isStormExemptTool(name: string): boolean {
  // ask_user and enter_plan_mode are always intentional — don't suppress
  return name === 'ask_user' || name === 'enter_plan_mode';
}

function mcpToolsToOpenAI(connections: McpConnection[]): ChatCompletionTool[] {
  const out: ChatCompletionTool[] = [];
  for (const conn of connections) {
    for (const tool of conn.tools) {
      out.push({
        type: 'function',
        function: {
          name: mcpToolFunctionName(conn.name, tool.name),
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

export async function createAgent(
  config: AgentConfig,
  connections: McpConnection[],
  options: CreateAgentOptions = {}
): Promise<Agent> {
  const cwd = process.cwd();
  const providerRuntime = createProviderRuntime(config.model, undefined, {
    sessionId: options.sessionId,
    cwd,
  });
  await providerRuntime.ready?.();
  const providerCodec = resolveProviderCodec(config.model);

  const agoraMemoryController = providerRuntime.getMemoryController?.() ?? null;
  // Provider control lives in the host UI/commands. It must never be exposed
  // to the conversational model as a prompt instruction or tool schema.
  const activeBuiltinTools = new Map(builtinTools);
  const mcpTools = mcpToolsToOpenAI(connections);
  const tools: ChatCompletionTool[] = [
    ...mcpTools,
    ...[...activeBuiltinTools.values()].map((b) => b.definition),
  ];
  const allowedToolNames = new Set(tools.map((t) => t.function.name));
  const toolRepair = new ToolCallRepair(
    { allowedToolNames, isMutating: isMutatingTool, isStormExempt: isStormExemptTool },
    6,  // storm window
    3   // storm threshold
  );
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
      '- If the user asks to list a directory, call list_directory. Do not use execute_command for ls/find/tree unless the dedicated tool cannot do the job.',
      '- If the user asks to create, append, or edit a file, use write_file or file_edit. Do not use shell redirection such as echo >> file.',
      '- If a request combines directory listing with a shell operation, use list_directory for the listing part and execute_command only for the shell operation.',
      '- Use execute_command only for shell operations (install deps, run tests, git, etc.).',
      '- Always provide complete parameters: read_file needs path (e.g. ./package.json), list_directory uses . for cwd.',
      '- Call multiple independent tools in parallel for efficiency.',
      '- On tool error: read the error, try a different approach.',
      '- Internal CLI: ma ctx commands are debug/compat context inspection only; they do not control the provider request transcript. Use ma say "text" to output messages in parallel with other tool calls.',
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
  const agentMd = loadAgentMd(cwd);
  const envInfo = `\n\n# Environment\n当前工作目录: ${cwd}\n平台: ${process.platform}\nNode: ${process.version}`;
  const systemPrompt = agentMd
    ? `${baseSystemPrompt}${envInfo}\n\n# Project Context\n${agentMd}`
    : `${baseSystemPrompt}${envInfo}`;

  const store = new MessageStore();
  store.init(systemPrompt, options.resumeMessages);
  const requestContextBuilder = new RequestContextBuilder();
  const sessionStore = options.sessionStore;
  const sessionId = options.sessionId;
  const contextManager = createContextManager(
    sessionId,
    sessionStore?.getSessionDir()
  );
  const runtimeSlots = new RuntimeContextSlotStore();
  const fileReadLedger = new FileReadLedger(
    sessionStore && sessionId
      ? join(sessionStore.getSessionDir(), `${sessionId}.reads.json`)
      : undefined,
  );
  if (options.resumeMessages) {
    contextManager.ensureIndexed(
      options.resumeMessages.filter((m) => m.role !== 'system')
    );
  }

  const rootTranscriptAnchors: number[] = [];

  function persistProviderState(): void {
    const providerState = providerRuntime.getProviderState?.();
    if (!providerState || !sessionStore || !sessionId) return;
    try {
      sessionStore.updateProviderState(sessionId, providerState);
    } catch {
      /* provider state is best-effort session metadata */
    }
  }

  function persistPending(): ReturnType<typeof contextManager.recordMessages> {
    const pending = store.getPendingForPersist();
    if (!sessionStore || !sessionId) {
      const indexed = contextManager.recordMessages(pending);
      store.markPersisted();
      return indexed;
    }
    const persisted: ChatCompletionMessageParam[] = [];
    for (const m of pending) {
      try {
        sessionStore.append(sessionId, m);
        persisted.push(m);
      } catch {
        /* ignore persist failures */
      }
    }
    const indexed = contextManager.recordMessages(persisted);
    store.markPersisted();
    return indexed;
  }

  function rewritePersistedHistoryFrom(storeIndex: number): void {
    if (!sessionStore || !sessionId || storeIndex <= 0) return;
    const snapshot = store.snapshot();
    const keepMessages = snapshot
      .slice(1, storeIndex)
      .filter((m) => m.role !== 'system').length;
    try {
      sessionStore.truncate(sessionId, keepMessages);
      for (const message of snapshot.slice(storeIndex)) {
        if (message.role !== 'system') {
          sessionStore.append(sessionId, message);
        }
      }
      store.markPersisted();
    } catch {
      /* keep in-memory correction even if session rewrite fails */
    }
  }

  async function completePendingZimoosOperationSummaries(summary: string): Promise<void> {
    const result = store.completePendingZimoosOperationSummaries(summary);
    if (result.updated === 0 || result.firstUpdatedIndex === null) return;
    rewritePersistedHistoryFrom(result.firstUpdatedIndex);
    await appendDebugLog(
      `zimoos operation summaries corrected: updated=${result.updated} firstIndex=${result.firstUpdatedIndex}`
    );
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

  function getProviderState() {
    return providerRuntime.getProviderState?.() ?? null;
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
  const capabilities = resolveModelCapabilities(config.model);
  const contextWindow = capabilities.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const contextWindowSource = capabilities.contextWindowSource;
  config.model.contextWindow = contextWindow;
  config.model.contextWindowSource = contextWindowSource;
  const requestBodyByteLimit = capabilities.requestBodyByteLimit;
  if (
    !Number.isSafeInteger(requestBodyByteLimit) ||
    requestBodyByteLimit <= 0
  ) {
    throw new Error(
      `invalid provider request body byte limit: ${String(requestBodyByteLimit)}`
    );
  }
  config.model.requestBodyByteLimit = requestBodyByteLimit;
  config.model.requestBodyByteLimitSource = capabilities.requestBodyByteLimitSource;
  const compactThreshold = Math.floor(contextWindow * COMPACT_TRIGGER_RATIO);
  const requestEnvelopeBytes = estimateSerializedBytes({
    model: config.model.model,
    messages: [],
    stream: true,
    temperature: config.model.temperature ?? 0.6,
    ...(config.model.topP !== undefined ? { top_p: config.model.topP } : {}),
    ...(config.model.presencePenalty !== undefined
      ? { presence_penalty: config.model.presencePenalty }
      : {}),
    frequency_penalty: config.model.frequencyPenalty ?? 1.1,
    ...(config.model.maxTokens != null && config.model.maxTokens > 0
      ? { max_tokens: config.model.maxTokens }
      : {}),
    ...(config.model.topK !== undefined ? { top_k: config.model.topK } : {}),
    ...(config.model.minP !== undefined ? { min_p: config.model.minP } : {}),
    ...(config.model.repeatPenalty !== undefined
      ? { repeat_penalty: config.model.repeatPenalty }
      : {}),
    ...(config.model.extraParams ?? {}),
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
  });
  const requestMessageByteBudget = Math.max(
    1,
    requestBodyByteLimit -
      requestEnvelopeBytes -
      DEFAULT_REQUEST_ENVELOPE_RESERVE_BYTES
  );
  let lastTaskDiagnostics: TaskDiagnostics = { recentTools: [], totalTools: 0 };

  function buildRequestSuffix(loopWarning = ''): string {
    const stateStr = renderStackState(stack);
    return [
      stateStr || '',
      loopWarning,
    ].filter(Boolean).join('\n\n');
  }

  function buildRequestContext(
    suffix: string,
    protectedMessageIndex?: number
  ): RequestContextBuildResult {
    return requestContextBuilder.build(store.snapshot(), {
      suffix,
      maxTokens: compactThreshold,
      maxBytes: requestMessageByteBudget,
      protectedMessageIndexes: protectedMessageIndex === undefined
        ? undefined
        : [protectedMessageIndex],
      requestOnlyAttachment: runtimeSlots.renderRequestOnlyAttachment(),
    });
  }

  function contextUsageSnapshotFromBuild(
    result: RequestContextBuildResult
  ): ContextUsageSnapshot {
    return {
      used: result.requestTokens,
      total: contextWindow,
      compactThreshold,
      source: contextWindowSource,
    };
  }

  function usageSnapshotForOverflow(
    err: RequestContextOverflowError
  ): ContextUsageSnapshot {
    return {
      used: err.protectedTokens,
      total: contextWindow,
      compactThreshold,
      source: contextWindowSource,
    };
  }

  function foldMessages(anchor: number, taskId: string, summary: string): void {
    const folded = store.fold(anchor, summary);
    if (folded) {
      taskArchive.set(taskId, folded);
      store.markPersisted();
    }
  }

  function foldTaskIfNeeded(task: Task, summary: string): void {
    // Preserve root user turns verbatim. Folding every completed root turn makes
    // context usage appear to drop sharply and forces follow-up questions to
    // re-read files. Subtasks are internal implementation detail and can still
    // be summarized to keep task-stack work bounded.
    if (!task.parentId) return;
    foldMessages(task.messageAnchor, task.id, summary);
  }

  async function* runTask(
    task: Task,
    rootUserMessage: ChatContent,
    completionAudit: CompletionObligationAudit,
    signal?: AbortSignal
  ): AsyncGenerator<AgentEvent, TaskRunResult, unknown> {
    const errorTracker = new ErrorTracker();
    const effectiveMaxTokens = config.model.maxTokens;
    const streamParser = new StreamParser({
      maxContentChars: config.model.maxOutputChars,
      repeatWindowChars: config.model.repeatWindowChars,
      repeatWindowRepeats: config.model.repeatWindowRepeats,
    });
    toolRepair.resetStorm();
    const toolExecutor = new ToolExecutor(
      config,
      connections,
      activeBuiltinTools,
      { nextId: nextConfirmId, awaitApproval: awaitConfirm },
      fileReadLedger,
    );

    let openingContent: ChatCompletionUserMessageParam['content'];
    if (task.parentId) {
      openingContent = `（子任务）${task.prompt}`;
    } else if (typeof rootUserMessage === 'string') {
      openingContent = rootUserMessage;
    } else {
      openingContent = rootUserMessage as unknown as ChatCompletionUserMessageParam['content'];
    }
    const priorMessages = store.snapshot().slice(1);
    store.appendUser(openingContent as any, { rootTurn: !task.parentId });
    const openingIndexed = persistPending();
    if (!task.parentId) {
      const rootEntry = openingIndexed.find((entry) => entry.role === 'user');
      if (rootEntry) rootTranscriptAnchors.push(rootEntry.i);
    }

    if (!task.parentId) {
      const clarification = clarificationForAmbiguousPrompt(
        textFromChatContent(rootUserMessage),
        priorMessages,
      );
      if (clarification) {
        store.appendAssistant(clarification);
        persistPending();
        yield { type: 'text', content: clarification };
        return { text: clarification, hitMaxLoops: false };
      }
    }

    let finalText = '';
    let emptyArgsRetries = 0;
    let tempOverride: number | undefined;
    let lastPrefixHash = '';
    let verbalIntentRetries = 0;
    let silentToolResults = 0;
    let lastVisibleAt = Date.now();
    let lengthContinuationCount = 0;
    let lastLengthContinuationContent = '';
    const incompleteActionEvidence = new Map<string, MissingActionEvidence>();
    lastTaskDiagnostics = { recentTools: [], totalTools: 0 };

    const taskResult = (text: string, hitMaxLoops = false): TaskRunResult => ({
      text,
      hitMaxLoops,
      ...(incompleteActionEvidence.size > 0
        ? { missingEvidence: [...incompleteActionEvidence.values()] }
        : {}),
    });

    const failedCompletionResult = (
      text: string,
      completionObligationFailure: string
    ): TaskRunResult => ({
      ...taskResult(text),
      completionObligationFailure,
    });

    const noteVisible = () => {
      silentToolResults = 0;
      lastVisibleAt = Date.now();
    };

    const recordToolProgress = (
      name: string,
      args: Record<string, unknown>,
      ok: boolean,
      content: string
    ): AgentEvent | null => {
      const record: ToolProgressRecord = {
        name,
        args,
        ok,
        preview: compactResultPreview(content),
      };
      lastTaskDiagnostics.totalTools++;
      lastTaskDiagnostics.recentTools.push(record);
      lastTaskDiagnostics.recentTools = lastTaskDiagnostics.recentTools.slice(-8);
      silentToolResults++;
      const idleMs = Date.now() - lastVisibleAt;
      if (silentToolResults >= PROGRESS_TOOL_STREAK || idleMs >= PROGRESS_IDLE_MS) {
        noteVisible();
        return {
          type: 'progress',
          message: buildProgressMessage(
            lastTaskDiagnostics.recentTools,
            lastTaskDiagnostics.totalTools
          ),
        };
      }
      return null;
    };

    for (let loop = 0; loop < maxLoops; loop++) {
      // Warn agent when approaching loop limit by appending to system prompt
      const remaining = maxLoops - loop;
      let loopWarning = '';
      if (remaining === 5) {
        loopWarning = `\n\n[WARNING] You have only 5 loops remaining (${loop}/${maxLoops} used). If you are stuck in a loop, stop and summarize what you have done so far. If you still need more steps to complete the task, continue working.`;
      }

      const suffix = buildRequestSuffix(loopWarning);
      let requestContext: RequestContextBuildResult;
      try {
        requestContext = buildRequestContext(suffix, task.messageAnchor);
      } catch (err) {
        if (err instanceof RequestContextOverflowError) {
          const usage = usageSnapshotForOverflow(err);
          lastTaskDiagnostics.lastContext = usage;
          yield { type: 'context:usage', ...usage };
        }
        throw err;
      }
      const usage = contextUsageSnapshotFromBuild(requestContext);
      lastTaskDiagnostics.lastContext = usage;
      yield { type: 'context:usage', ...usage };
      if (requestContext.currentImagesSummarized > 0) {
        yield {
          type: 'warning',
          message: `${requestContext.currentImagesSummarized} current-turn image(s) were replaced with auditable summaries to keep the request body below the provider byte limit. The model did not receive those pixels; rerun with smaller images if visual details are required.`,
        };
      }
      if (requestContext.windowed) {
        yield {
          type: 'compact:done',
          freed: Math.max(0, requestContext.rawTokens - requestContext.requestTokens),
        };
      }
      const requestMessages = providerCodec.encodeMessages(
        requestContext.messages
      );

      // Prefix cache diagnostic: detect unexpected system prompt changes
      // Only hash system[0] — the truly stable part that should never change mid-session
      const curHash = prefixHash(requestMessages.slice(0, 1));
      if (lastPrefixHash && curHash !== lastPrefixHash) {
        yield {
          type: 'text',
          content: `[prefix] system prompt changed — cache miss (hash: ${lastPrefixHash.slice(0, 8)} → ${curHash.slice(0, 8)})`,
        };
      }
      lastPrefixHash = curHash;

      const request: ChatCompletionCreateParamsStreaming = {
        model: config.model.model,
        messages: requestMessages,
        stream: true,
        temperature: tempOverride ?? config.model.temperature ?? 0.6,
        ...(config.model.topP !== undefined ? { top_p: config.model.topP } : {}),
        ...(config.model.presencePenalty !== undefined ? { presence_penalty: config.model.presencePenalty } : {}),
        frequency_penalty: tempOverride !== undefined ? 0 : (config.model.frequencyPenalty ?? 1.1),
        ...(effectiveMaxTokens != null && effectiveMaxTokens > 0 ? { max_tokens: effectiveMaxTokens } : {}),
      };
      const localModelParams: Record<string, unknown> = {};
      if (config.model.topK !== undefined) localModelParams.top_k = config.model.topK;
      if (config.model.minP !== undefined) localModelParams.min_p = config.model.minP;
      if (config.model.repeatPenalty !== undefined) {
        localModelParams.repeat_penalty = config.model.repeatPenalty;
      }
      Object.assign(
        request as unknown as Record<string, unknown>,
        localModelParams,
        providerCodec.buildRequestExtras?.({
          model: config.model,
          messages: requestMessages,
          tools,
          stream: true,
        }) ?? {},
        config.model.extraParams ?? {}
      );
      if (tools.length > 0) {
        request.tools = tools;
        request.tool_choice = 'auto';
      }

      const requestBodyBytes = estimateSerializedBytes(request);
      if (requestBodyBytes > requestBodyByteLimit) {
        throw new RequestContextOverflowError(
          `request body is too large (${requestBodyBytes}/${requestBodyByteLimit} bytes); retry with fewer or smaller images, or compress images before sending`,
          {
            rawTokens: requestContext.rawTokens,
            protectedTokens: requestContext.protectedTokens,
            maxTokens: compactThreshold,
            rawBytes: requestContext.rawBytes,
            protectedBytes: requestBodyBytes,
            maxBytes: requestBodyByteLimit,
          }
        );
      }

      // Debug: dump messages before API call
      // Always log API requests for debugging
      try {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const logFile = process.env.MA_DEBUG || path.join(os.homedir(), '.my-agent', 'api-debug.log');
        const dbg = requestMessages.map((m: any, index: number) => {
          const isLatestRequestOnlyZimoosMessage =
            index === requestMessages.length - 1 &&
            m.role === 'user' &&
            typeof m.content === 'string' &&
            /<zimoos\b[\s\S]*?<\/zimoos>/.test(m.content);
          return {
            role: m.role,
            content: typeof m.content === 'string'
              ? (isLatestRequestOnlyZimoosMessage ? m.content : m.content.slice(0, 200))
              : m.content,
            reasoning_content: typeof m.reasoning_content === 'string' ? `${m.reasoning_content.length} chars` : undefined,
            tool_calls: m.tool_calls?.length,
            tool_call_id: m.tool_call_id,
          };
        });
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] API REQUEST messages (${requestMessages.length}):\n${JSON.stringify(dbg, null, 2)}\n\n`);
      } catch { /* ignore */ }

      const parsedTurn = yield* drainProviderEvents((onProviderEvent) =>
        (async function* () {
          const stream = await providerRuntime.createStreamingChatCompletion(
            request,
            { signal, onEvent: onProviderEvent }
          );
          return yield* streamParser.parse(stream);
        })()
      );
      const { content: contentBuf, toolCalls, finishReason } = parsedTurn;
      persistProviderState();
      const reasoningContent = providerCodec.shouldStoreReasoningContent(parsedTurn)
        ? parsedTurn.reasoningContent
        : undefined;
      if (contentBuf.trim().length > 0) {
        noteVisible();
      }

      if (
        lengthContinuationCount > 0 &&
        !toolCalls &&
        contentBuf.trim().length > 0 &&
        lastLengthContinuationContent &&
        isLikelyContinuationRepeat(lastLengthContinuationContent, contentBuf)
      ) {
        yield {
          type: 'warning',
          message: 'Model repeated prior truncated output after continuation; stopped automatic continuation to avoid runaway repetition.',
        };
        if (!task.parentId) {
          completionAudit.setFileReadCoverage(fileReadLedger.coverage());
          const completionDecision = completionAudit.inspectFinalAttempt(contentBuf || lastLengthContinuationContent);
          if (completionDecision.status === 'retry') {
            store.appendUser(completionDecision.message!);
            persistPending();
            yield { type: 'warning', message: completionDecision.message! };
            lengthContinuationCount = 0;
            lastLengthContinuationContent = '';
            tempOverride = 0.1;
            continue;
          }
          if (completionDecision.status === 'failed') {
            finalText = lastLengthContinuationContent;
            return failedCompletionResult(
              finalText,
              completionDecision.message!
            );
          }
        }
        finalText = lastLengthContinuationContent;
        return taskResult(finalText);
      }

      if (finishReason === 'length' && !toolCalls) {
        yield { type: 'warning', message: 'Model output was truncated (token limit reached). Continuing...' };
        if (contentBuf.trim().length > 0) {
          await completePendingZimoosOperationSummaries(contentBuf);
          store.appendAssistant(contentBuf, undefined, { reasoningContent });
          lastLengthContinuationContent = contentBuf;
        }
        // Local coding models often spend a full turn on hidden reasoning and
        // leave only a verbal promise such as "now I will write the file".
        // A generic continuation nudge repeats that promise; require the next
        // turn to take one concrete tool action instead.
        if (
          verbalIntentRetries < 2 &&
          userAskedForConcreteToolWork(textFromChatContent(rootUserMessage)) &&
          looksLikeVerbalToolIntent(contentBuf)
        ) {
          verbalIntentRetries += 1;
          store.appendUser(buildImmediateToolNudge(contentBuf));
          persistPending();
          lengthContinuationCount = 0;
          lastLengthContinuationContent = '';
          tempOverride = 0.1;
          continue;
        }
        lengthContinuationCount++;
        if (lengthContinuationCount > MAX_AUTOMATIC_LENGTH_CONTINUATIONS) {
          yield {
            type: 'warning',
            message: `Model reached the output token limit ${MAX_AUTOMATIC_LENGTH_CONTINUATIONS} times; stopped automatic continuation. Ask to continue if more output is needed.`,
          };
          finalText = contentBuf || lastLengthContinuationContent;
          persistPending();
          if (!task.parentId) {
            completionAudit.setFileReadCoverage(fileReadLedger.coverage());
            const completionDecision = completionAudit.inspectFinalAttempt(contentBuf);
            if (completionDecision.status === 'retry') {
              store.appendUser(completionDecision.message!);
              persistPending();
              yield { type: 'warning', message: completionDecision.message! };
              lengthContinuationCount = 0;
              lastLengthContinuationContent = '';
              tempOverride = 0.1;
              continue;
            }
            if (completionDecision.status === 'failed') {
              return failedCompletionResult(
                finalText,
                completionDecision.message!
              );
            }
          }
          return taskResult(finalText);
        }
        store.appendUser(buildContinuationNudge(contentBuf || lastLengthContinuationContent));
        persistPending();
        continue;
      }

      // Run the tool-call repair pipeline: scavenge + truncation fix + storm breaker
      const repairResult = toolRepair.process(
        toolCalls ?? [],
        contentBuf,
        reasoningContent,
        { userText: textFromChatContent(rootUserMessage) }
      );
      for (const note of repairResult.report.notes) {
        yield { type: 'text', content: `[repair] ${note}` };
      }

      const repairedCalls = repairResult.calls.length > 0 ? repairResult.calls : null;

      if (!repairedCalls) {
        // If content is empty/whitespace after tool use, nudge model to answer
        if (contentBuf.trim().length === 0 && loop > 0) {
          store.appendNudge();
          persistPending();
          continue;
        }
        if (
          verbalIntentRetries < 2 &&
          userAskedForConcreteToolWork(textFromChatContent(rootUserMessage)) &&
          looksLikeVerbalToolIntent(contentBuf)
        ) {
          verbalIntentRetries += 1;
          await completePendingZimoosOperationSummaries(contentBuf);
          store.appendAssistant(contentBuf, undefined, { reasoningContent });
          store.appendUser(
            '你刚才说要继续操作，但没有调用工具。请现在直接调用合适的工具完成这一步；如果信息不足，请直接向用户提一个明确问题。'
          );
          persistPending();
          tempOverride = 0.1;
          continue;
        }
        if (!task.parentId && contentBuf.trim().length > 0) {
          completionAudit.setFileReadCoverage(fileReadLedger.coverage());
          const completionDecision = completionAudit.inspectFinalAttempt(contentBuf);
          if (completionDecision.status === 'retry') {
            await completePendingZimoosOperationSummaries(contentBuf);
            store.appendAssistant(contentBuf, undefined, { reasoningContent });
            store.appendUser(completionDecision.message!);
            persistPending();
            yield {
              type: 'warning',
              message: completionDecision.message!,
            };
            tempOverride = 0.1;
            continue;
          }
          if (completionDecision.status === 'failed') {
            await completePendingZimoosOperationSummaries(contentBuf);
            store.appendAssistant(contentBuf, undefined, { reasoningContent });
            persistPending();
            finalText = contentBuf;
            return failedCompletionResult(
              finalText,
              completionDecision.message!
            );
          }
        }
        await completePendingZimoosOperationSummaries(contentBuf);
        store.appendAssistant(contentBuf, undefined, { reasoningContent });
        persistPending();
        finalText = contentBuf;
        return taskResult(finalText);
      }

      const invalidToolCalls = repairedCalls
        .map((tc) => {
          const args = normalizeArguments(tc.function.arguments);
          const missing = missingRequiredArgs(tools, tc.function.name, args);
          return { tc, args, missing };
        })
        .filter((item) => item.missing.length > 0);

      // P0-b: If the model emits tool calls with missing required args, retry
      // without writing that malformed assistant(tool_calls) into history.
      // Qwen3/LM Studio templates can crash when bad multi-step tool history is
      // echoed back, especially for mixed valid+empty parallel tool calls.
      if (invalidToolCalls.length > 0) {
        if (emptyArgsRetries < 2) {
          emptyArgsRetries += 1;
          tempOverride = 0.1;
          continue;
        }
        const details = invalidToolCalls
          .map(
            ({ tc, missing }) =>
              `${tc.function.name} missing [${missing.join(', ')}]`
          )
          .join('; ');
        for (const { tc, args, missing } of invalidToolCalls) {
          yield { type: 'tool:call', name: tc.function.name, args };
          const errorMessage = `Error: tool "${tc.function.name}" requires [${missing.join(', ')}] but received incomplete arguments.`;
          yield {
            type: 'tool:result',
            ok: false,
            content: errorMessage,
          };
          const progress = recordToolProgress(tc.function.name, args, false, errorMessage);
          if (progress) yield progress;
        }
        store.appendUser(
          `Your previous tool call arguments were invalid: ${details}. Retry with complete JSON arguments for every required field.`
        );
        persistPending();
        emptyArgsRetries = 0;
        tempOverride = 0.1;
        continue;
      }

      if (contentBuf.trim().length > 0) {
        await completePendingZimoosOperationSummaries(contentBuf);
      }
      store.appendAssistant(contentBuf.trim() || '', repairedCalls, { reasoningContent });

      // P0-b compatibility guard: retry empty args only when the tool schema
      // actually declares required arguments. Legitimate no-arg tools such as
      // zimoos.current must execute on the first attempt.
      const allEmpty = repairedCalls.every((tc) => {
        const a = normalizeArguments(tc.function.arguments);
        return Object.keys(a).length === 0;
      });
      const shouldRetryAllEmpty =
        allEmpty &&
        repairedCalls.some((tc) =>
          shouldRetryEmptyArguments(tools, tc.function.name)
        );
      if (shouldRetryAllEmpty && emptyArgsRetries < 2) {
        emptyArgsRetries += 1;
        store.popAssistant(); // remove the assistant message with empty tool_calls
        tempOverride = 0.1; // force low temperature for next request
        continue; // re-enter loop without incrementing any error state
      }
      emptyArgsRetries = 0;
      tempOverride = undefined;

      const toolCtx = { stack, currentTask: task, todoList, contextManager };

      for (const tc of repairedCalls) {
        const fullName = tc.function.name;
        const args = normalizeArguments(tc.function.arguments);

        const blockCheck = errorTracker.isBlocked(fullName, args);
        if (blockCheck.blocked) {
          yield { type: 'tool:call', name: fullName, args };
          yield { type: 'tool:result', ok: false, content: blockCheck.message! };
          store.appendToolResult(tc.id, blockCheck.message!);
          const progress = recordToolProgress(fullName, args, false, blockCheck.message!);
          if (progress) yield progress;
          continue;
        }

        const {
          result,
          isError,
          runtimeSlotUpdate,
          actionEvidence,
          fileReadCoverage,
          progressSummary,
        } = yield* toolExecutor.execute(
          tc,
          toolCtx,
          signal
        );
        completionAudit.recordToolEvidence({
          toolName: fullName,
          args,
          succeeded: !isError,
          verifiedAction: actionEvidence?.status === 'verified',
        });
        if (fileReadCoverage) completionAudit.setFileReadCoverage(fileReadCoverage);
        if (actionEvidence?.status === 'verified') {
          incompleteActionEvidence.delete(actionEvidence.key);
        } else if (actionEvidence) {
          incompleteActionEvidence.set(actionEvidence.key, {
            tool: fullName,
            toolCallId: tc.id,
            operation: actionEvidence.operation,
            status: actionEvidence.status,
          });
        }
        if (runtimeSlotUpdate) {
          runtimeSlots.set(runtimeSlotUpdate);
          await appendDebugLog(
            `runtime slot updated: ${runtimeSlotUpdate.slotId} sourceTool=${fullName} toolCallId=${tc.id} frameId=${runtimeSlotUpdate.value.frame.frameId ?? '(unknown)'} frameCursor=${runtimeSlotUpdate.value.frame.frameCursor}`
          );
        }
        persistProviderState();
        store.appendToolResult(tc.id, result);
        errorTracker.record(fullName, args, isError);
        const progress = recordToolProgress(fullName, args, !isError, progressSummary ?? result);
        if (progress) yield progress;
      }
      // A local model can spend a truncated turn only updating its plan, then
      // announce a real action it still has not performed. Do not let a
      // todo_write satisfy that turn: the next request must make the promised
      // concrete tool call rather than receive a generic continuation prompt.
      const planningOnlyTruncatedTurn =
        finishReason === 'length' &&
        repairedCalls.every((tc) => tc.function.name === 'todo_write');
      if (
        planningOnlyTruncatedTurn &&
        verbalIntentRetries < 2 &&
        userAskedForConcreteToolWork(textFromChatContent(rootUserMessage)) &&
        looksLikeVerbalToolIntent(contentBuf)
      ) {
        verbalIntentRetries += 1;
        store.appendUser(buildImmediateToolNudge(contentBuf));
        persistPending();
        tempOverride = 0.1;
        continue;
      }
      persistPending();
    }

    const stop = [
      `[agent] task [${task.id}] reached max loop count (${maxLoops}), aborting`,
      '失败点：达到最大循环次数。',
      '下一步：请缩小任务范围，或检查是否存在重复工具调用/缺少停止条件。',
    ].join('\n');
    await completePendingZimoosOperationSummaries(stop);
    store.appendAssistant(stop);
    persistPending();
    yield { type: 'text', content: stop };
    finalText = stop;
    return taskResult(finalText, true);
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

    const workspaceBefore = collectWorkspaceSnapshot();
    const completionAudit = new CompletionObligationAudit(rootPromptText);

    outer: while (stack.size() > 0) {
      if (signal?.aborted) break;

      const task = stack.pop();
      if (!task) break;

      task.messageAnchor = store.length;
      yield { type: 'task:start', taskId: task.id, prompt: task.prompt };

      let taskText = '';
      let hitMaxLoops = false;
      let failed = false;
      let failMessage = '';
      let aborted = false;
      let missingEvidence: MissingActionEvidence[] = [];
      let completionObligationFailure = '';

      try {
        const gen = runTask(task, userMessage, completionAudit, signal);
        while (true) {
          const { value, done } = await gen.next();
          if (done) {
            const result = value ?? { text: '', hitMaxLoops: false };
            taskText = result.text ?? '';
            hitMaxLoops = result.hitMaxLoops === true;
            missingEvidence = result.missingEvidence ?? [];
            completionObligationFailure = result.completionObligationFailure ?? '';
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
        foldTaskIfNeeded(task, 'ABORTED');
        yield { type: 'task:aborted', taskId: task.id };
        yield { type: 'aborted' };
        stack.abortAll();
        break outer;
      }

      if (!signal?.aborted) {
        const workspaceDiff = diffWorkspaceSnapshots(
          workspaceBefore,
          collectWorkspaceSnapshot()
        );
        if (workspaceDiff) {
          yield { type: 'workspace:diff', artifact: workspaceDiff };
        }
      }

      if (failed) {
        const cleanError = cleanErrorMessage(failMessage);
        const summary = buildFailureSummary(cleanError, lastTaskDiagnostics);
        await completePendingZimoosOperationSummaries(summary);
        store.appendAssistant(summary);
        persistPending();
        taskText = summary;
        yield { type: 'text', content: summary };
        stack.markFailed(task.id, cleanError);
        foldTaskIfNeeded(task, `FAILED: ${cleanError}\n${summary}`);
        yield { type: 'task:failed', taskId: task.id, error: cleanError };
      } else if (hitMaxLoops) {
        stack.markFailed(task.id, taskText);
        foldTaskIfNeeded(task, taskText);
        yield { type: 'task:failed', taskId: task.id, error: 'max loops' };
      } else if (missingEvidence.length > 0) {
        const evidenceFailure = buildMissingEvidenceFailure(missingEvidence);
        store.appendAssistant(evidenceFailure);
        persistPending();
        taskText = evidenceFailure;
        yield { type: 'text', content: evidenceFailure };
        stack.markFailed(task.id, evidenceFailure);
        foldTaskIfNeeded(task, evidenceFailure);
        yield { type: 'task:failed', taskId: task.id, error: evidenceFailure };
      } else if (completionObligationFailure) {
        store.appendAssistant(completionObligationFailure);
        persistPending();
        taskText = completionObligationFailure;
        yield { type: 'text', content: completionObligationFailure };
        stack.markFailed(task.id, completionObligationFailure);
        foldTaskIfNeeded(task, completionObligationFailure);
        yield {
          type: 'task:failed',
          taskId: task.id,
          error: completionObligationFailure,
        };
      } else {
        stack.markDone(task.id, taskText);
        foldTaskIfNeeded(task, taskText || '(no output)');
        const next = stack.peek();
        yield {
          type: 'task:done',
          taskId: task.id,
          next: next ? next.id : undefined,
        };
      }
    }

  }

  function reset(): void {
    store.reset(systemPrompt);
    runtimeSlots.clear();
    stack.clear();
    taskArchive.clear();
    rootTranscriptAnchors.length = 0;
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

  function revertLastTurnContextOnly(): number {
    const transcriptAnchor = rootTranscriptAnchors.pop();
    const removed = store.revertLastRootTurn();
    if (removed > 0) {
      if (sessionStore && sessionId && transcriptAnchor !== undefined) {
        try {
          sessionStore.truncate(sessionId, transcriptAnchor);
        } catch {
          /* ignore persist failures */
        }
      }
      if (transcriptAnchor !== undefined) {
        contextManager.truncateFrom(transcriptAnchor);
      }
      stack.clear();
    } else if (transcriptAnchor !== undefined) {
      rootTranscriptAnchors.push(transcriptAnchor);
    }
    return removed;
  }

  function getContextUsage(): { used: number; total: number; compactThreshold: number; source: string } {
    const suffix = buildRequestSuffix();
    try {
      return contextUsageSnapshotFromBuild(buildRequestContext(suffix));
    } catch (err) {
      if (err instanceof RequestContextOverflowError) {
        return usageSnapshotForOverflow(err);
      }
      throw err;
    }
  }

  function getMemoryController(): AgoraMemoryController | null {
    return agoraMemoryController;
  }

  function inspectContext(): string {
    return contextManager.inspect();
  }

  function searchContext(query: string) {
    return contextManager.search(query, 8);
  }

  function recallContext(entryId: string): string {
    return contextManager.recall(entryId);
  }

  function pinContext(text: string): string {
    return contextManager.pin(text);
  }

  function activeContext() {
    return contextManager.active();
  }

  function poolContext(limit?: number) {
    return contextManager.pool(limit);
  }

  function dropContext(i: number): string {
    return contextManager.drop(i);
  }

  function clearActiveContext(): string {
    return contextManager.clearActive();
  }

  async function close(): Promise<void> {
    await providerRuntime.close?.();
  }

  return {
    chat,
    reset,
    getTaskStack,
    getArchive,
    abortAll,
    revertLastTurnContextOnly,
    respondConfirm,
    getProviderState,
    getMemoryController,
    getContextUsage,
    inspectContext,
    searchContext,
    recallContext,
    pinContext,
    activeContext,
    poolContext,
    dropContext,
    clearActiveContext,
    close,
  };
}

export const __internal__ = {
  mcpToolsToOpenAI,
  normalizeArguments,
  ensureToolCallId,
  normalizeToolCalls,
  renderStackState,
  compactToolResult,
  CREATE_TASK_TOOL,
  STACK_STATE_PREFIX,
};

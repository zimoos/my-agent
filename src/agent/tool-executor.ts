import type { ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentConfig, McpConnection } from '../mcp/types.js';
import type { Task, TaskStack } from '../task-stack.js';
import type { AgentEvent } from './events.js';
import { normalizeArguments } from './normalize.js';
import { compactToolResult } from './compact.js';
import { classifyCommand, isWhitelisted } from './dangerGuard.js';
import { routeToolCall, findToolSchema } from './tool-router.js';
import { createTodoList } from './todo.js';
import { parseToolResultDiff } from './diff-artifact.js';
import type { ContextManager } from './context-manager.js';
import {
  createZimoosRuntimeSlotUpdate,
  sanitizeZimoosToolResultForHistory,
  type RuntimeContextSlotUpdate,
} from './runtime-context-slots.js';

const ASK_USER_PREFIX = '[ask_user] ';
const PLAN_OPEN = '[plan]\n';
const WEB_SEARCH_LIMIT_PER_TASK = 2;
const WEB_FETCH_LIMIT_PER_TASK = 3;

function extractCommand(args: Record<string, any>): string {
  if (!args) return '';
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  return '';
}

function isExecuteCommandCapability(toolName: string): boolean {
  return toolName === 'execute_command';
}

function normalizeCwd(args: Record<string, unknown>): string {
  const cwd = args.cwd;
  return typeof cwd === 'string' && cwd.length > 0
    ? resolve(cwd)
    : resolve(process.cwd());
}

function isTtyInteractive(): boolean {
  return Boolean((process.stdin as any)?.isTTY);
}

export interface BuiltinToolContext {
  stack: TaskStack;
  currentTask: Task;
  todoList: ReturnType<typeof createTodoList>;
  contextManager: ContextManager;
}

export interface BuiltinTool {
  definition: any;
  handler: (
    args: Record<string, any>,
    ctx: BuiltinToolContext
  ) => { content: string; isError: boolean } | Promise<{ content: string; isError: boolean }>;
}

export interface ToolExecutionContext {
  stack: TaskStack;
  currentTask: Task;
  todoList: ReturnType<typeof createTodoList>;
  contextManager: ContextManager;
  sessionId?: string;
}

export interface ConfirmProvider {
  nextId: () => string;
  awaitApproval: (id: string, signal?: AbortSignal) => Promise<boolean>;
}

export interface ToolExecutionResult {
  result: string;
  isError: boolean;
  runtimeSlotUpdate?: RuntimeContextSlotUpdate;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  requiresEvidence?: boolean;
  hasVerifiedEvidence?: boolean;
  actionEvidence?: {
    key: string;
    operation: string;
    status: 'verified' | 'missing' | 'failed';
  };
}

function requiresStructuredEvidence(
  toolName: string
): boolean {
  if (isExecuteCommandCapability(toolName)) return true;
  const lower = toolName.toLowerCase();
  return /_(write|edit|delete|create|remove|move|rename)_/.test(`_${lower}_`);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function actionEvidenceKey(
  operation: string,
  args: Record<string, unknown>
): string {
  if (isExecuteCommandCapability(operation)) {
    return createHash('sha256')
      .update(operation)
      .update('\0')
      .update(extractCommand(args))
      .update('\0')
      .update(normalizeCwd(args))
      .digest('hex');
  }
  return createHash('sha256')
    .update(operation)
    .update('\0')
    .update(stableJson(args))
    .digest('hex');
}

function hasVerifiedStructuredEvidence(
  structuredContent: Record<string, unknown> | undefined,
  expectedOperation: string
): boolean {
  const evidence = structuredContent?.['my-agent/evidence'];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
  const value = evidence as Record<string, unknown>;
  return value.status === 'verified' &&
    typeof value.operation === 'string' &&
    value.operation.trim() === expectedOperation;
}

export class ToolExecutor {
  private webSearchCount = 0;
  private webFetchCount = 0;
  private seenWebSearchQueries = new Set<string>();
  private seenWebFetchUrls = new Set<string>();

  constructor(
    private config: AgentConfig,
    private connections: McpConnection[],
    private builtinTools: Map<string, BuiltinTool>,
    private confirmProvider: ConfirmProvider
  ) {}

  /** Look up the JSON Schema for a tool (exposed for pre-flight validation). */
  getSchema(fullName: string): Record<string, any> | null {
    return findToolSchema(this.connections, fullName);
  }

  /**
   * Execute a single tool call.
   *
   * Yields `tool:call`, `tool:confirm`, `ask_user`, `plan`, `tool:result`.
   * Returns the compacted result string and error flag.
   */
  async *execute(
    tc: ChatCompletionMessageToolCall,
    ctx: ToolExecutionContext,
    signal?: AbortSignal
  ): AsyncGenerator<AgentEvent, ToolExecutionResult, unknown> {
    const fullName = tc.function.name;
    const args = normalizeArguments(tc.function.arguments);

    // Intercept empty args when tool schema has required fields
    if (Object.keys(args).length === 0) {
      const schema = this.getSchema(fullName);
      const required = schema?.required;
      if (Array.isArray(required) && required.length > 0) {
        const emptyResult = `Error: tool "${fullName}" requires [${required.join(', ')}] but received empty arguments. Please provide the required parameters.`;
        yield { type: 'tool:call', name: fullName, args };
        yield { type: 'tool:result', ok: false, content: emptyResult };
        return { result: emptyResult, isError: true };
      }
    }

    yield { type: 'tool:call', name: fullName, args };

    let toolResult = '';
    let isError = false;
    let skipExecute = false;
    let executedToolName = fullName;
    let structuredContent: Record<string, unknown> | undefined;
    let meta: Record<string, unknown> | undefined;
    let externalTool = false;

    const webPolicyBlock = this.reserveWebCall(fullName, args);
    if (webPolicyBlock) {
      toolResult = webPolicyBlock;
      isError = true;
      skipExecute = true;
    }

    const routedToolName = routeToolCall(this.connections, fullName)?.toolName;
    if (!skipExecute && routedToolName && isExecuteCommandCapability(routedToolName)) {
      let cmd = extractCommand(args);
      const mode = this.config.danger?.mode ?? 'confirm';

      // Proxy: auto-inject --session for ma ctx / ma say commands
      const MA_INTERNAL_RE = /^ma\s+(?:ctx|say)\b/;
      if (MA_INTERNAL_RE.test(cmd) && ctx.sessionId) {
        if (!/\s--session\b/.test(cmd)) {
          cmd = cmd.trimEnd() + ` --session ${ctx.sessionId}`;
          if (typeof args.command === 'string') args.command = cmd;
          if (typeof args.cmd === 'string') args.cmd = cmd;
        }
        // ma ctx / ma say commands are not dangerous, skip confirm
      } else if (cmd && mode !== 'off') {
        const allow = this.config.danger?.allow;
        const result = classifyCommand(cmd);
        if (result.dangerous && !isWhitelisted(cmd, allow)) {
          const reason = result.reason ?? 'dangerous command';
          if (mode === 'deny' || !isTtyInteractive()) {
            toolResult = `[blocked] ${reason}`;
            isError = true;
            skipExecute = true;
          } else {
            const requestId = this.confirmProvider.nextId();
            yield {
              type: 'tool:confirm',
              requestId,
              cmd,
              reason,
            };
            const approved = await this.confirmProvider.awaitApproval(
              requestId,
              signal
            );
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
      const builtin = this.builtinTools.get(fullName);
      if (builtin) {
        const r = await builtin.handler(args, ctx);
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
        const route = routeToolCall(this.connections, fullName);
        if (!route) {
          toolResult = `Error: unknown tool '${fullName}'`;
          isError = true;
        } else {
          executedToolName = route.toolName;
          externalTool = true;
          try {
            const r = await route.conn.call(
              route.toolName,
              args,
              signal
            );
            toolResult = r.content;
            isError = r.isError;
            structuredContent = r.structuredContent;
            meta = r._meta;
          } catch (err) {
            toolResult = `Error: ${(err as Error).message}`;
            isError = true;
          }
        }
      }
    }

    const runtimeSlotUpdate = createZimoosRuntimeSlotUpdate({
      rawResult: toolResult,
      isError,
      sourceTool: executedToolName,
      toolCallId: tc.id,
      actionArgs: args,
    });
    const zimoosHistoryAudit = !isError
      ? sanitizeZimoosToolResultForHistory({
          rawResult: toolResult,
          sourceTool: executedToolName,
          actionArgs: args,
        })
      : null;
    const historyResult = runtimeSlotUpdate
      ? runtimeSlotUpdate.auditText
      : zimoosHistoryAudit
        ? zimoosHistoryAudit
      : compactToolResult(toolResult);
    const uiResult = runtimeSlotUpdate
      ? runtimeSlotUpdate.auditText
      : zimoosHistoryAudit
        ? zimoosHistoryAudit
      : toolResult;

    const short = formatToolResultForUi(uiResult);
    const artifact = !isError ? parseToolResultDiff(short) : undefined;
    const resultEvent: AgentEvent = {
      type: 'tool:result',
      ok: !isError,
      content: short,
      artifact,
    };
    if (structuredContent !== undefined) {
      resultEvent.structuredContent = structuredContent;
    }
    if (meta !== undefined) {
      resultEvent._meta = meta;
    }
    yield resultEvent;

    const requiresEvidence = externalTool &&
      requiresStructuredEvidence(executedToolName);
    const executionResult: ToolExecutionResult = {
      result: historyResult,
      isError,
      runtimeSlotUpdate: runtimeSlotUpdate ?? undefined,
    };
    if (structuredContent !== undefined) {
      executionResult.structuredContent = structuredContent;
    }
    if (meta !== undefined) executionResult._meta = meta;
    if (requiresEvidence) {
      const hasVerifiedEvidence = !isError &&
        hasVerifiedStructuredEvidence(structuredContent, executedToolName);
      executionResult.requiresEvidence = true;
      executionResult.hasVerifiedEvidence = hasVerifiedEvidence;
      executionResult.actionEvidence = {
        key: actionEvidenceKey(executedToolName, args),
        operation: executedToolName,
        status: hasVerifiedEvidence
          ? 'verified'
          : isError
            ? 'failed'
            : 'missing',
      };
    }
    return executionResult;
  }

  private reserveWebCall(fullName: string, args: Record<string, any>): string | null {
    if (isWebSearchTool(fullName)) {
      const query = normalizeWebKey(args.query);
      if (!query) return null;
      if (this.seenWebSearchQueries.has(query)) {
        return JSON.stringify({
          tool: 'web_search',
          status: 'error',
          error: { kind: 'duplicate_query', message: 'This search query was already used in this task.' },
          suggested_next_action: 'Do not repeat the same query. Use one of the previous results, refine the query, or switch to local tools such as grep, npm, gh, or package manager commands.',
        }, null, 2);
      }
      if (this.webSearchCount >= WEB_SEARCH_LIMIT_PER_TASK) {
        return JSON.stringify({
          tool: 'web_search',
          status: 'error',
          error: { kind: 'budget_exceeded', message: `web_search limit reached (${WEB_SEARCH_LIMIT_PER_TASK} per task).` },
          suggested_next_action: 'Stop searching the web for this task. Use fetched sources already available or fall back to local tools.',
        }, null, 2);
      }
      this.seenWebSearchQueries.add(query);
      this.webSearchCount++;
      return null;
    }

    if (isWebFetchTool(fullName)) {
      const url = normalizeWebKey(args.url);
      if (!url) return null;
      if (this.seenWebFetchUrls.has(url)) {
        return JSON.stringify({
          tool: 'web_fetch',
          status: 'error',
          url: args.url,
          error: { kind: 'duplicate_url', message: 'This URL was already fetched or attempted in this task.' },
          suggested_next_action: 'Do not fetch the same URL again. Use the previous content, choose another source, or switch to local tools.',
        }, null, 2);
      }
      if (this.webFetchCount >= WEB_FETCH_LIMIT_PER_TASK) {
        return JSON.stringify({
          tool: 'web_fetch',
          status: 'error',
          error: { kind: 'budget_exceeded', message: `web_fetch limit reached (${WEB_FETCH_LIMIT_PER_TASK} per task).` },
          suggested_next_action: 'Stop fetching more pages. Answer from available sources or use local tools.',
        }, null, 2);
      }
      this.seenWebFetchUrls.add(url);
      this.webFetchCount++;
      return null;
    }

    return null;
  }
}

function normalizeWebKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

function isWebSearchTool(fullName: string): boolean {
  return fullName === 'web_search' || fullName.endsWith('__web_search');
}

function isWebFetchTool(fullName: string): boolean {
  return fullName === 'web_fetch' || fullName.endsWith('__web_fetch');
}

export function formatToolResultForUi(toolResult: string): string {
  if (toolResult.includes('--- Diff ---')) {
    return toolResult.length > 12000
      ? toolResult.slice(0, 12000) + '\n...'
      : toolResult;
  }
  return toolResult.length > 400
    ? toolResult.slice(0, 400) + '...'
    : toolResult;
}

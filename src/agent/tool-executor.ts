import type { ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';
import type { AgentConfig, McpConnection } from '../mcp/types.js';
import type { Task, TaskStack } from '../task-stack.js';
import type { AgentEvent } from './events.js';
import { normalizeArguments } from './normalize.js';
import { compactToolResult } from './compact.js';
import { classifyCommand, isWhitelisted } from './dangerGuard.js';
import { routeToolCall, findToolSchema } from './tool-router.js';
import { createTodoList } from './todo.js';

const DANGER_EXEC_TOOLS = new Set<string>([
  'exec-mcp__execute_command',
  'exec__execute_command',
]);

const ASK_USER_PREFIX = '[ask_user] ';
const PLAN_OPEN = '[plan]\n';

function extractCommand(args: Record<string, any>): string {
  if (!args) return '';
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  return '';
}

function isTtyInteractive(): boolean {
  return Boolean((process.stdin as any)?.isTTY);
}

export interface BuiltinToolContext {
  stack: TaskStack;
  currentTask: Task;
  todoList: ReturnType<typeof createTodoList>;
}

export interface BuiltinTool {
  definition: any;
  handler: (
    args: Record<string, any>,
    ctx: BuiltinToolContext
  ) => { content: string; isError: boolean };
}

export interface ToolExecutionContext {
  stack: TaskStack;
  currentTask: Task;
  todoList: ReturnType<typeof createTodoList>;
}

export interface ConfirmProvider {
  nextId: () => string;
  awaitApproval: (id: string, signal?: AbortSignal) => Promise<boolean>;
}

export class ToolExecutor {
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
  ): AsyncGenerator<AgentEvent, { result: string; isError: boolean }, unknown> {
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

    if (DANGER_EXEC_TOOLS.has(fullName)) {
      const cmd = extractCommand(args);
      const mode = this.config.danger?.mode ?? 'confirm';
      if (cmd && mode !== 'off') {
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
        const r = builtin.handler(args, ctx);
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
          try {
            const r = await route.conn.call(
              route.toolName,
              args,
              signal
            );
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
      toolResult.length > 400
        ? toolResult.slice(0, 400) + '...'
        : toolResult;
    yield { type: 'tool:result', ok: !isError, content: short };
    const compacted = compactToolResult(toolResult);

    return { result: compacted, isError };
  }
}

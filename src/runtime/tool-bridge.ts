import { createHash } from 'node:crypto';
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { ControlledExtension } from './extensions.js';
import type { TSchema } from 'typebox';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type { McpCallResult, McpConnection, McpProgressEvent } from '../mcp/types.js';
import type { Invocation, InvocationOrigin, ToolReceipt, TurnScope } from './contracts.js';
import type { HostControlPort } from './public-types.js';
import type { ModelBridge } from './model-bridge.js';
import type { ReceiptStore } from './receipt-store.js';
import type { TurnGate } from './turn-gate.js';
import { cloneRuntimeJson, requireOwnData } from './data.js';
import { projectMcpToolResult } from './mcp-tool-projection.js';

export interface ControlledToolRegistration {
  name: string;
  source: Invocation['source'];
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  sequential: boolean;
  beforeDispatch?(): void | Promise<void>;
  execute(args: Record<string, unknown>, signal: AbortSignal,
    progress: (event: McpProgressEvent) => void, transportMeta?: Record<string, unknown>): Promise<McpCallResult>;
  /** Trusted service semantics, not a model-supplied success flag or MCP annotation. */
  classify(result: McpCallResult): Pick<ToolReceipt, 'status' | 'stopConfirmed'>;
}

export interface ControlledToolBridge {
  tools: ToolDefinition[];
  resultExtension: ControlledExtension;
  receiptReferences(turn: TurnScope): string[];
}
interface Options {
  registrations: ControlledToolRegistration[];
  host: HostControlPort;
  gate: TurnGate;
  modelBridge: ModelBridge;
  receipts: ReceiptStore;
  captureRun(): { turn: TurnScope; signal: AbortSignal };
  onUnresolved(invocation: Invocation): void;
  onDispatch?(invocation: Invocation, origin: InvocationOrigin): void;
  onReceipt?(invocation: Invocation, receipt: ToolReceipt, result: AgentToolResult<Record<string, unknown>>, origin: InvocationOrigin): void;
  /** Protected metadata stays in this trusted in-process channel, never Pi details/history. */
  onHostMetadata?(invocation: Invocation, metadata: Record<string, unknown>): void;
  projectResult?(invocation: Invocation, raw: McpCallResult): ReturnType<typeof projectMcpToolResult>;
}
export class ToolPreflightError extends Error {}
function observe(callback: (() => unknown) | undefined): void {
  if (!callback) return;
  try { void Promise.resolve(callback()).catch(() => {}); } catch { /* Observer only. */ }
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/** The immutable registration retains the full source; digest collisions are rejected below. */
export function controlledToolName(source: Invocation['source']): string {
  return `mcp_${hash([source.serverId, source.toolName]).slice(0, 60)}`;
}

export function registerMcpTool(input: {
  connection: McpConnection;
  toolName: string;
  name?: string;
  sequential?: boolean;
  classify: ControlledToolRegistration['classify'];
}): ControlledToolRegistration {
  const matching = input.connection.tools.filter(tool => tool.name === input.toolName);
  if (matching.length !== 1) throw new Error('MA_TOOL_SOURCE_AMBIGUOUS');
  const tool = matching[0];
  const source = { serverId: input.connection.name, toolName: tool.name };
  return {
    name: input.name ?? controlledToolName(source), source, description: `${source.serverId}/${source.toolName}: ${tool.description}`,
    inputSchema: cloneRuntimeJson(tool.inputSchema),
    ...(tool.outputSchema ? { outputSchema: cloneRuntimeJson(tool.outputSchema) } : {}),
    ...(tool.annotations ? { annotations: cloneRuntimeJson(tool.annotations) } : {}), sequential: input.sequential ?? false,
    execute: (args, signal, progress, transportMeta) => input.connection.call(source.toolName, args, signal, progress, transportMeta),
    classify: input.classify,
  };
}

/** This is a tool adapter. Scheduling and tool-result history remain owned by Pi. */
export function createControlledToolBridge(options: Options): ControlledToolBridge {
  const names = new Set<string>();
  const sources = new Set<string>();
  const projectedResults = new Map<string, { isError: boolean; executionId: string }>();
  const references = new Map<string, string[]>();
  const turnKey = (turn: Pick<TurnScope, 'sessionId' | 'turnId' | 'epoch'>) => JSON.stringify([turn.sessionId, turn.turnId, turn.epoch]);
  const tools: ToolDefinition[] = options.registrations.map(registration => {
    const name = registration.name;
    const source = cloneRuntimeJson(registration.source);
    const sourceKey = JSON.stringify(source);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || names.has(name) || sources.has(sourceKey)) {
      throw new Error('MA_TOOL_CATALOG_COLLISION');
    }
    names.add(name); sources.add(sourceKey);
    const rawSchema = cloneRuntimeJson(registration.inputSchema);
    if (rawSchema.type !== 'object') throw new Error('MA_TOOL_SCHEMA_UNSUPPORTED');
    const schema = rawSchema as TSchema;
    const validator = new AjvJsonSchemaValidator();
    const inputValidator = validator.getValidator(rawSchema);
    const outputValidator = registration.outputSchema ? validator.getValidator(cloneRuntimeJson(registration.outputSchema)) : undefined;
    const definition: ToolDefinition = {
      name, label: name, description: registration.description + (registration.annotations
        ? `\nMCP hints (not permission grants): ${JSON.stringify(registration.annotations)}` : ''), parameters: schema,
      executionMode: registration.sequential ? 'sequential' : 'parallel',
      async execute(toolCallId, value, sdkSignal, onUpdate) {
        const run = options.captureRun();
        const turn = cloneRuntimeJson(run.turn);
        const signal = sdkSignal ? AbortSignal.any([run.signal, sdkSignal]) : run.signal;
        const origin = options.modelBridge.claimToolOrigin(turn, toolCallId, name);
        const args = cloneRuntimeJson(value) as Record<string, unknown>;
        if (!inputValidator(args).valid) throw new Error('MA_TOOL_ARGUMENTS_INVALID');
        signal.throwIfAborted();
        const authorization = cloneRuntimeJson(await options.host.authorizeTool({
          scope: turn, origin: origin.origin, toolCallId, source, args: cloneRuntimeJson(args), argsSha256: hash(args),
        }, signal));
        requireOwnData(authorization, ['executionId', 'decision', 'permissionScopeHash']);
        const invocation: Invocation = {
          executionId: authorization.executionId, source, toolCallId, sessionId: turn.sessionId,
          operationId: turn.operationId, turnId: turn.turnId, epoch: turn.epoch,
          argsSha256: hash(args), permissionScopeHash: authorization.permissionScopeHash,
        };
        await options.gate.bindInvocation(invocation, origin.origin);
        let entered = false;
        let terminal = false;
        const finish = async (receiptStatus: ToolReceipt['status'], stopConfirmed: boolean,
          projection: ReturnType<typeof projectMcpToolResult>): Promise<AgentToolResult<Record<string, unknown>>> => {
          if (receiptStatus === 'unknown') {
            // stop fences synchronously, even if storing the unknown receipt subsequently fails.
            void options.gate.stop(turn.turnId).catch(() => {});
            observe(() => options.onUnresolved(invocation));
          }
          const result = {
            content: projection.content,
            details: { executionId: invocation.executionId, source,
              ...(projection.details.structuredContent ? { structuredContent: projection.details.structuredContent } : {}) },
          };
          const reference = await options.receipts.write({
            schemaVersion: 1, kind: 'tool.receipt', invocation, origin: origin.origin,
            assistantTimestamp: origin.assistantTimestamp,
            status: receiptStatus, stopConfirmed, result, isError: projection.isError,
          });
          const receipt: ToolReceipt = {
            executionId: invocation.executionId, source, status: receiptStatus,
            resultRef: reference, evidenceRef: reference, stopConfirmed,
          };
          await options.gate.recordReceipt(invocation, receipt);
          terminal = true;
          const key = turnKey(turn);
          references.set(key, [...(references.get(key) ?? []), reference]);
          projectedResults.set(`${name}\0${toolCallId}`, { isError: projection.isError, executionId: invocation.executionId });
          if (projection.details._meta) observe(() => options.onHostMetadata?.(invocation, projection.details._meta!));
          observe(() => options.onReceipt?.(invocation, receipt, result, origin.origin));
          return { ...result, details: { ...result.details, resultRef: reference } };
        };
        try {
          if (authorization.decision === 'deny') {
            return await finish('denied', true, projectMcpToolResult({
              content: 'The trusted host denied this tool action.', isError: true,
            }));
          }
          if (authorization.decision !== 'allow') throw new Error('MA_TOOL_AUTHORIZATION_INVALID');
          signal.throwIfAborted();
          await registration.beforeDispatch?.();
          await options.gate.markDispatching(invocation);
          signal.throwIfAborted();
          observe(() => options.onDispatch?.(invocation, origin.origin));
          entered = true;
          const raw = await registration.execute(args, signal, event => {
            if (terminal || signal.aborted) return;
            observe(() => onUpdate?.({ content: [], details: {
              executionId: invocation.executionId, callId: origin.origin.callId, logicalCallId: origin.origin.logicalCallId,
              ...(typeof event.progress === 'number' ? { progress: event.progress } : {}),
              ...(typeof event.total === 'number' ? { total: event.total } : {}),
              ...(typeof event.message === 'string' ? { message: event.message.length > 4096 ? event.message.slice(0, 4096) + ' [progress message truncated]' : event.message } : {}),
            } }));
          }, { 'mteam.ma.invocation.v2': { ...cloneRuntimeJson(invocation), origin: cloneRuntimeJson(origin.origin) } });
          const projection = options.projectResult?.(invocation, raw) ?? projectMcpToolResult(raw);
          const outcome = registration.classify(cloneRuntimeJson(raw));
          if (!['succeeded', 'failed', 'unknown'].includes(outcome.status) || typeof outcome.stopConfirmed !== 'boolean') {
            throw new Error('MA_TOOL_RECEIPT_INVALID');
          }
          if (outputValidator && !raw.isError && !outputValidator(raw.structuredContent).valid) {
            projection.isError = true;
            projection.content.push({ type: 'text', text: 'The tool returned a result that does not match its declared output schema. The result is retained; do not infer that the action did not run.' });
          }
          return await finish(outcome.status, outcome.stopConfirmed, projection);
        } catch (error) {
          if (terminal) throw error;
          const status = entered ? 'unknown' : 'cancelled_not_sent';
          return await finish(status, !entered, projectMcpToolResult({
            content: entered ? 'The tool outcome is unknown; execution is paused for verification.'
              : error instanceof ToolPreflightError ? error.message : 'The tool was not dispatched.', isError: true,
          }));
        }
      },
    };
    return definition;
  });
  return {
    tools,
    resultExtension(pi) {
      pi.on('tool_result', event => {
        const key = `${event.toolName}\0${event.toolCallId}`;
        const result = projectedResults.get(key);
        if (!result) return;
        projectedResults.delete(key);
        return { isError: result.isError };
      });
    },
    receiptReferences: turn => [...(references.get(turnKey(turn)) ?? [])],
  };
}

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import type { BootstrapPreparation } from '../index.js';
import type { McpConnection } from '../mcp/types.js';
import { createProviderRuntime } from '../provider/runtime.js';
import { classifyCommand, isWhitelisted } from '../agent/dangerGuard.js';
import { readExecutionJournal } from './execution-journal.js';
import type { HostControlPort, MaBootstrapV2, ToolAuthorizationRequest } from './public-types.js';
import type { TurnScope } from './contracts.js';
import { cloneRuntimeJson } from './data.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function configuredJson<T>(value: T): T {
  const clean = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(clean);
    if (input && typeof input === 'object') {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!Object.hasOwn(descriptor, 'value')) throw new Error('MA_BOOTSTRAP_INVALID');
        if (descriptor.value !== undefined) Object.defineProperty(result, key, { value: clean(descriptor.value), enumerable: true });
      }
      return result;
    }
    return input;
  };
  return cloneRuntimeJson(clean(value)) as T;
}
const identity = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;

/** Standalone MA's explicit local Host. It never impersonates a Cloud account or budget. */
export async function createLocalSessionEnvironment(prepared: BootstrapPreparation, connections: McpConnection[],
  confirm: (request: ToolAuthorizationRequest, reason: string, signal?: AbortSignal) => Promise<boolean>) {
  const cwd = realpathSync(prepared.cwd);
  const profileId = `local-${hash([prepared.config.model.provider, prepared.config.model.baseURL, prepared.config.model.model]).slice(0, 32)}`;
  const directory = join(prepared.sessionStore.getSessionDir(), prepared.sessionId);
  if (prepared.resumed && !existsSync(join(directory, 'manifest.json'))) throw new Error('MA_LEGACY_SESSION_ARCHIVE_ONLY');
  const runtime = createProviderRuntime({ ...prepared.config.model, maxRetries: 0 }, undefined, { cwd, sessionId: prepared.sessionId, standalone: true });
  let epoch = 0;
  let operationId = identity('local-operation');
  let budgetRef = `local-credentials:${profileId}`;
  if (existsSync(join(directory, 'execution.jsonl'))) {
    const prior = await readExecutionJournal({ directory, sessionId: prepared.sessionId });
    epoch = prior.entries.reduce((highest, event) => Math.max(highest, event.epoch), 0);
    const lastTurn = [...prior.entries].reverse().find(event => event.kind === 'turn.registered');
    const completed = lastTurn && prior.entries.some(event => event.kind === 'turn.completed' && event.turnId === lastTurn.turnId);
    if (lastTurn?.kind === 'turn.registered' && !completed) { operationId = lastTurn.turn.operationId; budgetRef = lastTurn.turn.budgetRef; }
  }
  let active: TurnScope | undefined;
  const registered = new Map<string, TurnScope>();
  const stageId = identity('stage');
  const bootstrap: MaBootstrapV2 = {
    schemaVersion: 2, kind: 'ma.runtime.bootstrap',
    scope: { maSessionId: prepared.sessionId, workspaceId: `workspace-${hash(cwd).slice(0, 32)}`, canonicalCwd: cwd,
      hostIdentity: `local-${hash(hostname()).slice(0, 32)}`, providerProfileId: profileId },
    sessionDirectory: directory, agentDirectory: join(directory, 'agent'),
    config: configuredJson({ ...prepared.config, mcpServers: Object.fromEntries(connections.map(connection =>
      [connection.name, prepared.config.mcpServers[connection.name]])) }),
    capability: { id: `capability-${hash([profileId, prepared.config.model.contextWindow, prepared.config.model.maxTokens, prepared.config.model.inputModalities]).slice(0, 32)}`, providerProfileId: profileId,
      providerId: prepared.config.model.provider ?? 'openai', modelId: prepared.config.model.model,
      input: prepared.config.model.inputModalities ?? ['text'], tools: connections.some(connection => connection.tools.length > 0),
      reasoning: false, contextWindow: prepared.config.model.contextWindow ?? 32_768,
      maxOutputTokens: prepared.config.model.maxTokens ?? 4096, cancellation: 'local' },
    resources: {
      skillDirectories: [join(cwd, '.ma', 'skills')].filter(existsSync).map(path => realpathSync(path)),
      instructionFiles: prepared.loadAgentInstructions === false ? [] : ['AGENTS.md', 'AGENT.md'].map(name => join(cwd, name)).filter(existsSync).map(path => realpathSync(path)),
      extensions: ['ma-model-purpose', 'ma-resources', ...(connections.some(connection => connection.tools.length > 0) ? ['ma-tools'] : [])],
    },
    hostControl: { transport: 'local', protocolVersion: 2 },
    ...(prepared.resumed ? { resumeSessionId: prepared.sessionId } : {}),
  };
  const host: HostControlPort = {
    async registerTurn(turn, signal) {
      signal?.throwIfAborted();
      const expected = registered.get(turn.turnId);
      if (!expected || hash(expected) !== hash(turn) || (active && active.turnId !== turn.turnId)) throw new Error('TURN_REVOKED');
      active = turn;
    },
    async revokeTurn(turn) { registered.delete(turn.turnId); if (active?.turnId === turn.turnId) active = undefined; },
    async prepareModel({ context, request, requestRevision }) {
      if (!active || active.turnId !== context.turnId || active.epoch !== context.epoch
        || context.sessionId !== prepared.sessionId || !runtime.prepareModelRequest) throw new Error('TURN_REVOKED');
      const supplierRequestSha256 = await runtime.prepareModelRequest(context, request);
      return { supplierRequestSha256, requestRevision, providerProfileId: profileId,
        modelId: bootstrap.capability.modelId, capabilitySnapshotId: bootstrap.capability.id };
    },
    async authorizeTool(request, signal) {
      if (!active || active.turnId !== request.scope.turnId || active.epoch !== request.scope.epoch) throw new Error('TURN_REVOKED');
      const selected = connections.find(connection => connection.name === request.source.serverId);
      if (!selected?.tools.some(tool => tool.name === request.source.toolName)) throw new Error('FORBIDDEN');
      signal?.throwIfAborted();
      const command = typeof request.args.command === 'string' ? request.args.command : typeof request.args.cmd === 'string' ? request.args.cmd : '';
      const danger = classifyCommand(command);
      const mode = prepared.config.danger?.mode ?? 'confirm';
      let allowed = true;
      if (danger.dangerous && mode !== 'off' && !isWhitelisted(command, prepared.config.danger?.allow)) {
        allowed = mode !== 'deny' && await confirm(request, danger.reason ?? 'This command changes protected local state.', signal);
      }
      signal?.throwIfAborted();
      return { executionId: identity('exec'), decision: allowed ? 'allow' : 'deny',
        permissionScopeHash: hash({ source: request.source, argsSha256: request.argsSha256, turn: request.scope, mode, allowed }) };
    },
    async queryExecution(invocation) {
      return { receipt: { executionId: invocation.executionId, source: invocation.source, status: 'unknown', stopConfirmed: false } };
    },
    async receiptComplete(boundary) {
      if (!active || active.turnId !== boundary.turn.turnId || boundary.unresolvedCallIds.length || boundary.unresolvedExecutionIds.length) {
        throw new Error('MA_EXECUTION_UNRESOLVED');
      }
      registered.delete(active.turnId); active = undefined; operationId = identity('local-operation');
    },
  };
  return { bootstrap, host, runtime,
    nextTurn(): TurnScope {
      if (active) throw new Error('MA_SESSION_BUSY');
      const turn = { sessionId: prepared.sessionId, turnId: identity('turn'), epoch: ++epoch, operationId, stageId, budgetRef };
      registered.set(turn.turnId, turn); return cloneRuntimeJson(turn);
    },
  };
}

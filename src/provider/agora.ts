import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionChunk,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { AGORA_MCP_API_KEY } from '../config.js';
import { buildMcpEnv, McpClient } from '../mcp/client.js';
import type {
  AgoraMemoryConfig,
  AgoraRuntimeConfig,
  McpProgressEvent,
  ModelConfig,
  ProviderSessionState,
} from '../mcp/types.js';
import type { ProviderPolicy, ProviderProgressEvent, ProviderRunOptions } from './runtime.js';

export interface AgoraProviderContext {
  sessionId?: string;
  cwd?: string;
}

export interface AgoraMemoryToolResult {
  content: string;
  isError: boolean;
}

export interface AgoraMemoryController {
  status(args?: Record<string, any>): Promise<AgoraMemoryToolResult>;
  mount(args: Record<string, any>): Promise<AgoraMemoryToolResult>;
  disable(args: Record<string, any>): Promise<AgoraMemoryToolResult>;
  internalize(args: Record<string, any>): Promise<AgoraMemoryToolResult>;
  rollback(args: Record<string, any>): Promise<AgoraMemoryToolResult>;
}

const REQUIRED_TOOLS = new Set(['doctor', 'models_list', 'chat_complete']);
const REQUIRED_MEMORY_TOOLS = new Set([
  'memory_profiles_list',
  'memory_profiles_create',
  'memory_profiles_update',
  'memory_profile_bindings_list',
  'memory_profile_bindings_create',
  'memory_sources_create',
  'memory_sources_list',
  'memory_sources_get',
  'memory_intake_run',
  'memory_intake_get',
  'memory_patch_versions',
]);

const TERMINAL_INTAKE_STATUSES = new Set(['completed', 'failed', 'noop', 'review', 'conflict']);
const DEFAULT_AGORA_MAX_TOKENS = 4096;
const AGORA_TIMEOUT_CAP_SECONDS = 300;
const AGORA_TIMEOUT_HEADROOM_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyArgs(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function timeoutSecondsFromPolicy(requestTimeoutMs: number): number {
  const headroom = requestTimeoutMs > AGORA_TIMEOUT_HEADROOM_MS * 2 ? AGORA_TIMEOUT_HEADROOM_MS : 0;
  return Math.max(1, Math.floor((requestTimeoutMs - headroom) / 1000));
}

function resolveAgoraTimeoutSeconds(value: unknown, requestTimeoutMs: number): number {
  const policyLimit = Math.min(
    AGORA_TIMEOUT_CAP_SECONDS,
    timeoutSecondsFromPolicy(requestTimeoutMs)
  );
  if (value === undefined || value === null || value === '') return policyLimit;
  const configured = Number(value);
  if (!Number.isFinite(configured) || configured <= 0) return policyLimit;
  return Math.min(configured, policyLimit);
}

function commandExists(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(command: string): string | null {
  const envPath = process.env.PATH || '';
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (commandExists(candidate)) return candidate;
  }
  return null;
}

function bundledAgoraCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, '../../resources/agora/bin/agora'),
    path.resolve(here, '../../../resources/agora/bin/agora'),
    path.resolve(process.cwd(), 'resources/agora/bin/agora'),
  ];
}

function resolveAgoraCommand(runtime?: AgoraRuntimeConfig): { command: string; args: string[] } {
  const configured = runtime?.command?.trim();
  if (configured) return { command: configured, args: runtime?.args ?? ['mcp', 'serve'] };

  const envCommand = process.env.MA_AGORA_COMMAND?.trim();
  if (envCommand) return { command: envCommand, args: runtime?.args ?? ['mcp', 'serve'] };

  for (const candidate of bundledAgoraCandidates()) {
    if (commandExists(candidate)) return { command: candidate, args: ['mcp', 'serve'] };
  }

  const pathAgora = findOnPath('agora');
  if (pathAgora) return { command: pathAgora, args: ['mcp', 'serve'] };

  const devFallback = '/Users/zhuqingyu/dev/agora/.venv/bin/agora';
  if (commandExists(devFallback)) return { command: devFallback, args: ['mcp', 'serve'] };

  throw new Error(
    'Agora provider requires an Agora runtime command. Set model.agoraRuntime.command or MA_AGORA_COMMAND.'
  );
}

function resolveAgoraDataRoot(runtime?: AgoraRuntimeConfig): string {
  return path.resolve(
    runtime?.dataRoot?.trim() ||
      process.env.MA_AGORA_DATA_ROOT?.trim() ||
      path.join(os.homedir(), '.my-agent', 'agora')
  );
}

function safeUserId(): string {
  try {
    return os.userInfo().username || 'local-user';
  } catch {
    return process.env.USER || 'local-user';
  }
}

function defaultProjectId(cwd?: string): string {
  const base = path.basename(cwd || process.cwd()).trim();
  return base || 'my-agent';
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function normalizeToolCalls(value: unknown): ChatCompletionMessageToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ChatCompletionMessageToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, any>;
    const fn = raw.function;
    if (!fn || typeof fn !== 'object' || typeof fn.name !== 'string' || !fn.name) continue;
    out.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `call_agora_${out.length + 1}`,
      type: 'function',
      function: {
        name: fn.name,
        arguments: stringifyArgs(fn.arguments),
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

function stateFromChatPayload(payload: Record<string, any>): ProviderSessionState {
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const memory =
    payload.memory && typeof payload.memory === 'object'
      ? payload.memory
      : metadata.memory && typeof metadata.memory === 'object'
        ? metadata.memory
        : {};
  const activePatchIds = toStringList(
    payload.active_memory_patch_ids ??
      memory.active_memory_patch_ids ??
      metadata.active_memory_patch_ids
  );
  const profileId =
    typeof memory.profile_id === 'string'
      ? memory.profile_id
      : typeof metadata.memory_profile_id === 'string'
        ? metadata.memory_profile_id
        : undefined;
  const bindingId = typeof memory.binding_id === 'string' ? memory.binding_id : undefined;
  const enabled = typeof memory.enabled === 'boolean' ? memory.enabled : undefined;
  const reason = typeof memory.reason === 'string' ? memory.reason : undefined;
  const status = enabled === false
    ? 'disabled'
    : activePatchIds.length > 0
      ? 'mounted'
      : profileId
        ? 'empty'
        : 'unmounted';
  const verifiedAt = new Date().toISOString();
  return {
    provider_id: 'agora',
    agora_session_id:
      typeof payload.session_id === 'string'
        ? payload.session_id
        : typeof metadata.session_id === 'string'
          ? metadata.session_id
          : undefined,
    memory: {
      status,
      profile_id: profileId,
      binding_id: bindingId,
      active_memory_patch_ids: activePatchIds,
      enabled,
      reason,
      last_verified_at: verifiedAt,
    },
    last_verified_at: verifiedAt,
  };
}

function isErrorPayload(payload: Record<string, any>): boolean {
  return payload.status === 'failed' || Boolean(payload.error);
}

function errorText(payload: Record<string, any>): string {
  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  const job = payload.job;
  if (job && typeof job === 'object') {
    if (typeof job.error === 'string' && job.error.trim()) return job.error;
    if (typeof job.stage === 'string' && job.stage.trim()) return job.stage;
  }
  const result = payload.result;
  if (result && typeof result === 'object') {
    if (typeof result.error === 'string' && result.error.trim()) return result.error;
    if (typeof result.compiler_status === 'string' && result.compiler_status.trim()) {
      return `Agora MCP tool failed with compiler_status=${result.compiler_status}`;
    }
  }
  if (typeof payload.message === 'string') return payload.message;
  return 'Agora MCP tool returned a failed payload';
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function parseProgressMessage(message?: string): Record<string, any> | null {
  if (!message) return null;
  try {
    return asRecord(JSON.parse(message));
  } catch {
    return null;
  }
}

function progressNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function compactId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function agoraProgressLabel(phase: string | undefined, event: Record<string, any>): string {
  const details = asRecord(event.details) ?? {};
  const model = typeof details.model === 'string' && details.model ? ` ${details.model}` : '';
  const session = compactId(details.session_id);
  const sessionSuffix = session ? ` · ${session}` : '';
  switch (phase) {
    case 'queued':
      return 'Agora · 排队中';
    case 'validating':
      return 'Agora · 校验请求';
    case 'resolving_session':
      return 'Agora · 准备会话与记忆';
    case 'model_load':
      return `Agora · 加载本地模型${model}${sessionSuffix}`;
    case 'memory_mount':
      return `Agora · 挂载记忆${sessionSuffix}`;
    case 'generation':
      return `Agora · 生成回复${sessionSuffix}`;
    case 'completed':
      return 'Agora · 完成';
    default: {
      const message = typeof event.message === 'string' ? event.message : '';
      return message ? `Agora · ${message}` : 'Agora · 运行中';
    }
  }
}

function providerProgressFromMcp(event: McpProgressEvent): ProviderProgressEvent {
  const parsed = parseProgressMessage(event.message);
  const hostEvent = asRecord(parsed?.event) ?? null;
  if (!hostEvent) {
    return {
      type: 'progress',
      provider: 'agora',
      message: event.message || 'Agora · 运行中',
      progress: event.progress,
      total: event.total,
    };
  }
  const phase = typeof hostEvent.phase === 'string' ? hostEvent.phase : undefined;
  return {
    type: 'progress',
    provider: 'agora',
    phase,
    operation: typeof hostEvent.operation === 'string' ? hostEvent.operation : undefined,
    message: agoraProgressLabel(phase, hostEvent),
    progress: progressNumber(event.progress, hostEvent.progress),
    total: progressNumber(event.total, hostEvent.total),
    details: asRecord(hostEvent.details) ?? undefined,
  };
}

export class AgoraProviderRuntime implements AgoraMemoryController {
  readonly client: any = null;
  readonly policy: ProviderPolicy;

  private mcp: McpClient | null = null;
  private readyPromise: Promise<void> | null = null;
  private toolNames = new Set<string>();
  private resources: string[] = [];
  private lastState: ProviderSessionState | null = null;
  private selectedProfileId: string | null = null;
  private doctorPayload: Record<string, any> | null = null;
  private modelsPayload: Record<string, any> | null = null;

  constructor(
    private readonly model: ModelConfig,
    policy: ProviderPolicy,
    private readonly context: AgoraProviderContext = {}
  ) {
    this.policy = policy;
    this.selectedProfileId = model.agoraMemory?.memoryProfile ?? null;
  }

  async ready(): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.start();
    return this.readyPromise;
  }

  memoryReady(): boolean {
    for (const name of REQUIRED_MEMORY_TOOLS) {
      if (!this.toolNames.has(name)) return false;
    }
    return true;
  }

  getProviderState(): ProviderSessionState | null {
    return this.lastState;
  }

  getMemoryController(): AgoraMemoryController | null {
    return this.memoryReady() ? this : null;
  }

  async close(): Promise<void> {
    const client = this.mcp;
    this.mcp = null;
    if (client) await client.close();
  }

  async createChatCompletion(
    request: ChatCompletionCreateParamsNonStreaming,
    options?: ProviderRunOptions
  ): Promise<ChatCompletion> {
    const payload = await this.chatCompletePayload(request, options);
    return this.toChatCompletion(payload);
  }

  async createStreamingChatCompletion(
    request: ChatCompletionCreateParamsStreaming,
    options?: ProviderRunOptions
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    const completion = await this.createChatCompletion(
      { ...(request as any), stream: false },
      options
    );
    return this.toSyntheticStream(completion);
  }

  async status(): Promise<AgoraMemoryToolResult> {
    return {
      content: JSON.stringify(
        {
          ok: true,
          provider: 'agora',
          ready_tools: [...this.toolNames].sort(),
          resources: this.resources,
          memory_capability_ready: this.memoryReady(),
          provider_state: this.lastState,
          doctor: this.doctorPayload,
          models: this.modelsPayload,
        },
        null,
        2
      ),
      isError: false,
    };
  }

  async mount(args: Record<string, any>): Promise<AgoraMemoryToolResult> {
    try {
      this.ensureMemoryReady();
      const profileId = this.resolveProfileId(args);
      const patchIds = this.patchIdsFromArgs(args);
      await this.upsertProfile(profileId, patchIds.length > 0 ? patchIds : undefined, true);
      const bindingId = await this.ensureBinding(profileId);
      const verified = await this.verifyMemoryState({
        profileId,
        expectedPatchIds: patchIds.length > 0 ? patchIds : undefined,
      });
      this.selectedProfileId = profileId;
      return this.ok({
        action: 'mount',
        profile_id: profileId,
        binding_id: bindingId,
        provider_state: verified,
      });
    } catch (err) {
      return this.fail(err);
    }
  }

  async disable(args: Record<string, any>): Promise<AgoraMemoryToolResult> {
    try {
      this.ensureMemoryReady();
      const profileId = this.resolveProfileId(args);
      await this.upsertProfile(profileId, undefined, false);
      const verified = await this.verifyMemoryState({ profileId, expectedPatchIds: [] });
      this.selectedProfileId = profileId;
      return this.ok({
        action: 'disable',
        profile_id: profileId,
        provider_state: verified,
      });
    } catch (err) {
      return this.fail(err);
    }
  }

  async internalize(args: Record<string, any>): Promise<AgoraMemoryToolResult> {
    try {
      this.ensureMemoryReady();
      const sessionId = this.lastState?.agora_session_id;
      if (!sessionId) {
        throw new Error('Agora session is not established yet; run one Agora chat turn before internalizing memory.');
      }
      const submitted = await this.callJsonTool('memory_intake_run', { session_id: sessionId });
      const jobId = typeof submitted.job_id === 'string' ? submitted.job_id : submitted.job?.id;
      if (typeof jobId !== 'string' || !jobId) throw new Error('memory_intake_run did not return job_id');
      const batchId = typeof submitted.batch_id === 'string' ? submitted.batch_id : undefined;
      const usesMultiTargetIntake = Boolean(batchId && this.toolNames.has('memory_intake_batch_get'));
      let current = submitted;
      for (let i = 0; i < 120; i++) {
        if (TERMINAL_INTAKE_STATUSES.has(String(current.status))) break;
        await sleep(500);
        if (usesMultiTargetIntake) {
          const batch = await this.callJsonTool('memory_intake_batch_get', { batch_id: batchId });
          const targets = Array.isArray(batch.targets) ? batch.targets : [];
          const target = targets.find((item: any) => item?.id === jobId) ?? targets[0];
          current = target && typeof target === 'object'
            ? {
                ...target,
                batch_id: batchId,
                source_id: batch.batch?.source_snapshot_id,
              }
            : batch;
        } else {
          current = await this.callJsonTool('memory_intake_get', { job_id: jobId });
        }
      }
      if (['failed', 'review', 'conflict'].includes(String(current.status))) {
        throw new Error(errorText(current));
      }
      const patchId =
        typeof current.output_memory_patch_id === 'string'
          ? current.output_memory_patch_id
          : typeof current.output_patch_id === 'string'
            ? current.output_patch_id
            : typeof current.job?.output_memory_patch_id === 'string'
              ? current.job.output_memory_patch_id
              : undefined;
      if (!patchId) {
        return this.ok({
          action: 'internalize',
          status: 'noop',
          job_id: jobId,
          source_id: current.source_id ?? current.job?.source_id,
          message: 'memory intake completed but did not produce a MemoryPatch',
          job: current.job,
        });
      }
      const profileId = this.resolveProfileId(args);
      await this.upsertProfile(profileId, [patchId], true);
      const bindingId = await this.ensureBinding(profileId);
      const verified = await this.verifyMemoryState({ profileId, expectedPatchIds: [patchId] });
      this.selectedProfileId = profileId;
      return this.ok({
        action: 'internalize',
        status: 'mounted',
        profile_id: profileId,
        binding_id: bindingId,
        job_id: jobId,
        source_id: current.source_id ?? current.job?.source_id,
        output_memory_patch_id: patchId,
        provider_state: verified,
      });
    } catch (err) {
      return this.fail(err);
    }
  }

  async rollback(args: Record<string, any>): Promise<AgoraMemoryToolResult> {
    try {
      this.ensureMemoryReady();
      const profileId = this.resolveProfileId(args);
      const targetPatchId = typeof args.patch_id === 'string' && args.patch_id.trim()
        ? args.patch_id.trim()
        : typeof args.target_patch_id === 'string' && args.target_patch_id.trim()
          ? args.target_patch_id.trim()
          : await this.resolveRollbackPatchId();
      if (!targetPatchId) throw new Error('rollback requires patch_id when there is no single previous patch candidate');
      await this.upsertProfile(profileId, [targetPatchId], true);
      const bindingId = await this.ensureBinding(profileId);
      const verified = await this.verifyMemoryState({ profileId, expectedPatchIds: [targetPatchId] });
      this.selectedProfileId = profileId;
      return this.ok({
        action: 'rollback',
        profile_id: profileId,
        binding_id: bindingId,
        active_memory_patch_ids: [targetPatchId],
        provider_state: verified,
      });
    } catch (err) {
      return this.fail(err);
    }
  }

  private async start(): Promise<void> {
    const runtime = this.model.agoraRuntime;
    const command = resolveAgoraCommand(runtime);
    const dataRoot = resolveAgoraDataRoot(runtime);
    fs.mkdirSync(dataRoot, { recursive: true });
    const child = spawn(command.command, command.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: runtime?.cwd,
      env: buildMcpEnv({
        ...(runtime?.env ?? {}),
        AGORA_DATA_ROOT: dataRoot,
      }),
    });
    this.mcp = new McpClient('agora-provider', child, this.policy.requestTimeoutMs);
    try {
      await this.mcp.initialize();
      const tools = await this.mcp.listTools();
      this.toolNames = new Set(tools.map((tool) => tool.name));
      for (const name of REQUIRED_TOOLS) {
        if (!this.toolNames.has(name)) throw new Error(`Agora MCP missing required tool: ${name}`);
      }
      try {
        const resources = await this.mcp.request('resources/list', {});
        const raw = Array.isArray(resources?.resources) ? resources.resources : [];
        this.resources = raw.map((item: any) => String(item?.uri ?? '')).filter(Boolean);
      } catch {
        this.resources = [];
      }
      this.doctorPayload = await this.callJsonTool('doctor', {}, undefined, false);
      this.modelsPayload = await this.callJsonTool('models_list', {}, undefined, false);
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  private ensureMemoryReady(): void {
    if (!this.memoryReady()) {
      throw new Error('Agora memory actions require all Agora MCP memory tools to be available.');
    }
  }

  private async callJsonTool(
    toolName: string,
    args: Record<string, any>,
    signal?: AbortSignal,
    waitForReady = true,
    onProgress?: (event: McpProgressEvent) => void
  ): Promise<Record<string, any>> {
    if (waitForReady) await this.ready();
    if (!this.mcp) throw new Error('Agora MCP runtime is not running');
    const result = await this.mcp.call(toolName, args, signal, onProgress);
    let payload: unknown;
    try {
      payload = JSON.parse(result.content || '{}');
    } catch (err) {
      throw new Error(`Agora MCP tool ${toolName} returned non-JSON content: ${(err as Error).message}`);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`Agora MCP tool ${toolName} returned invalid JSON payload`);
    }
    const record = payload as Record<string, any>;
    if (result.isError || isErrorPayload(record)) throw new Error(errorText(record));
    return record;
  }

  private async chatCompletePayload(
    request: ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming,
    options?: ProviderRunOptions,
    metadataOverride?: Record<string, any>
  ): Promise<Record<string, any>> {
    await this.ready();
    const rawRequest = request as any;
    const payload = await this.callJsonTool(
      'chat_complete',
      {
        model: this.model.model,
        messages: rawRequest.messages ?? [],
        session_history_mode: 'replace',
        metadata: this.buildMetadata(rawRequest.metadata, metadataOverride),
        max_tokens: rawRequest.max_tokens ?? this.model.maxTokens ?? DEFAULT_AGORA_MAX_TOKENS,
        temperature: rawRequest.temperature ?? this.model.temperature ?? 0.6,
        timeout_seconds: resolveAgoraTimeoutSeconds(rawRequest.timeout_seconds, this.policy.requestTimeoutMs),
        ...(rawRequest.stop !== undefined ? { stop: rawRequest.stop } : {}),
        ...(rawRequest.tools !== undefined ? { tools: rawRequest.tools } : {}),
        ...(rawRequest.tool_choice !== undefined ? { tool_choice: rawRequest.tool_choice } : {}),
      },
      options?.signal,
      true,
      options?.onEvent
        ? (event) => options.onEvent?.(providerProgressFromMcp(event))
        : undefined
    );
    this.lastState = stateFromChatPayload(payload);
    return payload;
  }

  private buildMetadata(
    requestMetadata?: unknown,
    override?: Record<string, any>
  ): Record<string, any> {
    const memory: AgoraMemoryConfig = this.model.agoraMemory ?? {};
    const base: Record<string, any> = {};
    if (requestMetadata && typeof requestMetadata === 'object' && !Array.isArray(requestMetadata)) {
      Object.assign(base, requestMetadata);
    }
    base.user_id = memory.userId || base.user_id || safeUserId();
    base.project_id = memory.projectId || base.project_id || defaultProjectId(this.context.cwd);
    base.conversation_id = memory.conversationId || base.conversation_id || this.context.sessionId || 'default';
    const profileId = override?.memory_profile || this.selectedProfileId || memory.memoryProfile;
    if (profileId) base.memory_profile = profileId;
    if (memory.memoryEnabled !== undefined) base.memory_enabled = memory.memoryEnabled;
    if (override) Object.assign(base, override);
    return base;
  }

  private toChatCompletion(payload: Record<string, any>): ChatCompletion {
    const message = payload.message && typeof payload.message === 'object' ? payload.message : {};
    const toolCalls = normalizeToolCalls((message as any).tool_calls);
    const content =
      typeof (message as any).content === 'string'
        ? (message as any).content
        : typeof payload.output_text === 'string'
          ? payload.output_text
          : '';
    return {
      id: typeof payload.id === 'string' ? payload.id : `chatcmpl_agora_${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: this.model.model,
      choices: [
        {
          index: 0,
          finish_reason: (payload.finish_reason as any) ?? (toolCalls ? 'tool_calls' : 'stop'),
          message: {
            role: 'assistant',
            content,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
        },
      ],
    } as ChatCompletion;
  }

  private toSyntheticStream(completion: ChatCompletion): AsyncIterable<ChatCompletionChunk> {
    const message = completion.choices[0]?.message as any;
    const content = typeof message?.content === 'string' ? message.content : '';
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const finishReason = completion.choices[0]?.finish_reason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');
    return {
      async *[Symbol.asyncIterator]() {
        if (content) {
          yield {
            id: completion.id,
            object: 'chat.completion.chunk',
            created: completion.created,
            model: completion.model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          } as ChatCompletionChunk;
        }
        if (toolCalls.length > 0) {
          yield {
            id: completion.id,
            object: 'chat.completion.chunk',
            created: completion.created,
            model: completion.model,
            choices: [
              {
                index: 0,
                finish_reason: null,
                delta: {
                  tool_calls: toolCalls.map((toolCall: any, index: number) => ({
                    index,
                    id: toolCall.id,
                    type: 'function',
                    function: {
                      name: toolCall.function?.name ?? '',
                      arguments: toolCall.function?.arguments ?? '{}',
                    },
                  })),
                },
              },
            ],
          } as ChatCompletionChunk;
        }
        yield {
          id: completion.id,
          object: 'chat.completion.chunk',
          created: completion.created,
          model: completion.model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason as any }],
        } as ChatCompletionChunk;
      },
    };
  }

  private async upsertProfile(
    profileId: string,
    activePatchIds: string[] | undefined,
    memoryEnabled: boolean
  ): Promise<void> {
    const listed = await this.callJsonTool('memory_profiles_list', { base_model_id: this.model.model });
    const profiles = Array.isArray(listed.profiles) ? listed.profiles : [];
    const exists = profiles.some((profile: any) => profile?.id === profileId);
    if (exists) {
      await this.callJsonTool('memory_profiles_update', {
        profile_id: profileId,
        ...(activePatchIds !== undefined ? { active_memory_patch_ids: activePatchIds } : {}),
        memory_enabled: memoryEnabled,
      });
      return;
    }
    if (activePatchIds === undefined) {
      throw new Error(`memory profile does not exist and no patch ids were provided: ${profileId}`);
    }
    await this.callJsonTool('memory_profiles_create', {
      id: profileId,
      base_model_id: this.model.model,
      active_memory_patch_ids: activePatchIds,
      memory_enabled: memoryEnabled,
    });
  }

  private async ensureBinding(profileId: string): Promise<string | undefined> {
    const metadata = this.buildMetadata(undefined, { memory_profile: profileId });
    const listed = await this.callJsonTool('memory_profile_bindings_list', { profile_id: profileId });
    const bindings = Array.isArray(listed.bindings) ? listed.bindings : [];
    const match = bindings.find((binding: any) =>
      binding?.user_id === metadata.user_id &&
      binding?.project_id === metadata.project_id &&
      binding?.conversation_id === metadata.conversation_id
    );
    if (match?.id) return String(match.id);
    const created = await this.callJsonTool('memory_profile_bindings_create', {
      profile_id: profileId,
      user_id: metadata.user_id,
      project_id: metadata.project_id,
      conversation_id: metadata.conversation_id,
    });
    return typeof created.binding?.id === 'string' ? created.binding.id : undefined;
  }

  private async verifyMemoryState(input: {
    profileId: string;
    expectedPatchIds?: string[];
  }): Promise<ProviderSessionState> {
    await this.chatCompletePayload(
      {
        model: this.model.model,
        messages: [{ role: 'user', content: 'Verify Agora memory state.' }],
        stream: false,
        max_tokens: 4,
      } as ChatCompletionCreateParamsNonStreaming,
      undefined,
      { memory_profile: input.profileId }
    );
    const state = this.lastState;
    if (!state) throw new Error('Agora verification did not produce provider state');
    if (state.memory?.profile_id !== input.profileId) {
      throw new Error(`Agora verification did not mount requested profile ${input.profileId}`);
    }
    if (input.expectedPatchIds !== undefined) {
      const actual = state.memory?.active_memory_patch_ids ?? [];
      if (JSON.stringify(actual) !== JSON.stringify(input.expectedPatchIds)) {
        throw new Error(
          `Agora verification patch mismatch: expected ${JSON.stringify(input.expectedPatchIds)}, got ${JSON.stringify(actual)}`
        );
      }
    }
    return state;
  }

  private async resolveRollbackPatchId(): Promise<string | null> {
    const current = this.lastState?.memory?.active_memory_patch_ids?.[0];
    if (!current) return null;
    const versions = await this.callJsonTool('memory_patch_versions', { patch_id: current });
    const patches = Array.isArray(versions.patches) ? versions.patches : [];
    const candidates = patches
      .filter((patch: any) => typeof patch?.id === 'string' && patch.id !== current)
      .map((patch: any) => String(patch.id));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) return null;
    throw new Error(`rollback has multiple candidates; pass patch_id explicitly: ${candidates.join(', ')}`);
  }

  private resolveProfileId(args: Record<string, any>): string {
    const raw =
      typeof args.profile_id === 'string'
        ? args.profile_id
        : typeof args.memory_profile === 'string'
          ? args.memory_profile
          : this.selectedProfileId || this.model.agoraMemory?.memoryProfile || `ma-${this.context.sessionId || 'default'}`;
    const profileId = raw.trim();
    if (!profileId) throw new Error('profile_id must be a non-empty string');
    return profileId;
  }

  private patchIdsFromArgs(args: Record<string, any>): string[] {
    const list = Array.isArray(args.active_memory_patch_ids)
      ? args.active_memory_patch_ids
      : Array.isArray(args.patch_ids)
        ? args.patch_ids
        : undefined;
    if (list) {
      return list.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0);
    }
    if (typeof args.patch_id === 'string' && args.patch_id.trim()) return [args.patch_id.trim()];
    return [];
  }

  private ok(payload: Record<string, any>): AgoraMemoryToolResult {
    return { content: JSON.stringify({ ok: true, ...payload }, null, 2), isError: false };
  }

  private fail(err: unknown): AgoraMemoryToolResult {
    const message = err instanceof Error ? err.message : String(err);
    return { content: JSON.stringify({ ok: false, error: message }, null, 2), isError: true };
  }
}

export function createAgoraProviderRuntime(
  model: ModelConfig,
  policy: ProviderPolicy,
  context?: AgoraProviderContext
): AgoraProviderRuntime {
  return new AgoraProviderRuntime(
    {
      ...model,
      provider: 'agora',
      apiKey: model.apiKey || AGORA_MCP_API_KEY,
    },
    policy,
    context
  );
}

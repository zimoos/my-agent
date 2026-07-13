import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import agoraReleaseLock from './agora-runtime-lock.json' with { type: 'json' };
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

export interface AgoraCapabilities {
  chat: boolean;
  modelCatalog: boolean;
  modelDownload: boolean;
  profileRead: boolean;
  profileWrite: boolean;
  patchCatalog: boolean;
  mount: boolean;
  intake: boolean;
  lineageCas: boolean;
  rollback: boolean;
  progress: boolean;
  memoryV2: boolean;
  namedMemories: boolean;
  multiTargetIntake: boolean;
  incrementalSegments: boolean;
  multiPatchMount: boolean;
  requestBoundaryHotSwap: boolean;
  runtimeMode: 'v2' | 'legacy' | 'unavailable';
}

export interface AgoraRuntimeContract {
  runtime_version?: string;
  host_protocol?: string;
  host_protocol_major?: number;
  registry_schema_version?: number;
  native_core_abi?: number;
  capabilities?: Record<string, number | boolean | string>;
  memory_runtime_v2?: { enabled?: boolean; rollback?: string };
}

export interface AgoraMemory {
  id: string;
  name: string;
  normalized_name?: string;
  base_model_id: string;
  head_patch_id?: string | null;
  status: string;
  metadata?: Record<string, any>;
}

export interface AgoraMemoryProfile {
  id: string;
  name: string;
  base_model_id: string;
  active_memory_patch_ids: string[];
  auto_intake_target_memory_ids?: string[];
  writable_patch_family?: string | null;
  auto_intake_policy?: {
    enabled?: boolean;
    min_user_turns?: number;
    min_pending_tokens?: number;
    idle_seconds?: number;
    activation_mode?: 'auto' | 'review';
  };
  memory_enabled?: boolean;
  status?: string;
}

export interface AgoraMemoryPatch {
  id: string;
  name: string;
  base_model_id: string;
  family: string;
  version: string;
  mountable: boolean;
  status: string;
  memory_id?: string | null;
  normalized_name?: string | null;
  parent_patch_id?: string | null;
  segment_ids?: string[];
}

export type AgoraIntakeTargetStatus =
  | 'queued'
  | 'compiling'
  | 'completed'
  | 'noop'
  | 'review'
  | 'conflict'
  | 'failed';

export interface AgoraMemoryIntakeTarget {
  mode: 'create' | 'increment';
  name?: string;
  memory_id?: string;
  expected_parent_patch_id?: string | null;
  output_name: string;
}

export interface AgoraMemoryIntakeTargetResult {
  id: string;
  batch_id: string;
  mode: 'create' | 'increment';
  memory_id?: string | null;
  memory_name?: string | null;
  output_name: string;
  expected_parent_patch_id?: string | null;
  status: AgoraIntakeTargetStatus;
  output_patch_id?: string | null;
  error?: { code?: string; message?: string; retryable?: boolean } | null;
  result?: Record<string, any> | null;
}

export interface AgoraMemoryIntakeBatchResult {
  status: string;
  batch_id: string;
  batch?: Record<string, any>;
  targets: AgoraMemoryIntakeTargetResult[];
}

export class AgoraMcpError extends Error {
  readonly code?: string;
  readonly field?: string;
  readonly retryable?: boolean;
  readonly payload: Record<string, any>;

  constructor(message: string, payload: Record<string, any>) {
    super(message);
    this.name = 'AgoraMcpError';
    const error = asRecord(payload.error) ?? {};
    this.code = typeof error.code === 'string'
      ? error.code
      : typeof error.type === 'string' ? error.type : undefined;
    this.field = typeof error.field === 'string' ? error.field : undefined;
    this.retryable = typeof error.retryable === 'boolean' ? error.retryable : undefined;
    this.payload = payload;
  }
}

export interface AgoraMemoryController {
  getCapabilities(): AgoraCapabilities;
  getRuntimeContract(): AgoraRuntimeContract | null;
  updateLocalMemoryState(patch: Record<string, unknown>): void;
  listMemories(): Promise<AgoraMemory[]>;
  getMemory(memoryId: string): Promise<AgoraMemory>;
  createMemory(name: string, id?: string): Promise<AgoraMemory>;
  renameMemory(memoryId: string, name: string): Promise<AgoraMemory>;
  listProfiles(): Promise<AgoraMemoryProfile[]>;
  listPatches(includeDisabled?: boolean): Promise<AgoraMemoryPatch[]>;
  createProfile(args: Record<string, any>): Promise<Record<string, any>>;
  renameProfile(profileId: string, name: string): Promise<Record<string, any>>;
  selectProfile(profileId: string, scope?: 'user' | 'project' | 'conversation'): Promise<Record<string, any>>;
  applyPatchSelection(profileId: string, patchIds: string[], writableFamily?: string | null): Promise<Record<string, any>>;
  mountMemories(profileId: string, memoryIds: string[], scope?: 'user' | 'project' | 'conversation'): Promise<Record<string, any>>;
  getIntakeStatus(): Promise<Record<string, any>>;
  startIntake(args?: Record<string, any>): Promise<Record<string, any>>;
  finalizeIntake(jobId: string, profileId: string): Promise<Record<string, any>>;
  startBatchIntake(args: {
    targets: AgoraMemoryIntakeTarget[];
    source_message_start?: number;
    source_message_end?: number;
  }): Promise<AgoraMemoryIntakeBatchResult>;
  getBatchIntake(batchId: string): Promise<AgoraMemoryIntakeBatchResult>;
  applyCompletedBatch(batch: AgoraMemoryIntakeBatchResult, profileId: string): Promise<Record<string, any>>;
  setAutoPolicy(profileId: string, enabled: boolean, targetMemoryIds?: string[]): Promise<Record<string, any>>;
  rollbackMemory(memoryId: string, expectedHeadPatchId: string, targetPatchId: string): Promise<AgoraMemory>;
  listModels(): Promise<Record<string, any>[]>;
  downloadModel(modelId: string, onProgress?: (event: McpProgressEvent) => void): Promise<Record<string, any>>;
  status(args?: Record<string, any>): Promise<AgoraMemoryToolResult>;
  mount(args: Record<string, any>): Promise<AgoraMemoryToolResult>;
  disable(args: Record<string, any>): Promise<AgoraMemoryToolResult>;
  internalize(args: Record<string, any>): Promise<AgoraMemoryToolResult>;
  rollback(args: Record<string, any>): Promise<AgoraMemoryToolResult>;
}

const REQUIRED_TOOLS = new Set(['doctor', 'models_list', 'chat_complete']);
const TERMINAL_INTAKE_STATUSES = new Set(['completed', 'failed']);
const DEFAULT_AGORA_MAX_TOKENS = 4096;
const AGORA_TIMEOUT_CAP_SECONDS = 300;
const AGORA_TIMEOUT_HEADROOM_MS = 5000;

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

interface ResolvedAgoraCommand {
  command: string;
  args: string[];
  trust: 'verified' | 'unverified';
  source: 'configured' | 'override' | 'bundled' | 'npm' | 'path';
  lock?: Record<string, any>;
}

export function parseDeveloperIdSignature(details: string): boolean {
  return details.split(/\r?\n/).some((line) => line.startsWith('Authority=Developer ID Application:')) &&
    details.split(/\r?\n/).some((line) => line.startsWith('TeamIdentifier=') && line !== 'TeamIdentifier=not set');
}

function verifyNativeSignature(command: string): boolean {
  if (process.platform !== 'darwin') return true;
  if (spawnSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', command], { stdio: 'ignore' }).status !== 0) {
    return false;
  }
  const details = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', command], { encoding: 'utf8' });
  return details.status === 0 && parseDeveloperIdSignature(`${details.stdout ?? ''}\n${details.stderr ?? ''}`);
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function verifyAgoraManifestFiles(root: string, manifest: Record<string, any>): boolean {
  const files = asRecord(manifest.files);
  if (!files || Object.keys(files).length === 0) return false;
  const canonicalRoot = path.resolve(root);
  return Object.entries(files).every(([relative, expected]) => {
    if (typeof expected !== 'string' || path.isAbsolute(relative)) return false;
    const target = path.resolve(canonicalRoot, relative);
    if (!target.startsWith(`${canonicalRoot}${path.sep}`) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) return false;
    return sha256File(target) === expected;
  });
}

function verifyBundledAgora(command: string): Record<string, any> | null {
  const root = path.dirname(path.dirname(command));
  const manifestPath = path.join(root, 'manifest.json');
  const lockPath = path.join(root, 'runtime-lock.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(lockPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (agoraReleaseLock.published !== true || lock.published !== true) return null;
    if (!verifyAgoraManifestFiles(root, manifest)) return null;
    if (manifest.version !== lock.version || manifest.host_protocol_major !== lock.host_protocol_major) return null;
    if (lock.native_core_abi !== undefined && manifest.native_core_abi !== lock.native_core_abi) return null;
    if (lock.manifest_sha256 && sha256File(manifestPath) !== lock.manifest_sha256) return null;
    if (lock.manifest_sha256 !== agoraReleaseLock.manifest_sha256) return null;
    if (lock.package_integrity !== agoraReleaseLock.packages['@zimoos/agora-darwin-arm64'].integrity) return null;
    if (lock.notarization_id !== agoraReleaseLock.notarization_id) return null;
    if (!verifyNativeSignature(command)) return null;
    return lock;
  } catch {
    return null;
  }
}

function resolveInstalledAgoraPackage(): ResolvedAgoraCommand | null {
  try {
    if (agoraReleaseLock.published !== true) return null;
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve('@zimoos/agora/package.json');
    const packageRoot = path.dirname(packageJsonPath);
    const platformPackageJsonPath = require.resolve('@zimoos/agora-darwin-arm64/package.json');
    const platformRoot = path.dirname(platformPackageJsonPath);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const platformPackageJson = JSON.parse(fs.readFileSync(platformPackageJsonPath, 'utf8'));
    const manifestPath = path.join(platformRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const command = path.join(packageRoot, 'bin', 'agora');
    const platformCommand = path.join(platformRoot, 'bin', 'agora');
    const expectedVersion = agoraReleaseLock.version;
    const requiredCapabilities = agoraReleaseLock.capabilities ?? [];
    if (
      packageJson.version !== expectedVersion ||
      packageJson.dependencies?.['@zimoos/agora-darwin-arm64'] !== expectedVersion ||
      platformPackageJson.version !== expectedVersion ||
      manifest.version !== expectedVersion ||
      manifest.host_protocol_major !== agoraReleaseLock.host_protocol_major ||
      manifest.native_core_abi !== agoraReleaseLock.native_core_abi ||
      manifest.runtime_layout !== agoraReleaseLock.runtime_layout ||
      !requiredCapabilities.every((capability) => manifest.capabilities?.includes(capability)) ||
      sha256File(manifestPath) !== agoraReleaseLock.manifest_sha256 ||
      !verifyAgoraManifestFiles(platformRoot, manifest) ||
      !commandExists(command) ||
      !commandExists(platformCommand) ||
      !verifyNativeSignature(command) ||
      !verifyNativeSignature(platformCommand)
    ) return null;
    return {
      command,
      args: ['mcp', 'serve'],
      trust: 'verified',
      source: 'npm',
      lock: {
        version: expectedVersion,
        host_protocol_major: agoraReleaseLock.host_protocol_major,
        native_core_abi: agoraReleaseLock.native_core_abi,
        manifest_sha256: agoraReleaseLock.manifest_sha256,
        notarization_id: agoraReleaseLock.notarization_id,
      },
    };
  } catch {
    return null;
  }
}

function resolveAgoraCommand(runtime?: AgoraRuntimeConfig): ResolvedAgoraCommand {
  const configured = runtime?.command?.trim();
  if (configured) return { command: configured, args: runtime?.args ?? ['mcp', 'serve'], trust: 'unverified', source: 'configured' };

  const envCommand = process.env.MA_AGORA_COMMAND?.trim();
  if (envCommand) return { command: envCommand, args: runtime?.args ?? ['mcp', 'serve'], trust: 'unverified', source: 'override' };

  for (const candidate of bundledAgoraCandidates()) {
    if (!commandExists(candidate)) continue;
    const lock = verifyBundledAgora(candidate);
    if (!lock) throw new Error(`Bundled Agora failed integrity verification: ${candidate}`);
    return { command: candidate, args: ['mcp', 'serve'], trust: 'verified', source: 'bundled', lock };
  }

  const installed = resolveInstalledAgoraPackage();
  if (installed) return installed;

  if (process.env.MA_AGORA_ALLOW_UNVERIFIED === '1') {
    const pathAgora = findOnPath('agora');
    if (pathAgora) return { command: pathAgora, args: ['mcp', 'serve'], trust: 'unverified', source: 'path' };
  }

  throw new Error(
    'Agora runtime is not installed in the verified MA bundle. Set MA_AGORA_COMMAND only for an explicit unverified development override.'
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
  const requested = path.resolve(cwd || process.cwd());
  let canonical = requested;
  try {
    canonical = fs.realpathSync.native(requested);
  } catch {
    // Keep the normalized absolute path for a project that is not mounted yet.
  }
  const base = path.basename(canonical).trim() || 'my-agent';
  const suffix = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `${base}-${suffix}`;
}

export function agoraProjectProfileId(cwd?: string): string {
  return `ma-project-${defaultProjectId(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
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

function stateFromChatPayload(
  payload: Record<string, any>,
  requestedPatchIds?: string[] | null
): ProviderSessionState {
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
  const runtime = asRecord(payload.memory_runtime) ?? asRecord(metadata.memory_runtime) ?? {};
  const revision = Number(runtime.patchset_revision);
  const requested = requestedPatchIds ? [...requestedPatchIds] : undefined;
  const matchesRequest = requested === undefined || (
    requested.length === activePatchIds.length &&
    requested.every((id, index) => id === activePatchIds[index])
  );
  const status = enabled === false
    ? 'disabled'
    : !matchesRequest
      ? 'stale'
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
      ...(requested ? { requested_memory_patch_ids: requested } : {}),
      ...(Number.isFinite(revision) ? { patchset_revision: revision } : {}),
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
  private runtimeContract: AgoraRuntimeContract | null = null;
  private requestedPatchIds: string[] | null = null;
  private requestedAfterRevision: number | null = null;
  private runtimeTrust: 'verified' | 'unverified' = 'unverified';
  private runtimeSource = 'unknown';

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
    const capabilities = this.getCapabilities();
    return capabilities.profileRead && capabilities.profileWrite && capabilities.mount;
  }

  getCapabilities(): AgoraCapabilities {
    const has = (name: string) => this.toolNames.has(name);
    const contract = this.runtimeContract?.capabilities ?? {};
    const enabled = (name: string) => contract[name] === 1 || contract[name] === true;
    const namedMemories = has('memories_create') && has('memories_list') && has('memories_rename') && enabled('named_memories');
    const multiTargetIntake = has('memory_intake_batch_run') && has('memory_intake_batch_get') && enabled('multi_target_intake');
    const incrementalSegments = enabled('incremental_segments');
    const multiPatchMount = enabled('multi_model_delta_mount');
    const requestBoundaryHotSwap = enabled('request_boundary_hot_swap');
    const memoryV2 = namedMemories && multiTargetIntake && incrementalSegments && multiPatchMount && requestBoundaryHotSwap && has('memories_rollback');
    return {
      chat: has('chat_complete'),
      modelCatalog: has('models_list') && has('models_status'),
      modelDownload: has('models_download'),
      profileRead: has('memory_profiles_list'),
      profileWrite: has('memory_profiles_create') && has('memory_profiles_update'),
      patchCatalog: has('memory_patches_list'),
      mount: has('memory_profile_bindings_list') && has('memory_profile_bindings_create'),
      intake: has('memory_intake_run') && has('memory_intake_get') && has('memory_intake_status'),
      lineageCas: has('memory_lineage_advance'),
      rollback: has('memory_patch_versions'),
      progress: true,
      memoryV2,
      namedMemories,
      multiTargetIntake,
      incrementalSegments,
      multiPatchMount,
      requestBoundaryHotSwap,
      runtimeMode: memoryV2
        ? 'v2'
        : has('memory_intake_run') && has('memory_profiles_update') ? 'legacy' : 'unavailable',
    };
  }

  getRuntimeContract(): AgoraRuntimeContract | null {
    return this.runtimeContract ? { ...this.runtimeContract } : null;
  }

  updateLocalMemoryState(patch: Record<string, unknown>): void {
    this.lastState = {
      ...(this.lastState ?? { provider_id: 'agora' }),
      memory: { ...(this.lastState?.memory ?? {}), ...patch },
      runtime_trust: this.runtimeTrust,
      runtime_source: this.runtimeSource,
    };
  }

  getProviderState(): ProviderSessionState | null {
    return this.lastState;
  }

  getMemoryController(): AgoraMemoryController | null {
    return this.toolNames.has('chat_complete') ? this : null;
  }

  async listMemories(): Promise<AgoraMemory[]> {
    this.requireV2();
    const payload = await this.callJsonTool('memories_list', { base_model_id: this.model.model });
    return Array.isArray(payload.memories) ? payload.memories as AgoraMemory[] : [];
  }

  async getMemory(memoryId: string): Promise<AgoraMemory> {
    this.requireV2();
    const payload = await this.callJsonTool('memories_get', { memory_id: memoryId });
    const memory = asRecord(payload.memory);
    if (!memory) throw new Error(`Agora did not return Memory: ${memoryId}`);
    return memory as unknown as AgoraMemory;
  }

  async createMemory(name: string, id?: string): Promise<AgoraMemory> {
    this.requireV2();
    const payload = await this.callJsonTool('memories_create', {
      ...(id ? { id } : {}),
      name,
      base_model_id: this.model.model,
    });
    const memory = asRecord(payload.memory);
    if (!memory) throw new Error('Agora did not return the created Memory');
    return memory as unknown as AgoraMemory;
  }

  async renameMemory(memoryId: string, name: string): Promise<AgoraMemory> {
    this.requireV2();
    const payload = await this.callJsonTool('memories_rename', { memory_id: memoryId, name });
    const memory = asRecord(payload.memory);
    if (!memory) throw new Error(`Agora did not return renamed Memory: ${memoryId}`);
    return memory as unknown as AgoraMemory;
  }

  async listProfiles(): Promise<AgoraMemoryProfile[]> {
    this.requireTools('memory_profiles_list');
    const payload = await this.callJsonTool('memory_profiles_list', { base_model_id: this.model.model });
    return Array.isArray(payload.profiles) ? payload.profiles as AgoraMemoryProfile[] : [];
  }

  async listPatches(includeDisabled = false): Promise<AgoraMemoryPatch[]> {
    this.requireTools('memory_patches_list');
    const payload = await this.callJsonTool('memory_patches_list', {
      base_model_id: this.model.model,
      include_disabled: includeDisabled,
    });
    return Array.isArray(payload.patches) ? payload.patches as AgoraMemoryPatch[] : [];
  }

  async createProfile(args: Record<string, any>): Promise<Record<string, any>> {
    this.requireTools('memory_profiles_create');
    const profileId = this.resolveProfileId(args);
    const payload = await this.callJsonTool('memory_profiles_create', {
      id: profileId,
      name: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : profileId,
      base_model_id: this.model.model,
      active_memory_patch_ids: this.patchIdsFromArgs(args),
      auto_intake_target_memory_ids: toStringList(args.auto_intake_target_memory_ids),
      writable_patch_family: typeof args.writable_patch_family === 'string' ? args.writable_patch_family : undefined,
      auto_intake_policy: args.auto_intake_policy ?? { enabled: false },
      memory_enabled: args.memory_enabled !== false,
    });
    await this.ensureBinding(profileId, args.scope === 'conversation' ? 'conversation' : args.scope === 'user' ? 'user' : 'project');
    this.selectedProfileId = profileId;
    return payload;
  }

  async renameProfile(profileId: string, name: string): Promise<Record<string, any>> {
    this.requireTools('memory_profiles_update');
    return this.callJsonTool('memory_profiles_update', { profile_id: profileId, name });
  }

  async selectProfile(
    profileId: string,
    scope: 'user' | 'project' | 'conversation' = 'project'
  ): Promise<Record<string, any>> {
    const profiles = await this.listProfiles();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error(`memory profile not found: ${profileId}`);
    await this.ensureBinding(profileId, scope);
    this.selectedProfileId = profileId;
    return { profile, scope, mount_status: 'pending_next_chat' };
  }

  async applyPatchSelection(
    profileId: string,
    patchIds: string[],
    writableFamily?: string | null
  ): Promise<Record<string, any>> {
    this.requireTools('memory_profiles_update');
    const updated = await this.callJsonTool('memory_profiles_update', {
      profile_id: profileId,
      active_memory_patch_ids: patchIds,
      ...(this.getCapabilities().memoryV2 ? {} : { writable_patch_family: writableFamily ?? null }),
      memory_enabled: true,
    });
    await this.ensureBinding(profileId, 'project');
    this.selectedProfileId = profileId;
    this.markPatchSelectionPending(profileId, patchIds);
    return { ...updated, mount_status: 'pending_next_chat' };
  }

  async mountMemories(
    profileId: string,
    memoryIds: string[],
    scope: 'user' | 'project' | 'conversation' = 'project'
  ): Promise<Record<string, any>> {
    this.requireV2();
    const baseProfileId = profileId.split('--conversation-')[0].replace(/--user-default$/, '');
    const effectiveProfileId = scope === 'conversation'
      ? `${baseProfileId}--conversation-${this.safeScopeId(this.model.agoraMemory?.conversationId || this.context.sessionId || 'default')}`
      : scope === 'user' ? `${baseProfileId}--user-default` : baseProfileId;
    const [memories, patches] = await Promise.all([this.listMemories(), this.listPatches(true)]);
    const selected = memoryIds.map((memoryId) => {
      const memory = memories.find((item) => item.id === memoryId);
      if (!memory) throw new Error(`Memory not found: ${memoryId}`);
      if (!memory.head_patch_id) throw new Error(`Memory has no compiled version yet: ${memory.name}`);
      const patch = patches.find((item) => item.id === memory.head_patch_id);
      if (!patch?.mountable) throw new Error(`Memory version is not mountable: ${memory.name}`);
      if (patch.base_model_id !== this.model.model) throw new Error(`Memory is incompatible with model ${this.model.model}: ${memory.name}`);
      return patch.id;
    });
    await this.upsertProfile(effectiveProfileId, selected, true);
    const bindingId = await this.ensureBinding(effectiveProfileId, scope);
    this.selectedProfileId = effectiveProfileId;
    this.markPatchSelectionPending(effectiveProfileId, selected, bindingId);
    return {
      profile_id: effectiveProfileId,
      binding_id: bindingId,
      memory_ids: memoryIds,
      active_memory_patch_ids: selected,
      mount_status: 'pending_next_chat',
    };
  }

  async getIntakeStatus(): Promise<Record<string, any>> {
    this.requireTools('memory_intake_status');
    const sessionId = this.requireSessionId();
    return this.callJsonTool('memory_intake_status', { session_id: sessionId });
  }

  async startIntake(args: Record<string, any> = {}): Promise<Record<string, any>> {
    this.requireTools('memory_intake_run');
    const sessionId = this.requireSessionId();
    const profileId = this.resolveProfileId(args);
    const profiles = await this.listProfiles();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error(`memory profile not found: ${profileId}`);
    const family = typeof args.into === 'string' && args.into.trim()
      ? args.into.trim()
      : typeof args.writable_patch_family === 'string' && args.writable_patch_family.trim()
        ? args.writable_patch_family.trim()
        : profile.writable_patch_family?.trim();
    if (!family) throw new Error('memory intake requires a writable memory module; use --into <family>');
    const patches = await this.listPatches(true);
    const expected = profile.active_memory_patch_ids.find(
      (id) => patches.find((patch) => patch.id === id)?.family === family
    );
    return this.callJsonTool('memory_intake_run', {
      session_id: sessionId,
      profile_id: profileId,
      writable_patch_family: family,
      ...(expected ? { expected_previous_patch_id: expected } : {}),
    });
  }

  async finalizeIntake(jobId: string, profileId: string): Promise<Record<string, any>> {
    this.requireTools('memory_intake_get');
    const current = await this.callJsonTool('memory_intake_get', { job_id: jobId });
    if (!TERMINAL_INTAKE_STATUSES.has(String(current.status))) return current;
    if (String(current.status) === 'failed') throw new Error(errorText(current));
    const job = asRecord(current.job) ?? current;
    const patchId = typeof job.output_memory_patch_id === 'string'
      ? job.output_memory_patch_id
      : typeof current.output_memory_patch_id === 'string' ? current.output_memory_patch_id : undefined;
    if (!patchId) return { ...current, outcome: 'noop' };
    const profiles = await this.listProfiles();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error(`memory profile not found: ${profileId}`);
    if (profile.auto_intake_policy?.activation_mode === 'review') {
      return { ...current, outcome: 'review_required' };
    }
    this.requireTools('memory_lineage_advance');
    const lineage = asRecord(job.result)?.lineage ?? asRecord(current.result)?.lineage ?? {};
    const advanced = await this.callJsonTool('memory_lineage_advance', {
      profile_id: profileId,
      family: lineage.family ?? profile.writable_patch_family,
      expected_previous_patch_id: lineage.previous_patch_id ?? null,
      new_patch_id: patchId,
      session_id: this.requireSessionId(),
      job_id: jobId,
    });
    return { ...advanced, outcome: 'activated', mount_status: 'pending_next_chat' };
  }

  async startBatchIntake(args: {
    targets: AgoraMemoryIntakeTarget[];
    source_message_start?: number;
    source_message_end?: number;
  }): Promise<AgoraMemoryIntakeBatchResult> {
    this.requireV2();
    if (!Array.isArray(args.targets) || args.targets.length === 0) {
      throw new Error('Memory intake requires at least one explicit target');
    }
    const payload = await this.callJsonTool('memory_intake_batch_run', {
      session_id: this.requireSessionId(),
      targets: args.targets,
      ...(Number.isInteger(args.source_message_start) ? { source_message_start: args.source_message_start } : {}),
      ...(Number.isInteger(args.source_message_end) ? { source_message_end: args.source_message_end } : {}),
    });
    return this.normalizeBatch(payload);
  }

  async getBatchIntake(batchId: string): Promise<AgoraMemoryIntakeBatchResult> {
    this.requireV2();
    return this.normalizeBatch(await this.callJsonTool('memory_intake_batch_get', { batch_id: batchId }));
  }

  async applyCompletedBatch(
    batch: AgoraMemoryIntakeBatchResult,
    profileId: string
  ): Promise<Record<string, any>> {
    this.requireV2();
    const completed = batch.targets.filter((target) => target.status === 'completed' && target.output_patch_id);
    if (completed.length === 0) {
      return { outcome: 'no_completed_targets', targets: batch.targets };
    }
    const [profiles, patches] = await Promise.all([this.listProfiles(), this.listPatches(true)]);
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error(`memory profile not found: ${profileId}`);
    const completedByMemory = new Map<string, string>();
    for (const target of completed) {
      if (target.memory_id && target.output_patch_id) completedByMemory.set(target.memory_id, target.output_patch_id);
    }
    const nextIds: string[] = [];
    for (const patchId of profile.active_memory_patch_ids) {
      const patch = patches.find((item) => item.id === patchId);
      const replacement = patch?.memory_id ? completedByMemory.get(patch.memory_id) : undefined;
      nextIds.push(replacement ?? patchId);
      if (patch?.memory_id) completedByMemory.delete(patch.memory_id);
    }
    nextIds.push(...completedByMemory.values());
    const mounted = await this.applyPatchSelection(profileId, Array.from(new Set(nextIds)));
    return { ...mounted, outcome: 'completed_targets_selected', targets: batch.targets };
  }

  async setAutoPolicy(
    profileId: string,
    enabled: boolean,
    targetMemoryIds?: string[]
  ): Promise<Record<string, any>> {
    this.requireTools('memory_profiles_update');
    const profiles = await this.listProfiles();
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error(`memory profile not found: ${profileId}`);
    return this.callJsonTool('memory_profiles_update', {
      profile_id: profileId,
      ...(targetMemoryIds ? { auto_intake_target_memory_ids: targetMemoryIds } : {}),
      auto_intake_policy: { ...profile.auto_intake_policy, enabled },
    });
  }

  async rollbackMemory(
    memoryId: string,
    expectedHeadPatchId: string,
    targetPatchId: string
  ): Promise<AgoraMemory> {
    this.requireV2();
    const payload = await this.callJsonTool('memories_rollback', {
      memory_id: memoryId,
      expected_head_patch_id: expectedHeadPatchId,
      target_patch_id: targetPatchId,
    });
    const memory = asRecord(payload.memory);
    if (!memory) throw new Error(`Agora did not return rolled back Memory: ${memoryId}`);
    return memory as unknown as AgoraMemory;
  }

  async listModels(): Promise<Record<string, any>[]> {
    this.requireTools('models_list');
    const payload = await this.callJsonTool('models_list', {});
    return Array.isArray(payload.models) ? payload.models : [];
  }

  async downloadModel(
    modelId: string,
    onProgress?: (event: McpProgressEvent) => void
  ): Promise<Record<string, any>> {
    this.requireTools('models_download');
    return this.callJsonTool('models_download', { model_id: modelId }, undefined, true, onProgress);
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
          capabilities: this.getCapabilities(),
          provider_state: this.lastState,
          doctor: this.doctorPayload,
          models: this.modelsPayload,
          runtime_trust: this.runtimeTrust,
          runtime_source: this.runtimeSource,
          runtime_contract: this.runtimeContract,
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
      const memoryIds = toStringList(args.memory_ids);
      if (this.getCapabilities().memoryV2 && Array.isArray(args.memory_ids)) {
        const mounted = await this.mountMemories(
          profileId,
          memoryIds,
          args.scope === 'conversation' ? 'conversation' : args.scope === 'user' ? 'user' : 'project'
        );
        return this.ok({ action: 'mount', ...mounted });
      }
      const patchIds = this.patchIdsFromArgs(args);
      await this.upsertProfile(
        profileId,
        patchIds.length > 0 ? patchIds : undefined,
        true,
        {
          name: typeof args.name === 'string' ? args.name : undefined,
          writablePatchFamily: typeof args.writable_patch_family === 'string'
            ? args.writable_patch_family
            : undefined,
        }
      );
      const bindingId = await this.ensureBinding(
        profileId,
        args.scope === 'conversation' ? 'conversation' : 'project'
      );
      this.selectedProfileId = profileId;
      this.markPatchSelectionPending(profileId, patchIds, bindingId);
      return this.ok({
        action: 'mount',
        profile_id: profileId,
        binding_id: bindingId,
        mount_status: 'pending_next_chat',
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
      this.selectedProfileId = profileId;
      this.markPatchSelectionPending(profileId, []);
      return this.ok({
        action: 'disable',
        profile_id: profileId,
        mount_status: 'pending_next_chat',
      });
    } catch (err) {
      return this.fail(err);
    }
  }

  async internalize(args: Record<string, any>): Promise<AgoraMemoryToolResult> {
    try {
      if (this.getCapabilities().memoryV2) {
        const targets = Array.isArray(args.targets) ? args.targets as AgoraMemoryIntakeTarget[] : [];
        const batch = await this.startBatchIntake({
          targets,
          ...(Number.isInteger(args.source_message_start) ? { source_message_start: args.source_message_start } : {}),
          ...(Number.isInteger(args.source_message_end) ? { source_message_end: args.source_message_end } : {}),
        });
        return this.ok({
          action: 'internalize',
          status: batch.status,
          batch_id: batch.batch_id,
          targets: batch.targets,
          message: 'Memory intake is running in the background; use /memory status to inspect progress.',
        });
      }
      const submitted = await this.startIntake(args);
      const jobId = typeof submitted.job_id === 'string' ? submitted.job_id : submitted.job?.id;
      if (typeof jobId !== 'string' || !jobId) throw new Error('memory_intake_run did not return job_id');
      const profileId = this.resolveProfileId(args);
      return this.ok({
        action: 'internalize',
        status: 'queued',
        profile_id: profileId,
        job_id: jobId,
        source_id: submitted.source_id ?? submitted.job?.source_id,
        message: 'memory intake is running in the background; use /memory status to inspect progress',
      });
    } catch (err) {
      return this.fail(err);
    }
  }

  async rollback(args: Record<string, any>): Promise<AgoraMemoryToolResult> {
    try {
      this.ensureMemoryReady();
      if (this.getCapabilities().memoryV2) {
        const memoryId = String(args.memory_id ?? '').trim();
        const expectedHeadPatchId = String(args.expected_head_patch_id ?? '').trim();
        const targetPatchId = String(args.target_patch_id ?? args.patch_id ?? '').trim();
        if (!memoryId || !expectedHeadPatchId || !targetPatchId) {
          throw new Error('rollback requires memory_id, expected_head_patch_id, and target_patch_id');
        }
        const memory = await this.rollbackMemory(memoryId, expectedHeadPatchId, targetPatchId);
        return this.ok({ action: 'rollback', memory, mount_status: 'pending_explicit_mount' });
      }
      const profileId = this.resolveProfileId(args);
      const targetPatchId = typeof args.patch_id === 'string' && args.patch_id.trim()
        ? args.patch_id.trim()
        : typeof args.target_patch_id === 'string' && args.target_patch_id.trim()
          ? args.target_patch_id.trim()
          : await this.resolveRollbackPatchId();
      if (!targetPatchId) throw new Error('rollback requires patch_id when there is no single previous patch candidate');
      const [profiles, patches] = await Promise.all([this.listProfiles(), this.listPatches(true)]);
      const profile = profiles.find((item) => item.id === profileId);
      const target = patches.find((item) => item.id === targetPatchId);
      if (!profile || !target) throw new Error('rollback profile or target patch not found');
      const nextIds = profile.active_memory_patch_ids.map((id) => {
        const patch = patches.find((item) => item.id === id);
        return patch?.family === target.family ? targetPatchId : id;
      });
      if (!nextIds.includes(targetPatchId)) nextIds.push(targetPatchId);
      const result = await this.applyPatchSelection(profileId, nextIds, profile.writable_patch_family);
      return this.ok({
        action: 'rollback',
        profile_id: profileId,
        active_memory_patch_ids: nextIds,
        mount_status: result.mount_status,
      });
    } catch (err) {
      return this.fail(err);
    }
  }

  private async start(): Promise<void> {
    const runtime = this.model.agoraRuntime;
    const command = resolveAgoraCommand(runtime);
    this.runtimeTrust = command.trust;
    this.runtimeSource = command.source;
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
      if (this.toolNames.has('runtime_capabilities')) {
        const capabilityPayload = await this.callJsonTool('runtime_capabilities', {}, undefined, false);
        this.runtimeContract = (asRecord(capabilityPayload.contract) ?? capabilityPayload) as AgoraRuntimeContract;
      } else {
        this.runtimeContract = asRecord(this.doctorPayload.contract) as AgoraRuntimeContract | null;
      }
      if (command.trust === 'verified') {
        const expectedVersion = command.lock?.version;
        const actualVersion = this.runtimeContract?.runtime_version ?? this.doctorPayload.version;
        const actualMajor = this.runtimeContract?.host_protocol_major;
        if (actualVersion !== expectedVersion || actualMajor !== command.lock?.host_protocol_major) {
          throw new Error(
            `Agora runtime contract mismatch: expected ${expectedVersion}/host-v${command.lock?.host_protocol_major}, ` +
            `got ${actualVersion}/host-v${actualMajor}`
          );
        }
      }
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

  private requireTools(...names: string[]): void {
    const missing = names.filter((name) => !this.toolNames.has(name));
    if (missing.length > 0) {
      throw new Error(`Agora capability unavailable: ${missing.join(', ')}`);
    }
  }

  private requireV2(): void {
    const capabilities = this.getCapabilities();
    if (!capabilities.memoryV2) {
      throw new Error(
        `Agora Memory Runtime v2 is unavailable (runtime mode: ${capabilities.runtimeMode}). ` +
        'Named Memory, multi-target intake, incremental segments, multi-patch mount, hot swap, and rollback are required.'
      );
    }
  }

  private requireSessionId(): string {
    const sessionId = this.lastState?.agora_session_id;
    if (!sessionId) {
      throw new Error('Agora session is not established yet; run one Agora chat turn first.');
    }
    return sessionId;
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
    if (result.isError) {
      throw new Error(result.content || `Agora MCP tool ${toolName} failed`);
    }
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
    if (isErrorPayload(record)) throw new AgoraMcpError(errorText(record), record);
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
    const requestedPatchIds = this.requestedPatchIds;
    const localMemoryState = this.lastState?.memory;
    this.lastState = stateFromChatPayload(payload, requestedPatchIds);
    this.lastState.memory = {
      ...(localMemoryState?.active_batch !== undefined ? { active_batch: localMemoryState.active_batch } : {}),
      ...(localMemoryState?.last_auto_intake_message_end !== undefined
        ? { last_auto_intake_message_end: localMemoryState.last_auto_intake_message_end } : {}),
      ...(localMemoryState?.last_auto_intake_runtime_message_end !== undefined
        ? { last_auto_intake_runtime_message_end: localMemoryState.last_auto_intake_runtime_message_end } : {}),
      ...(this.lastState.memory ?? {}),
      runtime_message_count: Array.isArray(rawRequest.messages) ? rawRequest.messages.length : 0,
    };
    const activePatchIds = this.lastState.memory?.active_memory_patch_ids ?? [];
    const revision = this.lastState.memory?.patchset_revision;
    const revisionAdvanced = this.requestedAfterRevision === null || (
      typeof revision === 'number' && revision > this.requestedAfterRevision
    );
    if (
      requestedPatchIds &&
      requestedPatchIds.length === activePatchIds.length &&
      requestedPatchIds.every((id, index) => id === activePatchIds[index]) &&
      revisionAdvanced
    ) {
      this.requestedPatchIds = null;
      this.requestedAfterRevision = null;
      delete this.lastState.memory?.requested_memory_patch_ids;
    } else if (requestedPatchIds) {
      this.lastState.memory = { ...(this.lastState.memory ?? {}), status: 'stale' };
    }
    if (this.getCapabilities().memoryV2 && activePatchIds.length > 0) {
      await this.hydrateMountedMemories(activePatchIds);
    }
    this.lastState.runtime_trust = this.runtimeTrust;
    this.lastState.runtime_source = this.runtimeSource;
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
    memoryEnabled: boolean,
    options: { name?: string; writablePatchFamily?: string | null } = {}
  ): Promise<void> {
    const listed = await this.callJsonTool('memory_profiles_list', { base_model_id: this.model.model });
    const profiles = Array.isArray(listed.profiles) ? listed.profiles : [];
    const exists = profiles.some((profile: any) => profile?.id === profileId);
    if (exists) {
      await this.callJsonTool('memory_profiles_update', {
        profile_id: profileId,
        ...(activePatchIds !== undefined ? { active_memory_patch_ids: activePatchIds } : {}),
        ...(options.name ? { name: options.name } : {}),
        ...(options.writablePatchFamily !== undefined
          ? { writable_patch_family: options.writablePatchFamily }
          : {}),
        memory_enabled: memoryEnabled,
      });
      return;
    }
    if (activePatchIds === undefined) {
      throw new Error(`memory profile does not exist and no patch ids were provided: ${profileId}`);
    }
    await this.callJsonTool('memory_profiles_create', {
      id: profileId,
      name: options.name || profileId,
      base_model_id: this.model.model,
      active_memory_patch_ids: activePatchIds,
      ...(options.writablePatchFamily !== undefined
        ? { writable_patch_family: options.writablePatchFamily }
        : {}),
      auto_intake_policy: { enabled: false },
      memory_enabled: memoryEnabled,
    });
  }

  private markPatchSelectionPending(
    profileId: string,
    patchIds: string[],
    bindingId?: string
  ): void {
    const previousActive = this.lastState?.memory?.active_memory_patch_ids ?? [];
    const changed = previousActive.length !== patchIds.length || previousActive.some((id, index) => id !== patchIds[index]);
    this.requestedPatchIds = [...patchIds];
    this.requestedAfterRevision = changed && typeof this.lastState?.memory?.patchset_revision === 'number'
      ? this.lastState.memory.patchset_revision
      : null;
    const previous = this.lastState;
    this.lastState = {
      provider_id: 'agora',
      ...(previous?.agora_session_id ? { agora_session_id: previous.agora_session_id } : {}),
      memory: {
        ...(previous?.memory ?? {}),
        status: 'pending',
        profile_id: profileId,
        ...(bindingId ? { binding_id: bindingId } : {}),
        active_memory_patch_ids: previous?.memory?.active_memory_patch_ids ?? [],
        requested_memory_patch_ids: [...patchIds],
      },
      runtime_trust: this.runtimeTrust,
      runtime_source: this.runtimeSource,
    };
  }

  private async hydrateMountedMemories(activePatchIds: string[]): Promise<void> {
    try {
      const [memories, patches, profiles] = await Promise.all([
        this.listMemories(),
        this.listPatches(true),
        this.listProfiles(),
      ]);
      const mounted = activePatchIds.flatMap((patchId) => {
        const patch = patches.find((item) => item.id === patchId);
        const memory = patch?.memory_id ? memories.find((item) => item.id === patch.memory_id) : undefined;
        if (!patch || !memory) return [];
        return [{
          memory_id: memory.id,
          memory_name: memory.name,
          patch_id: patch.id,
          patch_name: patch.name,
          version: patch.version,
        }];
      });
      const profileId = this.lastState?.memory?.profile_id;
      const profile = profiles.find((item) => item.id === profileId);
      if (this.lastState?.memory) {
        this.lastState.memory.mounted_memories = mounted;
        this.lastState.memory.auto_target_memory_ids = profile?.auto_intake_target_memory_ids ?? [];
      }
    } catch {
      // Chat truth remains valid even if the user-facing catalog cannot be hydrated.
    }
  }

  private normalizeBatch(payload: Record<string, any>): AgoraMemoryIntakeBatchResult {
    const batch = asRecord(payload.batch) ?? {};
    const batchId = String(payload.batch_id ?? batch.id ?? '').trim();
    if (!batchId) throw new Error('Agora did not return a Memory intake batch id');
    const rawTargets = Array.isArray(payload.targets) ? payload.targets : [];
    return {
      status: String(payload.status ?? batch.status ?? 'unknown'),
      batch_id: batchId,
      batch,
      targets: rawTargets
        .filter((target): target is Record<string, any> => Boolean(asRecord(target)))
        .map((target) => ({
          ...target,
          id: String(target.id ?? ''),
          batch_id: String(target.batch_id ?? batchId),
          mode: target.mode === 'create' ? 'create' : 'increment',
          output_name: String(target.output_name ?? target.memory_name ?? ''),
          status: String(target.status ?? 'queued') as AgoraIntakeTargetStatus,
        })),
    };
  }

  private async ensureBinding(
    profileId: string,
    scope: 'user' | 'project' | 'conversation' = 'project'
  ): Promise<string | undefined> {
    const metadata = this.buildMetadata(undefined, { memory_profile: profileId });
    const listed = await this.callJsonTool('memory_profile_bindings_list', { profile_id: profileId });
    const bindings = Array.isArray(listed.bindings) ? listed.bindings : [];
    const match = bindings.find((binding: any) => {
      if (binding?.scope_type !== scope || binding?.user_id !== metadata.user_id) return false;
      if (scope !== 'user' && binding?.project_id !== metadata.project_id) return false;
      return scope !== 'conversation' || binding?.conversation_id === metadata.conversation_id;
    });
    if (match?.id) return String(match.id);
    const created = await this.callJsonTool('memory_profile_bindings_create', {
      profile_id: profileId,
      scope_type: scope,
      user_id: metadata.user_id,
      ...(scope !== 'user' ? { project_id: metadata.project_id } : {}),
      ...(scope === 'conversation' ? { conversation_id: metadata.conversation_id } : {}),
    });
    return typeof created.binding?.id === 'string' ? created.binding.id : undefined;
  }

  private safeScopeId(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'default';
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

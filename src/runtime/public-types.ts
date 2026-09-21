import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import type { AgentConfig, McpConnection, ProviderSessionState } from '../mcp/types.js';
import type { ProviderRuntime } from '../provider/runtime.js';
import type { MaMemoryAction, MaMemoryState } from './memory-control.js';
import type {
  Invocation, InvocationOrigin, ModelCallBinding, ModelCallContext, ModelCallReceipt, SessionScope, ToolReceipt, TurnCompletion, TurnScope,
} from './contracts.js';

/** Shared MA product protocol. Credentials are allowed only on the private bootstrap channel. */
export const MA_RUNTIME_PROTOCOL_VERSION = 2 as const;
export const MA_SESSION_MANIFEST_FILENAME = 'manifest.json' as const;
export interface MaSessionManifest {
  schemaVersion: 2; sessionId: string; workspaceId: string; canonicalCwd: string;
  hostIdentity: string; providerProfileId: string; engineSessionId: string; engineSessionFile: string;
  kernelVersion: 'pi-0.86.1';
}

export interface ModelCapabilitySnapshot {
  id: string;
  providerProfileId: string;
  providerId: string;
  modelId: string;
  input: Array<'text' | 'image'>;
  tools: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  cancellation: 'local' | 'confirmed';
}

export interface MaResourcePolicy {
  skillDirectories: string[];
  instructionFiles: string[];
  /** Explicitly approved built-in extension identifiers, never discovered project code. */
  extensions: string[];
}

export interface MaBootstrapV2 {
  schemaVersion: 2;
  kind: 'ma.runtime.bootstrap';
  scope: SessionScope;
  sessionDirectory: string;
  agentDirectory: string;
  config: AgentConfig;
  capability: ModelCapabilitySnapshot;
  resources: MaResourcePolicy;
  hostControl: { transport: 'acp'; protocolVersion: 2 } | { transport: 'local'; protocolVersion: 2 };
  resumeSessionId?: string;
  virtualUi?: {
    serverId: string;
    osInstanceId: string;
    agentId: string;
    teamId: string;
    tools: { current: string; act: string; search: string };
  };
}

export interface PreparedQuoteReference {
  quoteId: string;
  quoteSha256: string;
  supplierRequestSha256: string;
  requestRevision: number;
  budgetRevision: number;
}

export interface PreparedModelRequest {
  /** Hash of the actual frozen native supplier request, never the Cloud proxy request. */
  supplierRequestSha256: string;
  requestRevision: number;
  providerProfileId: string;
  modelId: string;
  capabilitySnapshotId: string;
  preparedQuote?: PreparedQuoteReference;
  /** Host-only transport metadata; never persisted in the execution journal or Pi history. */
  headers?: Record<string, string>;
}

export interface ModelExecutionEvidence {
  callId: string;
  dispatchState: 'not_sent' | 'dispatching' | 'confirmed' | 'unknown';
  providerAcceptance: 'not_sent' | 'not_accepted' | 'accepted' | 'unknown';
  retryable: boolean;
  evidenceRef?: string;
  retryAfterMs?: number;
  supplierRequestSha256?: string;
}

export interface ToolAuthorizationRequest {
  scope: TurnScope;
  origin: InvocationOrigin;
  toolCallId: string;
  source: Invocation['source'];
  args: Record<string, unknown>;
  argsSha256: string;
}

export interface ToolAuthorization {
  /** Host allocates an auditable identity for both decisions, before returning either one. */
  executionId: string;
  decision: 'allow' | 'deny';
  permissionScopeHash: string;
  reason?: string;
}

export interface ToolRecoveryResult {
  receipt: ToolReceipt;
  /** A confirmed result comes from the original trusted service, not a tools/call replay. */
  result?: { content: Array<TextContent | ImageContent>; details?: Record<string, unknown> };
}
export interface ModelRecoveryResult {
  context: ModelCallBinding;
  supplierRequestSha256: string;
  dispatchState: ModelExecutionEvidence['dispatchState'];
  providerAcceptance: ModelExecutionEvidence['providerAcceptance'];
  receipt: Omit<ModelCallReceipt, 'callId'>;
  costState: 'reserved' | 'known' | 'unknown' | 'none';
  usageEvidenceSha256?: string;
}

export interface ModelExecutionRecord {
  call: ModelCallBinding;
  receipt: ModelCallReceipt | null;
  usage: ChatCompletionChunk['usage'] | null;
}

export interface TurnReceiptBoundary {
  turn: TurnScope;
  localCompletion: TurnCompletion;
  receiptSetHash: string;
  unresolvedExecutionIds: string[];
  unresolvedCallIds: string[];
}

/** Trusted control-plane port; implementations must preserve their real Host/Cloud authority. */
export interface HostControlPort {
  registerTurn(turn: TurnScope, signal?: AbortSignal): Promise<void>;
  revokeTurn(turn: TurnScope): Promise<void>;
  prepareModel(input: {
    context: ModelCallContext;
    requestRevision: number;
    request: ChatCompletionCreateParamsStreaming;
    /** Quote/earmark only; Host owns its completion stage/IDs. It is never dispatched by this call. */
    completionRequest?: ChatCompletionCreateParamsStreaming;
  }): Promise<PreparedModelRequest>;
  /** Optional local-service accounting sink. Called only after the original MA receipt is durable. */
  recordModelReceipt?(record: ModelExecutionRecord & { receipt: ModelCallReceipt }): Promise<void>;
  authorizeTool(request: ToolAuthorizationRequest, signal?: AbortSignal): Promise<ToolAuthorization>;
  queryExecution(invocation: Invocation, signal?: AbortSignal): Promise<ToolRecoveryResult>;
  queryModelRecovery?(call: ModelCallBinding, signal?: AbortSignal): Promise<ModelRecoveryResult>;
  /** Execution boundary acknowledgement, not Mission acceptance or financial settlement. */
  receiptComplete(boundary: TurnReceiptBoundary): Promise<void>;
}

export type RuntimeEventKind =
  | 'runtime.ready' | 'turn.started' | 'assistant.delta' | 'tool.started' | 'tool.progress'
  | 'tool.completed' | 'usage.recorded' | 'permission.required' | 'context.compacting'
  | 'context.compacted' | 'turn.paused' | 'turn.failed' | 'turn.cancelled' | 'turn.completed';

export interface RuntimeEvent {
  protocolVersion: 2;
  eventId: string;
  seq: number;
  sessionId: string;
  engineSessionId: string;
  operationId?: string;
  turnId?: string;
  epoch?: number;
  logicalCallId?: string;
  callId?: string;
  toolCallId?: string;
  executionId?: string;
  kind: RuntimeEventKind;
  /** Only the event's allowlisted, model/user-safe projection belongs here. */
  payload: Record<string, unknown>;
}

export interface MaPromptInput { content: Array<TextContent | ImageContent> }
export interface MaRequestBudget {
  schemaVersion: 1;
  inputBudget: { measurementId: 'provider-json-utf8-plus-framing-v1'; unit: 'conservative_input_units'; currentUnits: number; maxUnits: number };
  maxOutputUnits: number;
  availableCredits: number;
  requiredCredits: number;
  constraint?: 'supplier-risk' | 'tokens' | 'price-snapshot';
  /** For price-snapshot only: the priced replacement bound, never the original request total. */
  requiredCreditsBasis?: 'bounded-replacement';
}
export interface MaRuntimeError { code: string; message: string; requestBudget?: MaRequestBudget }
export interface TurnOutcome {
  status: 'completed' | 'failed' | 'cancelled' | 'paused';
  engineSessionId: string;
  turn: TurnScope;
  unresolvedExecutionIds: string[];
  unresolvedCallIds: string[];
  completion?: TurnCompletion;
  error?: MaRuntimeError;
}
export interface CancelOutcome {
  engineSessionId: string;
  turn: TurnScope;
  localIdle: boolean;
  unresolvedExecutionIds: string[];
  unresolvedCallIds: string[];
}
export interface RecoveryOutcome {
  status: 'ready' | 'paused';
  sessionId: string;
  unresolvedExecutionIds: string[];
  unresolvedCallIds: string[];
  reason?: string;
}
export interface MaSession {
  readonly sessionId: string;
  readonly engineSessionId: string;
  prompt(input: MaPromptInput, turn: TurnScope): Promise<TurnOutcome>;
  /** Host must provide a new authorized completion Turn; never clears unresolved execution. */
  completeProtected(turn: TurnScope): Promise<TurnOutcome>;
  compact(input: { instructions?: string }, turn: TurnScope): Promise<TurnOutcome>;
  summarizeBranch(input: { targetEntryId: string; instructions?: string }, turn: TurnScope): Promise<TurnOutcome>;
  abort(turnId: string): Promise<CancelOutcome>;
  subscribe(listener: (event: RuntimeEvent) => void | Promise<void>): () => void;
  recover(): Promise<RecoveryOutcome>;
  memory(action: MaMemoryAction): Promise<MaMemoryState>;
  inspectHistory(input?: { all?: boolean }): ReadonlyArray<Record<string, unknown>>;
  editContext(input: { action: 'clear' | 'revert' | 'pin'; text?: string }): Promise<{ removedMessages: number; entryId?: string }>;
  inspectModelExecution(callId: string): Promise<ModelExecutionRecord | null>;
  providerState(): ProviderSessionState | null;
  close(): Promise<void>;
}
export interface OpenMaSessionOptions {
  bootstrap: MaBootstrapV2;
  host: HostControlPort;
  /** The existing single provider service, with maxRetries=0. Not a second provider executor. */
  providerRuntime?: ProviderRuntime;
  /** Explicit already-connected catalog. Its owner retains connection shutdown responsibility. */
  connections?: readonly McpConnection[];
}
export type OpenMaSession = (options: OpenMaSessionOptions) => Promise<MaSession>;

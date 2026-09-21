import { isAbsolute } from 'node:path';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import type { SessionScope, TurnScope } from './contracts.js';

export type PiSessionErrorCode =
  | 'PI_INVALID_CONFIG'
  | 'PI_MODEL_UNAVAILABLE'
  | 'PI_SESSION_BUSY'
  | 'PI_SESSION_CLOSED'
  | 'PI_TURN_MISMATCH'
  | 'PI_CREATE_FAILED'
  | 'PI_MODEL_FAILED'
  | 'PI_UNEXPECTED_TOOL'
  | 'PI_ABORT_FAILED';

const messages: Record<PiSessionErrorCode, string> = {
  PI_INVALID_CONFIG: 'Invalid explicit Pi session configuration.',
  PI_MODEL_UNAVAILABLE: 'The selected registered model is unavailable.',
  PI_SESSION_BUSY: 'The Pi session already has an active prompt.',
  PI_SESSION_CLOSED: 'The Pi session is closing or closed.',
  PI_TURN_MISMATCH: 'The Turn does not match this session or its current execution.',
  PI_CREATE_FAILED: 'The explicit Pi session could not be created.',
  PI_MODEL_FAILED: 'The model did not finish the text prompt successfully.',
  PI_UNEXPECTED_TOOL: 'A tool call was returned to a text-only Pi session.',
  PI_ABORT_FAILED: 'The Pi session could not confirm local shutdown.',
};

export class PiSessionError extends Error {
  constructor(public readonly code: PiSessionErrorCode) {
    super(messages[code]);
    this.name = 'PiSessionError';
  }
}

export interface PiSessionOptions {
  scope: SessionScope;
  agentDir: string;
  modelRuntime: ModelRuntime;
  providerId: string;
  modelId: string;
  systemPrompt: string;
}

export interface PiPromptResult {
  status: 'completed' | 'failed' | 'cancelled';
  engineSessionId: string;
  turn: TurnScope;
  error?: { code: PiSessionErrorCode; message: string };
}

export interface PiCancelResult {
  engineSessionId: string;
  turn: TurnScope;
  localIdle: true;
}

export interface PiObservedEvent {
  engineSessionId: string;
  turn: TurnScope;
  event: AgentSessionEvent;
}

export interface PiSessionFacade {
  readonly engineSessionId: string;
  prompt(text: string, turn: TurnScope): Promise<PiPromptResult>;
  abort(turnId: string): Promise<PiCancelResult>;
  subscribe(listener: (event: PiObservedEvent) => void): () => void;
  close(): Promise<void>;
}

function fail(code: PiSessionErrorCode): never {
  throw new PiSessionError(code);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PI_INVALID_CONFIG');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('PI_INVALID_CONFIG');
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail('PI_INVALID_CONFIG');
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor
      || !('value' in descriptor) || !descriptor.enumerable) fail('PI_INVALID_CONFIG');
  }
  return value as Record<string, unknown>;
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    fail('PI_INVALID_CONFIG');
  }
  return value;
}

function absoluteDirectory(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) {
    fail('PI_INVALID_CONFIG');
  }
  return value;
}

function copyScope(value: unknown): SessionScope {
  const scope = record(value, ['maSessionId', 'workspaceId', 'canonicalCwd', 'hostIdentity', 'providerProfileId']);
  return {
    maSessionId: identity(scope.maSessionId), workspaceId: identity(scope.workspaceId),
    canonicalCwd: absoluteDirectory(scope.canonicalCwd), hostIdentity: identity(scope.hostIdentity),
    providerProfileId: identity(scope.providerProfileId),
  };
}

function copyTurn(value: unknown): TurnScope {
  const turn = record(value, ['sessionId', 'turnId', 'epoch', 'operationId', 'stageId', 'budgetRef']);
  if (typeof turn.epoch !== 'number' || !Number.isSafeInteger(turn.epoch) || turn.epoch < 1) {
    fail('PI_INVALID_CONFIG');
  }
  return {
    sessionId: identity(turn.sessionId), turnId: identity(turn.turnId), epoch: turn.epoch,
    operationId: identity(turn.operationId), stageId: identity(turn.stageId), budgetRef: identity(turn.budgetRef),
  };
}

function errorResult(code: PiSessionErrorCode): { code: PiSessionErrorCode; message: string } {
  return { code, message: messages[code] };
}

function emptyResources(systemPrompt: string): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => fail('PI_INVALID_CONFIG'),
    reload: async () => {},
  };
}

interface PromptRun {
  readonly turn: TurnScope;
  userCancelled: boolean;
  unexpectedTool: boolean;
  abortFailed: boolean;
  modelFailed: boolean;
  finalStop?: string;
  finished: boolean;
  result: Promise<PiPromptResult>;
  cancelResult?: Promise<PiCancelResult>;
  abortRequests: Promise<void>[];
  unsubscribe: () => void;
}

/** An internal text-only SDK lifecycle, not a Host permission or budget authority. */
export async function createPiSessionFacade(options: PiSessionOptions): Promise<PiSessionFacade> {
  let session: AgentSession | undefined;
  let scope: SessionScope;
  try {
    const input = record(options, ['scope', 'agentDir', 'modelRuntime', 'providerId', 'modelId', 'systemPrompt']);
    scope = copyScope(input.scope);
    const agentDir = absoluteDirectory(input.agentDir);
    const providerId = identity(input.providerId);
    const modelId = identity(input.modelId);
    if (!(input.modelRuntime instanceof ModelRuntime) || typeof input.systemPrompt !== 'string') {
      fail('PI_INVALID_CONFIG');
    }
    const modelRuntime = input.modelRuntime;
    const model = modelRuntime.getModel(providerId, modelId);
    const provider = modelRuntime.getRegisteredProviderConfig(providerId);
    if (!model || model.provider !== providerId || model.id !== modelId
      || typeof provider?.streamSimple !== 'function') fail('PI_MODEL_UNAVAILABLE');

    const settings = SettingsManager.inMemory({
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      cacheWarming: 'off', compaction: { enabled: false },
      enableAnalytics: false, enableInstallTelemetry: false,
      packages: [], extensions: [], skills: [], prompts: [], themes: [], defaultTools: [],
      enableSkillCommands: false,
      images: { autoResize: false, blockImages: false },
    }, { projectTrusted: false });
    const created = await createAgentSession({
      cwd: scope.canonicalCwd, agentDir, modelRuntime, model: structuredClone(model),
      thinkingLevel: 'off', scopedModels: [{ model: structuredClone(model), thinkingLevel: 'off' }],
      settingsManager: settings, sessionManager: SessionManager.inMemory(scope.canonicalCwd),
      resourceLoader: emptyResources(input.systemPrompt), noTools: 'all', tools: [], customTools: [],
    });
    session = created.session;
    if (created.modelFallbackMessage || session.model?.provider !== providerId
      || session.model.id !== modelId || session.getActiveToolNames().length !== 0) {
      fail('PI_CREATE_FAILED');
    }
  } catch (error) {
    session?.dispose();
    throw error instanceof PiSessionError ? error : new PiSessionError('PI_CREATE_FAILED');
  }

  const sdk = session;
  const engineSessionId = sdk.sessionId;
  const listeners = new Set<(event: PiObservedEvent) => void>();
  const usedTurns = new Set<string>();
  let lastEpoch = 0;
  let state: 'ready' | 'active' | 'cancelling' | 'paused' | 'closing' | 'closed' = 'ready';
  let active: PromptRun | undefined;
  let recentCancelled: PiCancelResult | undefined;
  let closePromise: Promise<void> | undefined;

  function requestSdkAbort(run: PromptRun): void {
    try {
      const requested = sdk.abort().catch(() => {
        run.abortFailed = true;
        if (state !== 'closing' && state !== 'closed') state = 'paused';
      });
      run.abortRequests.push(requested);
    } catch {
      run.abortFailed = true;
      if (state !== 'closing' && state !== 'closed') state = 'paused';
    }
  }

  function unexpectedTool(run: PromptRun): void {
    if (run.unexpectedTool || run.userCancelled) return;
    run.unexpectedTool = true;
    requestSdkAbort(run);
  }

  function observe(run: PromptRun, event: AgentSessionEvent): void {
    // This closure keeps late callbacks attached to their originating run.
    if (run.finished || active !== run) return;
    if (event.type === 'agent_start' && (run.userCancelled || run.unexpectedTool || state === 'closing')) {
      requestSdkAbort(run);
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update'
      || event.type === 'tool_execution_end') unexpectedTool(run);
    if (event.type === 'message_update' && event.assistantMessageEvent.type.startsWith('toolcall_')) {
      unexpectedTool(run);
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      run.finalStop = event.message.stopReason;
      if (event.message.errorMessage) run.modelFailed = true;
      if (event.message.stopReason === 'toolUse'
        || event.message.content.some(block => block.type === 'toolCall')) unexpectedTool(run);
    }
    if (event.type === 'auto_retry_start') {
      run.modelFailed = true;
      requestSdkAbort(run);
    }
    const ordinaryText = event.type === 'message_update'
      && event.assistantMessageEvent.type.startsWith('text_');
    for (const listener of [...listeners]) {
      if (ordinaryText && (run.userCancelled || run.unexpectedTool || state === 'closing')) break;
      try {
        // SDK partial messages are mutable. No observer receives SDK-owned objects.
        const observation: unknown = listener({ engineSessionId, turn: { ...run.turn }, event: structuredClone(event) });
        // A void-typed callback can still return a Promise or thenable. Do not await it.
        void Promise.resolve(observation).catch(() => {});
      } catch {
        // Observers cannot change lifecycle success or abort the SDK event pipeline.
      }
    }
  }

  async function finishPrompt(run: PromptRun, text: string): Promise<PiPromptResult> {
    try {
      try { await sdk.prompt(text, { expandPromptTemplates: false }); }
      catch { run.modelFailed = true; }
      try { await sdk.waitForIdle(); }
      catch { run.abortFailed = true; }
      await Promise.all(run.abortRequests);
      if (run.abortFailed) fail('PI_ABORT_FAILED');
      const result: PiPromptResult = { status: 'completed', engineSessionId, turn: { ...run.turn } };
      if (run.unexpectedTool) {
        result.status = 'failed';
        result.error = errorResult('PI_UNEXPECTED_TOOL');
      } else if (run.userCancelled) {
        result.status = 'cancelled';
        recentCancelled = { engineSessionId, turn: { ...run.turn }, localIdle: true };
      } else if (run.modelFailed || run.finalStop !== 'stop') {
        result.status = 'failed';
        result.error = errorResult('PI_MODEL_FAILED');
      }
      return result;
    } finally {
      run.finished = true;
      run.unsubscribe();
      if (active === run) active = undefined;
      if (state !== 'closing' && state !== 'closed') state = run.abortFailed ? 'paused' : 'ready';
    }
  }

  return {
    engineSessionId,
    prompt(text, value) {
      try {
        if (state === 'closing' || state === 'closed') fail('PI_SESSION_CLOSED');
        if (state === 'paused') fail('PI_ABORT_FAILED');
        if (active) fail('PI_SESSION_BUSY');
        if (typeof text !== 'string' || text.trim().length === 0) fail('PI_INVALID_CONFIG');
        const turn = copyTurn(value);
        if (turn.sessionId !== scope.maSessionId || usedTurns.has(turn.turnId) || turn.epoch <= lastEpoch) {
          fail('PI_TURN_MISMATCH');
        }
        usedTurns.add(turn.turnId);
        lastEpoch = turn.epoch;
        recentCancelled = undefined;
        const run: PromptRun = {
          turn: Object.freeze(turn), userCancelled: false, unexpectedTool: false,
          abortFailed: false, modelFailed: false, finished: false,
          result: undefined as unknown as Promise<PiPromptResult>, abortRequests: [], unsubscribe: () => {},
        };
        active = run;
        state = 'active';
        run.unsubscribe = sdk.subscribe(event => observe(run, event));
        // Install the run and its completion promise before any SDK preflight work.
        run.result = Promise.resolve().then(() => finishPrompt(run, text));
        return run.result;
      } catch (error) {
        return Promise.reject(error instanceof PiSessionError ? error : new PiSessionError('PI_INVALID_CONFIG'));
      }
    },
    abort(value) {
      try {
        if (state === 'closing' || state === 'closed') fail('PI_SESSION_CLOSED');
        const turnId = identity(value);
        const run = active;
        if (!run) {
          if (recentCancelled?.turn.turnId === turnId) return Promise.resolve(structuredClone(recentCancelled));
          fail('PI_TURN_MISMATCH');
        }
        if (run.turn.turnId !== turnId || run.finished) fail('PI_TURN_MISMATCH');
        if (!run.cancelResult) {
          run.userCancelled = true;
          if (state !== 'paused') state = 'cancelling';
          requestSdkAbort(run);
          run.cancelResult = run.result.then(() => {
            if (run.abortFailed) fail('PI_ABORT_FAILED');
            return { engineSessionId, turn: { ...run.turn }, localIdle: true as const };
          });
        }
        return run.cancelResult.then(result => structuredClone(result));
      } catch (error) {
        return Promise.reject(error instanceof PiSessionError ? error : new PiSessionError('PI_INVALID_CONFIG'));
      }
    },
    subscribe(listener) {
      if (state === 'closing' || state === 'closed') fail('PI_SESSION_CLOSED');
      if (typeof listener !== 'function') fail('PI_INVALID_CONFIG');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      if (closePromise) return closePromise;
      state = 'closing';
      const run = active;
      if (run && !run.finished) {
        run.userCancelled = true;
        requestSdkAbort(run);
      }
      closePromise = Promise.resolve().then(async () => {
        try {
          if (run) await run.result;
          await sdk.waitForIdle();
          if (run?.abortFailed) fail('PI_ABORT_FAILED');
          listeners.clear();
          sdk.dispose();
          state = 'closed';
        } catch {
          throw new PiSessionError('PI_ABORT_FAILED');
        }
      });
      return closePromise;
    },
  };
}

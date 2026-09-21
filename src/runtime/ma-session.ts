import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, rename, mkdir, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { InMemoryCredentialStore, InMemoryModelsStore, type ImageContent } from '@earendil-works/pi-ai';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ControlledExtension } from './extensions.js';
import { connectMcpServer } from '../mcp/client.js';
import type { McpConnection } from '../mcp/types.js';
import { createProviderRuntime } from '../provider/runtime.js';
import type { ProviderRuntime } from '../provider/runtime.js';
import type { ModelCallContext, TurnScope } from './contracts.js';
import type { MaSession, MaSessionManifest, OpenMaSessionOptions, RuntimeEvent, RuntimeEventKind, TurnOutcome, MaPromptInput, RecoveryOutcome } from './public-types.js';
import { parseMaBootstrapV2 } from './bootstrap.js';
import { cloneRuntimeJson, ownData, requireOwnData } from './data.js';
import { openExecutionJournal, recoverDeadExecutionWriter } from './execution-journal.js';
import type { ExecutionJournal } from './execution-journal.js';
import { createTurnGate } from './turn-gate.js';
import { createModelBridge, PROTECTED_COMPLETION_PROMPT } from './model-bridge.js';
import { createControlledToolBridge, registerMcpTool } from './tool-bridge.js';
import { openReceiptStore } from './receipt-store.js';
import { createControlledResources } from './resource-loader.js';
import { createPiSessionFacade, type PiSessionFacade } from './pi-session.js';
import { createFrameContext } from './frame-context.js';
import { publicRuntimeError } from './errors.js';
import { createMemoryControl } from './memory-control.js';
import { createEventSequence } from './event-sequence.js';
import { indexExecutionHistory } from './recovery-index.js';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { reconcileSavedExecution } from './recovery.js';
import { persistInitialPiSession } from './session-persistence.js';

interface ActiveRun {
  turn: TurnScope;
  controller: AbortController;
  purpose?: ModelCallContext['modelPurpose'];
  ordinaryCalls: number;
  protectedCompletion?: boolean;
  cancelled: boolean;
  paused: boolean;
  result: Promise<TurnOutcome>;
  failure?: ReturnType<typeof publicRuntimeError>;
}

type SessionManifest = MaSessionManifest;

async function readManifest(directory: string): Promise<SessionManifest | null> {
  let handle;
  try {
    handle = await open(join(directory, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const manifest = JSON.parse(await handle.readFile('utf8')) as SessionManifest;
    requireOwnData(manifest, ['schemaVersion', 'sessionId', 'workspaceId', 'canonicalCwd', 'hostIdentity',
      'providerProfileId', 'engineSessionId', 'engineSessionFile', 'kernelVersion']);
    return manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

async function writeManifest(directory: string, value: SessionManifest): Promise<void> {
  const temporary = join(directory, `.manifest-${randomUUID()}.pending`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, join(directory, 'manifest.json'));
  const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}

/** Real MA product construction. Pi alone executes the conversational/tool loop. */
export async function openMaSession(options: OpenMaSessionOptions): Promise<MaSession> {
  const bootstrap = parseMaBootstrapV2(options.bootstrap);
  const { scope, capability } = bootstrap;
  if (await realpath(scope.canonicalCwd) !== scope.canonicalCwd) throw new Error('MA_WORKSPACE_NOT_CANONICAL');
  const host = options.host;
  for (const method of ['registerTurn', 'revokeTurn', 'prepareModel', 'authorizeTool', 'queryExecution', 'receiptComplete'] as const) {
    if (typeof host?.[method] !== 'function') throw new Error('MA_HOST_PORT_REQUIRED');
  }
  let journal: ExecutionJournal | undefined;
  let pi: PiSessionFacade | undefined;
  let provider: ProviderRuntime | undefined;
  const connections: McpConnection[] = [];
  let active: ActiveRun | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let memoryOperation: Promise<unknown> | undefined;
  let recovering = false;
  let recoveryReason: string | undefined;
  let recoveryOperation: Promise<RecoveryOutcome> | undefined;
  const listeners = new Set<(event: RuntimeEvent) => void | Promise<void>>();
  try {
    const journalOptions = { directory: bootstrap.sessionDirectory, sessionId: scope.maSessionId,
      ownerId: `${process.pid}:${randomUUID()}`, hostIdentity: scope.hostIdentity };
    try { journal = await openExecutionJournal(journalOptions); }
    catch (error) {
      if (!bootstrap.resumeSessionId || ownData(error, 'code') !== 'JOURNAL_LOCKED') throw error;
      await recoverDeadExecutionWriter({ directory: bootstrap.sessionDirectory, sessionId: scope.maSessionId, hostIdentity: scope.hostIdentity });
      journal = await openExecutionJournal(journalOptions);
    }
    const ownedJournal = journal;
    const nextSequence = createEventSequence(bootstrap.sessionDirectory, scope.maSessionId);
    const gate = await createTurnGate({ sessionId: scope.maSessionId, journal });
    const receipts = await openReceiptStore(join(bootstrap.sessionDirectory, 'receipts'));
    const existing = await readManifest(bootstrap.sessionDirectory);
    const savedHistory = await journal.read();
    if (!existing && savedHistory.entries.length) throw new Error('MA_RECOVERY_MANIFEST_MISSING');
    if (bootstrap.resumeSessionId && (!existing || existing.sessionId !== bootstrap.resumeSessionId)) throw new Error('MA_RESUME_SESSION_NOT_FOUND');
    const piDirectory = join(bootstrap.sessionDirectory, 'pi');
    try {
      await mkdir(piDirectory, { mode: 0o700 });
      const parent = await open(bootstrap.sessionDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const piDirectoryStat = await lstat(piDirectory);
    if (!piDirectoryStat.isDirectory() || piDirectoryStat.isSymbolicLink() || (piDirectoryStat.mode & 0o077) !== 0
      || await realpath(piDirectory) !== piDirectory) throw new Error('MA_SESSION_DIRECTORY_INVALID');
    if (existing && (existing.schemaVersion !== 2 || existing.kernelVersion !== 'pi-0.86.1' || existing.sessionId !== scope.maSessionId
      || existing.workspaceId !== scope.workspaceId || existing.canonicalCwd !== scope.canonicalCwd
      || existing.hostIdentity !== scope.hostIdentity || existing.providerProfileId !== scope.providerProfileId
      || relative(piDirectory, existing.engineSessionFile).startsWith('..'))) throw new Error('MA_SESSION_OWNERSHIP_MISMATCH');
    let missingEmptyHistory = false;
    if (existing) {
      let file;
      try {
        file = await open(existing.engineSessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
        const bytes = await file.readFile();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!text.endsWith('\n')) throw new Error('MA_PI_HISTORY_INCOMPLETE');
        for (const line of text.split('\n').slice(0, -1)) JSON.parse(line);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || savedHistory.entries.length > 0) throw error;
        missingEmptyHistory = true;
      } finally { await file?.close(); }
    }
    let manager = existing && !missingEmptyHistory ? SessionManager.open(existing.engineSessionFile, piDirectory, scope.canonicalCwd)
      : SessionManager.create(scope.canonicalCwd, piDirectory, existing ? { id: existing.engineSessionId } : undefined);
    if (!existing || missingEmptyHistory) manager = await persistInitialPiSession(manager, bootstrap.sessionDirectory, scope.canonicalCwd);
    const engineSessionId = manager.getSessionId();
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error('MA_PERSISTENT_SESSION_REQUIRED');
    await writeManifest(bootstrap.sessionDirectory, {
      schemaVersion: 2, sessionId: scope.maSessionId, workspaceId: scope.workspaceId,
      canonicalCwd: scope.canonicalCwd, hostIdentity: scope.hostIdentity,
      providerProfileId: scope.providerProfileId, engineSessionId, engineSessionFile: sessionFile,
      kernelVersion: 'pi-0.86.1',
    });
    const emit = (kind: RuntimeEventKind, payload: Record<string, unknown>, turn?: Pick<TurnScope, 'operationId' | 'turnId' | 'epoch'>,
      ids: Partial<Pick<RuntimeEvent, 'callId' | 'logicalCallId' | 'executionId' | 'toolCallId'>> = {}): RuntimeEvent => {
      const event: RuntimeEvent = { protocolVersion: 2, eventId: randomUUID(), seq: nextSequence(),
        sessionId: scope.maSessionId, engineSessionId, kind, payload: cloneRuntimeJson(payload),
        ...(turn ? { operationId: turn.operationId, turnId: turn.turnId, epoch: turn.epoch } : {}), ...ids };
      for (const listener of [...listeners]) {
        try { void Promise.resolve(listener(cloneRuntimeJson(event))).catch(() => {}); } catch { /* Observer only. */ }
      }
      return event;
    };
    const capture = () => {
      if (!active || closing || active.paused) throw new Error('MA_NO_ACTIVE_TURN');
      active.controller.signal.throwIfAborted();
      return active;
    };
    const pause = (origin: Pick<TurnScope, 'sessionId' | 'turnId' | 'epoch'>): void => {
      const run = active;
      if (!run || run.turn.sessionId !== origin.sessionId || run.turn.turnId !== origin.turnId || run.turn.epoch !== origin.epoch) return;
      run.paused = true;
      run.controller.abort();
      void gate.stop(run.turn.turnId).catch(() => {});
      void pi?.abort(run.turn.turnId).catch(() => {});
    };
    provider = options.providerRuntime ?? createProviderRuntime({ ...bootstrap.config.model, maxRetries: 0 }, undefined,
      { sessionId: scope.maSessionId, cwd: scope.canonicalCwd, standalone: bootstrap.hostControl.transport === 'local' });
    const memoryControl = await createMemoryControl({ sessionId: scope.maSessionId, directory: bootstrap.sessionDirectory,
      profileId: scope.providerProfileId, config: bootstrap.config, provider });
    const syncPiHistory = async () => {
      const file = manager.getSessionFile();
      if (!file) throw new Error('MA_PERSISTENT_SESSION_REQUIRED');
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    };
    const bridge = createModelBridge({ runtime: provider, host, gate, receipts, capability, beforeRequest: syncPiHistory,
      captureRun() {
        const run = capture();
        if (run.protectedCompletion && run.ordinaryCalls++ > 0) throw new Error('MA_COMPLETION_EXTRA_CALL_FORBIDDEN');
        return { turn: run.turn, signal: run.controller.signal, ...(run.protectedCompletion ? { protectedCompletion: true } : {}),
          purpose: run.purpose ?? (run.ordinaryCalls++ === 0 ? 'answer' : 'tool_loop') };
      },
      onPaused: pause,
      onFailure(context, error) {
        if (active?.turn.turnId === context.turnId && active.turn.epoch === context.epoch) active.failure = publicRuntimeError(error);
      },
      onUsage(context, usage) { emit('usage.recorded', { usage: usage ?? null, known: usage !== null }, context,
        { callId: context.callId, logicalCallId: context.logicalCallId }); },
    });
    if (options.connections) {
      const names = new Set<string>();
      for (const connection of options.connections) {
        if (names.has(connection.name) || !Object.hasOwn(bootstrap.config.mcpServers, connection.name)) throw new Error('MA_TOOL_SOURCE_AMBIGUOUS');
        names.add(connection.name); connections.push(connection);
      }
    } else for (const [name, config] of Object.entries(bootstrap.config.mcpServers)) connections.push(await connectMcpServer(name, config));
    const frame = bootstrap.virtualUi ? createFrameContext(bootstrap.virtualUi) : undefined;
    const registrations = capability.tools ? connections.flatMap(connection => connection.tools
      .filter(tool => connection.name !== bootstrap.virtualUi?.serverId || Object.values(bootstrap.virtualUi.tools).includes(tool.name))
      .map(tool => registerMcpTool({
      connection, toolName: tool.name,
      sequential: connection.name === bootstrap.virtualUi?.serverId,
      classify(result) {
        // A successful MCP call is a tool receipt, never acceptance of the user's application.
        const cleanup = ownData(result.structuredContent, 'cleanup');
        const unresolved = ownData(cleanup, 'scope') === 'unknown' || ownData(result.structuredContent, 'status') === 'unknown';
        return { status: unresolved ? 'unknown' : result.isError || ownData(result.structuredContent, 'status') === 'failed' ? 'failed' : 'succeeded',
          stopConfirmed: !unresolved && (ownData(result.structuredContent, 'stopConfirmed') === true || ownData(cleanup, 'scope') === 'verified') };
      },
    }))) : [];
    for (const registration of registrations) {
      registration.beforeDispatch = async () => {
        await syncPiHistory();
        if (registration.source.serverId === bootstrap.virtualUi?.serverId
          && registration.source.toolName === bootstrap.virtualUi.tools.act) frame!.beforeAction();
      };
    }
    const toolBridge = createControlledToolBridge({ registrations, host, gate, modelBridge: bridge, receipts,
      captureRun: () => { const run = capture(); return { turn: run.turn, signal: run.controller.signal }; },
      onUnresolved: pause,
      ...(frame ? { projectResult: frame.project } : {}),
      onDispatch(invocation, origin) { emit('tool.started', { name: invocation.source.toolName }, invocation,
        { executionId: invocation.executionId, toolCallId: invocation.toolCallId, callId: origin.callId, logicalCallId: origin.logicalCallId }); },
      onReceipt(invocation, receipt, result, origin) { frame?.confirm(invocation, receipt); emit('tool.completed', {
        status: receipt.status, resultRef: receipt.resultRef ?? null, content: result.content,
      }, invocation, { executionId: invocation.executionId, toolCallId: invocation.toolCallId, callId: origin.callId, logicalCallId: origin.logicalCallId }); },
    });
    const purposeExtension: ControlledExtension = extension => {
      extension.on('session_before_compact', event => {
        if (!active || active.protectedCompletion || active.controller.signal.aborted || event.signal.aborted) return { cancel: true };
        active.purpose = 'compaction';
        emit('context.compacting', { purpose: 'compaction' }, active.turn);
      });
      const end = () => { if (active?.purpose === 'compaction') { active.purpose = undefined; emit('context.compacted', {}, active.turn); } };
      extension.on('session_compact', end);
      extension.on('session_compact_failed', end);
      extension.on('session_before_tree', event => {
        if (!active || active.purpose !== 'branch_summary' || active.controller.signal.aborted || event.signal.aborted) return { cancel: true };
        emit('context.compacting', { purpose: 'branch_summary' }, active.turn);
      });
      extension.on('session_tree', () => {
        if (active?.purpose === 'branch_summary') emit('context.compacted', { purpose: 'branch_summary' }, active.turn);
      });
    };
    const resources = await createControlledResources({ cwd: scope.canonicalCwd, agentDirectory: bootstrap.agentDirectory,
      systemPrompt: bootstrap.config.systemPrompt ?? '', policy: bootstrap.resources,
      extensions: [toolBridge.resultExtension, purposeExtension, ...(frame ? [frame.extension] : [])] });
    const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
      modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    models.registerProvider(capability.providerId, { api: 'openai-completions', baseUrl: 'https://ma-codec.invalid/v1',
      apiKey: 'ma-controlled-provider', streamSimple: bridge.streamSimple, models: [{
        id: capability.modelId, name: capability.modelId, reasoning: capability.reasoning, input: capability.input,
        contextWindow: capability.contextWindow, maxTokens: capability.maxOutputTokens,
        // Pi requires a display cost table; actual billing comes only from the existing service.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }] });
    const makeFacade = () => createPiSessionFacade({ scope, agentDir: bootstrap.agentDirectory, modelRuntime: models,
      providerId: capability.providerId, modelId: capability.modelId, systemPrompt: bootstrap.config.systemPrompt ?? '',
      integration: { sessionManager: manager, resourceLoader: resources.loader, tools: toolBridge.tools, compaction: true } });
    const inspectModelExecution: MaSession['inspectModelExecution'] = async callId => {
        if (closing || !/^call_[a-f0-9]{32}$/.test(callId)) throw new Error('MA_INPUT_INVALID');
        const saved = await ownedJournal.read();
        if (saved.incompleteTail) throw new Error('MA_RECOVERY_REQUIRED');
        const model = indexExecutionHistory(saved.entries).models.get(callId);
        if (!model) return null;
        let usage: ChatCompletionChunk['usage'] | null = null;
        if (model.receipt?.evidenceRef) {
          const evidence = await receipts.read(model.receipt.evidenceRef);
          if (evidence.kind === 'model.receipt' && isDeepStrictEqual(evidence.binding, model.call)
            && evidence.status === model.receipt.status && evidence.usage) usage = cloneRuntimeJson(evidence.usage) as ChatCompletionChunk['usage'];
        }
        return { call: cloneRuntimeJson(model.call), receipt: model.receipt ? cloneRuntimeJson(model.receipt) : null, usage };
    };
    const reconcile = async () => {
      await reconcileSavedExecution({ journal: ownedJournal, receipts, manager, host });
      const recovered = await gate.recover();
      if (host.recordModelReceipt) {
        const index = indexExecutionHistory((await ownedJournal.read()).entries);
        for (const callId of index.models.keys()) {
          const record = await inspectModelExecution(callId);
          if (record?.receipt) await host.recordModelReceipt({ ...record, receipt: record.receipt });
        }
      }
      recoveryReason = recovered.state === 'paused' ? 'MA_RECOVERY_EXECUTION_UNRESOLVED' : undefined;
    };
    if (existing && savedHistory.entries.length) {
      try { await reconcile(); } catch { recoveryReason = 'MA_RECOVERY_RECONCILIATION_REQUIRED'; }
    }
    pi = await makeFacade();
    let sdk = pi;
    const subscribeFacade = () => sdk.subscribe(observation => {
      const event = observation.event;
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        emit('assistant.delta', { text: event.assistantMessageEvent.delta }, observation.turn);
      }
      if (event.type === 'tool_execution_update') {
        const executionId = ownData(event.partialResult.details, 'executionId');
        const callId = ownData(event.partialResult.details, 'callId');
        const logicalCallId = ownData(event.partialResult.details, 'logicalCallId');
        if (typeof executionId === 'string' && typeof callId === 'string' && typeof logicalCallId === 'string') emit('tool.progress', { progress: ownData(event.partialResult.details, 'progress') ?? null,
          ...(typeof ownData(event.partialResult.details, 'message') === 'string' ? { message: ownData(event.partialResult.details, 'message') } : {}) },
          observation.turn, { toolCallId: event.toolCallId, executionId, callId, logicalCallId });
      }
    });
    let unsubscribeFacade = subscribeFacade();
    const unresolved = () => {
      const snapshot = gate.snapshot();
      return { unresolvedExecutionIds: snapshot.inFlightExecutionIds, unresolvedCallIds: snapshot.inFlightCallIds };
    };
    let readyEvent: RuntimeEvent = {
      protocolVersion: 2, eventId: randomUUID(), seq: nextSequence(),
      sessionId: scope.maSessionId, engineSessionId, kind: 'runtime.ready',
      payload: { capability: cloneRuntimeJson(capability), recoveryRequired: gate.snapshot().state === 'paused' },
    };
    const performTurn = (input: MaPromptInput, turn: TurnScope, operation?: { kind: 'compaction' | 'branch_summary' | 'completion'; instructions?: string; targetEntryId?: string }): Promise<TurnOutcome> => {
        if (closing || active || memoryOperation || recovering) return Promise.reject(new Error('MA_SESSION_BUSY'));
        if (recoveryReason || gate.snapshot().state === 'paused' || unresolved().unresolvedCallIds.length || unresolved().unresolvedExecutionIds.length) {
          return Promise.reject(new Error('MA_RECOVERY_REQUIRED'));
        }
        const run: ActiveRun = { turn: cloneRuntimeJson(turn), controller: new AbortController(), ordinaryCalls: 0,
          cancelled: false, paused: false, ...(operation ? { purpose: operation.kind === 'completion' ? 'answer' : operation.kind, protectedCompletion: operation.kind === 'completion' } : {}), result: undefined as unknown as Promise<TurnOutcome> };
        active = run;
        run.result = Promise.resolve().then(async () => {
          let registered = false;
          try {
            await gate.register(run.turn);
            registered = true;
            run.controller.signal.throwIfAborted();
            await host.registerTurn(run.turn, run.controller.signal);
            run.controller.signal.throwIfAborted();
            emit('turn.started', {}, run.turn);
            const content = cloneRuntimeJson(input.content);
            if (!Array.isArray(content) || content.some(item => !item || (item.type === 'text'
              ? typeof item.text !== 'string' : item.type === 'image'
                ? typeof item.data !== 'string' || typeof item.mimeType !== 'string' || !item.mimeType.startsWith('image/')
                : true))) throw new Error('MA_INPUT_INVALID');
            const images = content.filter((item): item is ImageContent => item.type === 'image');
            if (images.length && !capability.input.includes('image')) throw new Error('MA_MODEL_IMAGE_UNSUPPORTED');
            const text = resources.expandPrompt(content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
            const result = operation?.kind === 'completion' ? await sdk.completeProtected(PROTECTED_COMPLETION_PROMPT, run.turn)
              : operation?.kind === 'compaction' ? await sdk.compact(run.turn, operation.instructions)
              : operation?.kind === 'branch_summary' ? await sdk.summarizeBranch(run.turn, operation.targetEntryId!, operation.instructions)
              : await sdk.prompt(text, run.turn, images);
            if (result.status !== 'completed' || run.cancelled || run.paused) {
              await gate.stop(run.turn.turnId);
              await host.revokeTurn(run.turn);
              const status = run.paused ? 'paused' : run.cancelled ? 'cancelled' : 'failed';
              const error = run.failure ?? (result.error ? publicRuntimeError(result.error) : undefined);
              emit(`turn.${status}`, error ? { error } : {}, run.turn);
              return { status, engineSessionId, turn: run.turn, ...unresolved(), ...(error ? { error } : {}) } as TurnOutcome;
            }
            const completion = await gate.complete(run.turn.turnId);
            await host.receiptComplete({ turn: run.turn, localCompletion: completion,
              receiptSetHash: receipts.digest(toolBridge.receiptReferences(run.turn)), ...unresolved() });
            emit('turn.completed', { journalSeq: completion.journalSeq }, run.turn);
            return { status: 'completed', engineSessionId, turn: run.turn, completion, ...unresolved() } as TurnOutcome;
          } catch (error) {
            if (registered) { await gate.stop(run.turn.turnId).catch(() => {}); await host.revokeTurn(run.turn).catch(() => { run.paused = true; }); }
            const pending = unresolved();
            const uncertain = run.paused || pending.unresolvedCallIds.length > 0 || pending.unresolvedExecutionIds.length > 0;
            const status = uncertain ? 'paused' : run.cancelled ? 'cancelled' : 'failed';
            const failure = run.failure ?? publicRuntimeError(error);
            emit(`turn.${status}`, { error: failure }, run.turn);
            return { status, engineSessionId, turn: run.turn, ...unresolved(),
              error: failure } as TurnOutcome;
          } finally {
            run.purpose = undefined;
            bridge.forgetTurn(run.turn);
            if (active === run) active = undefined;
          }
        });
        return run.result;
    };
    const session: MaSession = {
      sessionId: scope.maSessionId, engineSessionId,
      inspectHistory: input => cloneRuntimeJson(input?.all ? manager.getEntries() : manager.getBranch()) as unknown as ReadonlyArray<Record<string, unknown>>,
      providerState: () => provider?.getProviderState?.() ?? null,
      inspectModelExecution,
      prompt: (input, turn) => performTurn(input, turn),
      completeProtected: turn => performTurn({ content: [] }, turn, { kind: 'completion' }),
      compact: (input, turn) => performTurn({ content: [] }, turn, { ...cloneRuntimeJson(input), kind: 'compaction' }),
      summarizeBranch: (input, turn) => performTurn({ content: [] }, turn, { ...cloneRuntimeJson(input), kind: 'branch_summary' }),
      async abort(turnId) {
        const run = active;
        if (!run || run.turn.turnId !== turnId) throw new Error('MA_TURN_MISMATCH');
        run.cancelled = true;
        run.controller.abort();
        const stopped = gate.stop(turnId).catch(() => {});
        await sdk.abort(turnId).catch(() => {});
        await run.result;
        await stopped;
        return { engineSessionId, turn: run.turn, localIdle: true, ...unresolved() };
      },
      subscribe(listener) {
        if (closing) throw new Error('MA_SESSION_BUSY');
        listeners.add(listener);
        try { void Promise.resolve(listener(cloneRuntimeJson(readyEvent))).catch(() => {}); } catch { /* Observer only. */ }
        return () => { listeners.delete(listener); };
      },
      recover() {
        if (active || memoryOperation || recovering || closing) return Promise.reject(new Error('MA_SESSION_BUSY'));
        recovering = true;
        const work = (async (): Promise<RecoveryOutcome> => {
          unsubscribeFacade(); await sdk.close();
          try { await reconcile(); } catch { recoveryReason = 'MA_RECOVERY_RECONCILIATION_REQUIRED'; }
          sdk = await makeFacade(); pi = sdk; unsubscribeFacade = subscribeFacade();
          const snapshot = gate.snapshot();
          const paused = Boolean(recoveryReason || snapshot.state === 'paused');
          readyEvent = emit('runtime.ready', { capability: cloneRuntimeJson(capability), recoveryRequired: paused, ...unresolved() });
          return { status: paused ? 'paused' : 'ready', sessionId: scope.maSessionId, ...unresolved(),
            ...(paused ? { reason: recoveryReason ?? 'MA_RECOVERY_RECONCILIATION_REQUIRED' } : {}) };
        })();
        recoveryOperation = work;
        return work.finally(() => { recovering = false; if (recoveryOperation === work) recoveryOperation = undefined; });
      },
      editContext(input) {
        if (active || closing || memoryOperation || recovering) return Promise.reject(new Error('MA_SESSION_BUSY'));
        if (recoveryReason || gate.snapshot().state === 'paused' || unresolved().unresolvedCallIds.length || unresolved().unresolvedExecutionIds.length) {
          return Promise.reject(new Error('MA_RECOVERY_REQUIRED'));
        }
        const command = cloneRuntimeJson(input);
        requireOwnData(command, ['action']);
        if (!['clear', 'revert', 'pin'].includes(command.action) || Object.keys(command).some(key => !['action', 'text'].includes(key))
          || (command.action === 'pin' && (typeof command.text !== 'string' || !command.text.trim()))) {
          return Promise.reject(new Error('MA_INPUT_INVALID'));
        }
        const work = (async () => {
          const branch = manager.getBranch();
          const before = branch.filter(entry => entry.type === 'message').length;
          unsubscribeFacade(); await sdk.close();
          let entryId: string | undefined;
          if (command.action === 'clear') {
            manager.resetLeaf();
            manager.appendCustomEntry('ma.context_navigation', { action: 'clear', previousLeaf: branch.at(-1)?.id ?? null });
          } else if (command.action === 'revert') {
            const user = [...branch].reverse().find(entry => entry.type === 'message' && entry.message.role === 'user');
            if (user?.parentId) manager.branch(user.parentId);
            else manager.resetLeaf();
            manager.appendCustomEntry('ma.context_navigation', { action: 'revert', previousLeaf: branch.at(-1)?.id ?? null });
          } else {
            entryId = manager.appendCustomMessageEntry('ma.user_context', command.text!, true);
          }
          const file = manager.getSessionFile();
          if (file) { const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
          frame?.invalidate();
          if (closing) throw new Error('MA_SESSION_CLOSED');
          sdk = await makeFacade(); pi = sdk; unsubscribeFacade = subscribeFacade();
          const after = manager.getBranch().filter(entry => entry.type === 'message').length;
          return { removedMessages: Math.max(0, before - after), ...(entryId ? { entryId } : {}) };
        })();
        memoryOperation = work;
        return work.catch(error => { recoveryReason = 'MA_RECOVERY_RECONCILIATION_REQUIRED'; throw error; })
          .finally(() => { if (memoryOperation === work) memoryOperation = undefined; });
      },
      memory(action) {
        if (active || closing || memoryOperation || recovering) return Promise.reject(new Error('MA_SESSION_BUSY'));
        const work = Promise.resolve().then(() => memoryControl(action));
        memoryOperation = work;
        return work.finally(() => { if (memoryOperation === work) memoryOperation = undefined; });
      },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        const run = active;
        if (run) { run.cancelled = true; run.controller.abort(); void gate.stop(run.turn.turnId).catch(() => {}); }
        closePromise = (async () => {
          await memoryOperation?.catch(() => {});
          await recoveryOperation?.catch(() => {});
          if (run) { await sdk.abort(run.turn.turnId).catch(() => {}); await run.result; }
          await sdk.close();
          if (!options.connections) for (const connection of connections) await connection.close();
          if (!options.providerRuntime) await provider?.close?.();
          listeners.clear();
          await ownedJournal.close();
        })();
        return closePromise;
      },
    };
    return session;
  } catch (error) {
    await pi?.close().catch(() => {});
    if (!options.connections) for (const connection of connections) await connection.close().catch(() => {});
    if (!options.providerRuntime) await provider?.close?.().catch(() => {});
    await journal?.close().catch(() => {});
    throw error;
  }
}

import type { AgoraMemory, AgoraMemoryController, AgoraMemoryPatch } from '../provider/agora.js';
import { resolveAgoraDataRoot } from '../provider/agora.js';
import type { AgentConfig, ProviderSessionState } from '../mcp/types.js';
import type { ProviderRuntime } from '../provider/runtime.js';
import { cloneRuntimeJson, requireOwnData } from './data.js';
import { constants } from 'node:fs';
import { open, realpath, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
interface MemoryContext { config: AgentConfig; sessionId: string; agent: Pick<ProviderRuntime, 'getProviderState'> }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value); return keys.length === expected.length && keys.every(key => expected.includes(key));
}
function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
export interface MaMemoryState {
  state: 'unavailable' | 'ready-empty' | 'ready' | 'pending-verification' | 'mounted' | 'failed';
  runtime: 'agora' | null;
  message: string;
  modules: Array<{
    id: string;
    name: string;
    description: string;
    version: number;
    status: 'draft' | 'available' | 'mounted' | 'stale' | 'failed';
    mountable: boolean;
    versions: number[];
  }>;
  mountedIds: string[];
  verifiedRevision: number | null;
  verifiedAt: string | null;
  pendingOperation: 'mount' | 'unmount' | 'internalize' | 'rollback' | null;
  operationReport: MemoryOperationReport | null;
}

type MemoryOperation = Exclude<MaMemoryState['pendingOperation'], null>;

export interface MemoryOperationFailure {
  moduleId: string | null;
  status: 'review' | 'conflict' | 'failed' | 'timeout';
  message: string;
}

export interface MemoryOperationReport {
  operation: MemoryOperation;
  outcome: 'success' | 'partial' | 'failed';
  succeededModuleIds: string[];
  failures: MemoryOperationFailure[];
}

export interface PendingMemoryVerification {
  operation: MemoryOperation;
  requiresVerification: boolean;
  baselineRevision: number | null;
  baselineVerifiedAt: string | null;
  baselineActivePatchIds: string[];
  expectedActivePatchIds: string[];
  report: MemoryOperationReport | null;
}

export interface MemoryVerificationSnapshot {
  revision: number | null;
  verifiedAt: string | null;
  activePatchIds: string[];
  requestedPatchIds: string[] | null;
  status: string | null;
}

export interface InternalizeMemoryResult {
  changed: boolean;
  report: MemoryOperationReport;
}

export type MaMemoryAction =
  | { action: 'state'; sessionId: string }
  | { action: 'create'; sessionId: string; name: string }
  | { action: 'rename'; sessionId: string; moduleId: string; name: string }
  | { action: 'mount'; sessionId: string; ids: string[] }
  | { action: 'unmount'; sessionId: string }
  | { action: 'internalize'; sessionId: string; moduleIds: string[]; scope: 'conversation' | 'project' }
  | { action: 'rollback'; sessionId: string; moduleId: string; version: number };

interface SavedMemoryControl {
  schemaVersion: 2;
  sessionId: string;
  profileId: string;
  providerIdentitySha256: string;
  pending: PendingMemoryVerification | null;
  uncertain: boolean;
}

async function memoryProviderIdentity(config: AgentConfig): Promise<string> {
  let dataRoot: string | null = null;
  if (config.model.provider === 'agora') {
    let ancestor = resolveAgoraDataRoot(config.model.agoraRuntime);
    const missing: string[] = [];
    // Resolve existing aliases without creating or reading the provider's data.
    // A not-yet-created suffix retains the same identity once Agora creates it.
    for (;;) {
      try { dataRoot = join(await realpath(ancestor), ...missing); break; }
      catch (error) {
        const parent = dirname(ancestor);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === ancestor) {
          throw new Error('MA_MEMORY_PROVIDER_IDENTITY_UNAVAILABLE');
        }
        missing.unshift(basename(ancestor)); ancestor = parent;
      }
    }
  }
  const memory = config.model.agoraMemory;
  return createHash('sha256').update(JSON.stringify({
    domain: 'ma.memory.provider-identity.v1', provider: config.model.provider ?? null, model: config.model.model,
    dataRoot, userId: memory?.userId ?? null, projectId: memory?.projectId ?? null,
    conversationId: memory?.conversationId ?? null, memoryProfile: memory?.memoryProfile ?? null,
  }), 'utf8').digest('hex');
}

function invalidMemoryState(): Error {
  return new Error('MA_MEMORY_STATE_INVALID');
}

function savedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = requireOwnData(value, keys);
  if (!exactKeys(record, keys)) throw invalidMemoryState();
  return record;
}

function savedPatchIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalidMemoryState();
  const ids = value.map(id => boundedId(id, 'patchId'));
  if (new Set(ids).size !== ids.length) throw invalidMemoryState();
  return ids;
}

/** Persist verification facts only. Provider reports may contain conversation text. */
function parseSavedMemoryControl(value: unknown): SavedMemoryControl {
  const saved = savedRecord(value, ['schemaVersion', 'sessionId', 'profileId', 'providerIdentitySha256', 'pending', 'uncertain']);
  if (saved.schemaVersion !== 2 || typeof saved.uncertain !== 'boolean'
    || typeof saved.providerIdentitySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(saved.providerIdentitySha256)
    || typeof saved.sessionId !== 'string' || !saved.sessionId.trim() || saved.sessionId.length > 128
    || typeof saved.profileId !== 'string' || !saved.profileId.trim() || saved.profileId.length > 128) {
    throw invalidMemoryState();
  }
  let pending: PendingMemoryVerification | null = null;
  if (saved.pending !== null) {
    const record = savedRecord(saved.pending, ['operation', 'requiresVerification', 'baselineRevision',
      'baselineVerifiedAt', 'baselineActivePatchIds', 'expectedActivePatchIds', 'report']);
    if (typeof record.operation !== 'string' || !['mount', 'unmount', 'internalize', 'rollback'].includes(record.operation)
      || typeof record.requiresVerification !== 'boolean' || record.report !== null
      || (record.baselineRevision !== null && !boundedInteger(record.baselineRevision, 0, Number.MAX_SAFE_INTEGER))) {
      throw invalidMemoryState();
    }
    const verifiedAt = record.baselineVerifiedAt;
    if (verifiedAt !== null && (typeof verifiedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(verifiedAt)
      || !Number.isFinite(Date.parse(verifiedAt)) || new Date(verifiedAt).toISOString() !== verifiedAt)) {
      throw invalidMemoryState();
    }
    pending = {
      operation: record.operation as MemoryOperation, requiresVerification: record.requiresVerification,
      baselineRevision: record.baselineRevision as number | null, baselineVerifiedAt: verifiedAt as string | null,
      baselineActivePatchIds: savedPatchIds(record.baselineActivePatchIds),
      expectedActivePatchIds: savedPatchIds(record.expectedActivePatchIds), report: null,
    };
  }
  return { schemaVersion: 2, sessionId: saved.sessionId, profileId: saved.profileId,
    providerIdentitySha256: saved.providerIdentitySha256, pending, uncertain: saved.uncertain };
}

/** Provider control only. These operations never enter Pi's prompt/tool loop. */
export async function createMemoryControl(input: {
  sessionId: string; directory: string; profileId: string; config: AgentConfig; provider: ProviderRuntime;
}): Promise<(params: MaMemoryAction) => Promise<MaMemoryState>> {
  const boot: MemoryContext = { config: input.config, sessionId: input.sessionId, agent: input.provider };
  const file = join(input.directory, 'memory-control.json');
  const providerIdentitySha256 = await memoryProviderIdentity(input.config);
  let pending: PendingMemoryVerification | null = null;
  let uncertain = false;
  let handle;
  try {
    // O_NONBLOCK prevents a substituted FIFO from hanging before fstat can reject it.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.size > 1024 * 1024) throw invalidMemoryState();
    const saved = parseSavedMemoryControl(cloneRuntimeJson(JSON.parse(await handle.readFile('utf8'))));
    if (saved.sessionId !== input.sessionId || saved.profileId !== input.profileId) throw new Error('MA_MEMORY_IDENTITY_MISMATCH');
    if (saved.providerIdentitySha256 !== providerIdentitySha256) throw new Error('MA_MEMORY_PROVIDER_IDENTITY_MISMATCH');
    pending = saved.pending; uncertain = saved.uncertain;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof Error && ['MA_MEMORY_IDENTITY_MISMATCH', 'MA_MEMORY_PROVIDER_IDENTITY_MISMATCH'].includes(error.message)) throw error;
      throw invalidMemoryState();
    }
  }
  finally { await handle?.close(); }
  const save = async () => {
    const saved = parseSavedMemoryControl({ schemaVersion: 2, sessionId: input.sessionId, profileId: input.profileId, providerIdentitySha256,
      pending: pending ? { ...pending, report: null } : null, uncertain });
    const temporary = `${file}.${randomUUID()}.pending`;
    const output = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await output.writeFile(`${JSON.stringify(saved)}\n`);
      await output.sync();
    } finally { await output.close(); }
    await rename(temporary, file);
    const parent = await open(input.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  };
  return async value => {
    const action = parseMemoryAction(cloneRuntimeJson(value) as unknown as Record<string, unknown>);
    if (action.sessionId !== input.sessionId) throw new Error('MA_MEMORY_IDENTITY_MISMATCH');
    await input.provider.ready?.();
    const controller = input.provider.getMemoryController?.();
    if (!controller) return unavailableMemoryState();
    if (!controller.getCapabilities().memoryV2) return failedMemoryState('Agora Memory Runtime v2 is required for named memory modules.');
    if (action.action === 'state') {
      if (uncertain) return failedMemoryState('An earlier memory change has an unconfirmed outcome. Verify that operation with Agora before changing memory again.');
      const state = await memoryState(boot, controller, pending);
      if (state.state !== 'pending-verification' && pending) { pending = null; await save(); }
      return state;
    }
    if (uncertain || pending?.requiresVerification) return failedMemoryState('Wait for the existing memory change to be confirmed by a real Agora reply before starting another change.');
    const baseline = memoryVerificationSnapshot(boot);
    uncertain = true;
    await save();
    try {
      switch (action.action) {
        case 'create': await controller.createMemory(action.name); break;
        case 'rename': await controller.renameMemory(action.moduleId, action.name); break;
        case 'mount':
        case 'unmount': {
          await controller.mountMemories(await memoryProfileId(boot, controller), action.action === 'mount' ? action.ids : [], 'conversation');
          pending = pendingMemoryVerification(boot, action.action, baseline); break;
        }
        case 'internalize': {
          const result = await internalizeMemory(boot, controller, action.moduleIds, action.scope);
          pending = result.changed ? pendingMemoryVerification(boot, 'internalize', baseline, result.report)
            : completedMemoryOperation('internalize', baseline, result.report); break;
        }
        case 'rollback':
          await rollbackMemory(boot, controller, action.moduleId, action.version);
          pending = pendingMemoryVerification(boot, 'rollback', baseline); break;
      }
      uncertain = false; await save();
      return memoryState(boot, controller, pending);
    } catch {
      // A missing response is not proof that the provider-side mutation did not happen.
      uncertain = true; await save();
      return failedMemoryState('The memory operation has an unconfirmed outcome. Check the existing Agora operation; do not repeat it blindly.');
    }
  };
}

function parseMemoryAction(params: Record<string, unknown>): MaMemoryAction {
  const sessionId = boundedId(params.sessionId, 'sessionId');
  switch (params.action) {
    case 'state':
      exactAction(params, ['action', 'sessionId']);
      return { action: 'state', sessionId };
    case 'create':
      exactAction(params, ['action', 'name', 'sessionId']);
      return { action: 'create', sessionId, name: memoryName(params.name) };
    case 'rename':
      exactAction(params, ['action', 'moduleId', 'name', 'sessionId']);
      return {
        action: 'rename', sessionId,
        moduleId: boundedId(params.moduleId, 'moduleId'),
        name: memoryName(params.name),
      };
    case 'mount':
      exactAction(params, ['action', 'ids', 'sessionId']);
      return { action: 'mount', sessionId, ids: memoryIds(params.ids) };
    case 'unmount':
      exactAction(params, ['action', 'sessionId']);
      return { action: 'unmount', sessionId };
    case 'internalize':
      exactAction(params, ['action', 'moduleIds', 'scope', 'sessionId']);
      if (params.scope !== 'conversation' && params.scope !== 'project') throw new Error('MA memory scope is invalid');
      return { action: 'internalize', sessionId, moduleIds: memoryIds(params.moduleIds), scope: params.scope };
    case 'rollback':
      exactAction(params, ['action', 'moduleId', 'sessionId', 'version']);
      if (!boundedInteger(params.version, 1, 10_000)) throw new Error('MA memory version is invalid');
      return {
        action: 'rollback', sessionId,
        moduleId: boundedId(params.moduleId, 'moduleId'),
        version: Number(params.version),
      };
    default:
      throw new Error('MA memory action is invalid');
  }
}

function exactAction(value: Record<string, unknown>, keys: string[]): void {
  if (!exactKeys(value, keys)) throw new Error('MA memory action contains unsupported fields');
}

function boundedId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error(`MA memory ${field} is invalid`);
  }
  return value;
}

function memoryName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('MA memory name is invalid');
  const normalized = value.trim();
  if (!normalized || normalized.length > 80 || /\p{Cc}/u.test(normalized)) {
    throw new Error('MA memory name is invalid');
  }
  return normalized;
}

function memoryIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error('MA memory ids are invalid');
  const ids = value.map((item) => boundedId(item, 'moduleId'));
  if (new Set(ids).size !== ids.length) throw new Error('MA memory ids contain duplicates');
  return ids;
}

async function memoryProfileId(boot: MemoryContext, controller: AgoraMemoryController): Promise<string> {
  const stateProfile = boot.agent.getProviderState?.()?.memory?.profile_id;
  if (stateProfile) return stateProfile;
  const configured = boot.config.model.agoraMemory?.memoryProfile;
  if (configured) return configured;
  const profileId = `ma-${boot.sessionId}`;
  const profiles = await controller.listProfiles();
  if (!profiles.some((profile) => profile.id === profileId)) {
    await controller.createProfile({ profile_id: profileId, name: 'MTEAM Memory', active_memory_patch_ids: [] });
  }
  return profileId;
}

function memoryVerificationSnapshot(boot: MemoryContext): MemoryVerificationSnapshot {
  const providerState = boot.agent.getProviderState?.() ?? null;
  const memory = providerState?.memory;
  const activePatchIds = Array.isArray(memory?.active_memory_patch_ids)
    ? memory.active_memory_patch_ids.filter((id): id is string => typeof id === 'string')
    : [];
  const requestedPatchIds = Array.isArray(memory?.requested_memory_patch_ids)
    ? memory.requested_memory_patch_ids.filter((id): id is string => typeof id === 'string')
    : null;
  return {
    revision: typeof memory?.patchset_revision === 'number' && Number.isFinite(memory.patchset_revision)
      ? memory.patchset_revision : null,
    verifiedAt: typeof memory?.last_verified_at === 'string'
      ? memory.last_verified_at
      : typeof providerState?.last_verified_at === 'string' ? providerState.last_verified_at : null,
    activePatchIds,
    requestedPatchIds,
    status: typeof memory?.status === 'string' ? memory.status : null,
  };
}

function pendingMemoryVerification(
  boot: MemoryContext,
  operation: MemoryOperation,
  baseline: MemoryVerificationSnapshot,
  report: MemoryOperationReport | null = null,
): PendingMemoryVerification {
  const current = memoryVerificationSnapshot(boot);
  return {
    operation,
    requiresVerification: true,
    baselineRevision: baseline.revision,
    baselineVerifiedAt: baseline.verifiedAt,
    baselineActivePatchIds: baseline.activePatchIds,
    expectedActivePatchIds: current.requestedPatchIds ?? current.activePatchIds,
    report,
  };
}

function completedMemoryOperation(
  operation: MemoryOperation,
  baseline: MemoryVerificationSnapshot,
  report: MemoryOperationReport,
): PendingMemoryVerification {
  return {
    operation,
    requiresVerification: false,
    baselineRevision: baseline.revision,
    baselineVerifiedAt: baseline.verifiedAt,
    baselineActivePatchIds: baseline.activePatchIds,
    expectedActivePatchIds: baseline.activePatchIds,
    report,
  };
}

export function assessMemoryVerification(
  current: MemoryVerificationSnapshot,
  pending: PendingMemoryVerification | null,
): 'none' | 'pending' | 'verified' | 'failed' {
  if (!pending) return 'none';
  if (!pending.requiresVerification) return 'verified';
  const verifiedAtMs = current.verifiedAt === null ? Number.NaN : Date.parse(current.verifiedAt);
  const baselineVerifiedAtMs = pending.baselineVerifiedAt === null
    ? Number.NaN : Date.parse(pending.baselineVerifiedAt);
  const hasNewVerification = Number.isFinite(verifiedAtMs) && (
    pending.baselineVerifiedAt === null
    || (Number.isFinite(baselineVerifiedAtMs) && verifiedAtMs > baselineVerifiedAtMs)
  );
  if (!hasNewVerification) return 'pending';
  if (current.status === 'pending') return 'pending';

  const activeMatches = sameIds(current.activePatchIds, pending.expectedActivePatchIds);
  const activeChanged = !sameIds(pending.baselineActivePatchIds, pending.expectedActivePatchIds);
  const revisionProvesChange = current.revision !== null && (
    pending.baselineRevision === null
    || (activeChanged ? current.revision > pending.baselineRevision : current.revision >= pending.baselineRevision)
  );
  const successfulStatus = pending.expectedActivePatchIds.length > 0
    ? current.status === 'mounted'
    : current.status === 'empty' || current.status === 'unmounted';
  if (!successfulStatus || !activeMatches || !revisionProvesChange) {
    return 'failed';
  }
  return 'verified';
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export async function internalizeMemory(
  boot: MemoryContext,
  controller: AgoraMemoryController,
  moduleIds: string[],
  scope: 'conversation' | 'project',
): Promise<InternalizeMemoryResult> {
  const [memories, patches] = await Promise.all([controller.listMemories(), controller.listPatches(true)]);
  const selected = moduleIds.map((id) => {
    const memory = memories.find((item) => item.id === id);
    if (!memory) throw new Error(`Memory not found: ${id}`);
    const versions = patches.filter((patch) => patch.memory_id === id);
    return {
      mode: 'increment' as const,
      memory_id: id,
      ...(memory.head_patch_id ? { expected_parent_patch_id: memory.head_patch_id } : {}),
      output_name: `${memory.name}@v${versions.length + 1}`,
    };
  });
  const profileId = await memoryProfileId(boot, controller);
  const submitted = await controller.startBatchIntake({ targets: selected });
  let batch = submitted;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (batch.targets.every((target) => ['completed', 'noop', 'review', 'conflict', 'failed'].includes(target.status))) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
    batch = await controller.getBatchIntake(batch.batch_id);
  }
  const succeededModuleIds = batch.targets.flatMap((target, index) => {
    if (target.status !== 'completed' && target.status !== 'noop') return [];
    const fallback = moduleIds[index];
    const id = target.memory_id ?? fallback;
    return typeof id === 'string' && moduleIds.includes(id) ? [id] : [];
  });
  const failures: MemoryOperationFailure[] = batch.targets.flatMap((target, index) => {
    if (target.status === 'completed' || target.status === 'noop') return [];
    const status = ['review', 'conflict', 'failed'].includes(target.status)
      ? target.status as MemoryOperationFailure['status']
      : 'timeout';
    return [{
      moduleId: target.memory_id ?? moduleIds[index] ?? null,
      status,
      message: target.error?.message ?? (status === 'timeout'
        ? 'Memory intake did not reach a terminal state before the verification deadline.'
        : `Memory intake ${status}`),
    }];
  });
  const uniqueSucceededIds = [...new Set(succeededModuleIds)];
  const completedTargets = batch.targets.filter((target) => target.status === 'completed' && target.output_patch_id);
  let changed = false;
  if (scope === 'project' && completedTargets.length > 0) {
    await controller.applyCompletedBatch({ ...batch, targets: completedTargets }, profileId);
    changed = true;
  } else if (scope === 'conversation' && uniqueSucceededIds.length > 0) {
    const refreshed = await controller.listMemories();
    const mountableSuccesses = uniqueSucceededIds.filter((id) => refreshed.some((memory) => memory.id === id));
    if (mountableSuccesses.length > 0) {
      const activePatchIds = memoryVerificationSnapshot(boot).activePatchIds;
      const alreadyMountedIds = activePatchIds.map((patchId) => {
        const patch = patches.find((item) => item.id === patchId);
        if (!patch?.memory_id) throw new Error(`Cannot safely preserve active memory patch: ${patchId}`);
        return patch.memory_id;
      });
      await controller.mountMemories(
        profileId,
        [...new Set([...alreadyMountedIds, ...mountableSuccesses])],
        'conversation',
      );
      changed = true;
    }
  }
  return {
    changed,
    report: {
      operation: 'internalize',
      outcome: failures.length === 0 ? 'success' : uniqueSucceededIds.length > 0 ? 'partial' : 'failed',
      succeededModuleIds: uniqueSucceededIds,
      failures,
    },
  };
}

async function rollbackMemory(
  boot: MemoryContext,
  controller: AgoraMemoryController,
  moduleId: string,
  version: number,
): Promise<void> {
  const [memories, patches] = await Promise.all([controller.listMemories(), controller.listPatches(true)]);
  const memory = memories.find((item) => item.id === moduleId);
  if (!memory?.head_patch_id) throw new Error('MA memory has no current version');
  const versions = patchesForMemory(patches, moduleId);
  const target = versions.find((entry) => entry.version === version)?.patch;
  if (!target) throw new Error('MA memory version was not found');
  const activePatchIds = memoryVerificationSnapshot(boot).activePatchIds;
  const mountedMemoryIds = activePatchIds.map((patchId) => {
    const patch = patches.find((item) => item.id === patchId);
    if (!patch?.memory_id) throw new Error(`Cannot safely preserve active memory patch: ${patchId}`);
    return patch.memory_id;
  });
  await controller.rollbackMemory(moduleId, memory.head_patch_id, target.id);
  if (mountedMemoryIds.includes(moduleId)) {
    const profileId = await memoryProfileId(boot, controller);
    await controller.mountMemories(profileId, [...new Set(mountedMemoryIds)], 'conversation');
  }
}

export async function memoryState(
  boot: MemoryContext,
  controller: AgoraMemoryController,
  pendingVerification: PendingMemoryVerification | null,
): Promise<MaMemoryState> {
  const [memories, patches, profiles] = await Promise.all([
    controller.listMemories(),
    controller.listPatches(true),
    controller.listProfiles(),
  ]);
  const providerState = boot.agent.getProviderState?.() ?? null;
  const profileId = providerState?.memory?.profile_id ?? boot.config.model.agoraMemory?.memoryProfile ?? null;
  const profile = profiles.find((item) => item.id === profileId) ?? null;
  const activePatchIds = new Set(providerState?.memory?.active_memory_patch_ids ?? []);
  const requestedPatchIds = new Set(providerState?.memory?.requested_memory_patch_ids ?? []);
  const mountedIds = memories.flatMap((memory) => (
    memory.head_patch_id && activePatchIds.has(memory.head_patch_id) ? [memory.id] : []
  ));
  const modules = memories.map((memory) => memoryModule(
    memory,
    patches,
    activePatchIds,
    requestedPatchIds,
    boot.config.model.model,
  ));
  const verification = assessMemoryVerification(memoryVerificationSnapshot(boot), pendingVerification);
  const memoryStatus = providerState?.memory?.status;
  const pending = verification === 'pending';
  const state: MaMemoryState['state'] = verification === 'failed'
    ? 'failed'
    : pending
    ? 'pending-verification'
    : memoryStatus === 'failed' || memoryStatus === 'stale'
      ? 'failed'
      : mountedIds.length > 0
        ? 'mounted'
        : modules.length > 0 ? 'ready' : 'ready-empty';
  return {
    state,
    runtime: 'agora',
    message: pending
      ? 'Waiting for the next real Agora reply. MTEAM will accept the change only after chat_complete metadata proves the active patches, revision, and verification time; it will not generate a verification message.'
      : verification === 'failed'
        ? 'Agora replied, but its chat_complete metadata did not prove the requested memory change.'
      : profile
        ? `${mountedIds.length} of ${modules.length} memory modules are mounted.`
        : 'Agora is ready. Create or mount a named memory to begin.',
    modules,
    mountedIds,
    verifiedRevision: typeof providerState?.memory?.patchset_revision === 'number'
      ? providerState.memory.patchset_revision : null,
    verifiedAt: providerState?.memory?.last_verified_at ?? providerState?.last_verified_at ?? null,
    pendingOperation: pending ? pendingVerification?.operation ?? null : null,
    operationReport: pendingVerification?.report ?? null,
  };
}

function memoryModule(
  memory: AgoraMemory,
  patches: AgoraMemoryPatch[],
  activePatchIds: Set<string>,
  requestedPatchIds: Set<string>,
  modelId: string,
): MaMemoryState['modules'][number] {
  const versions = patchesForMemory(patches, memory.id);
  const current = versions.find((entry) => entry.patch.id === memory.head_patch_id) ?? versions.at(-1);
  const mounted = versions.some((entry) => activePatchIds.has(entry.patch.id));
  const requested = versions.some((entry) => requestedPatchIds.has(entry.patch.id));
  const mountable = Boolean(
    memory.head_patch_id
    && current?.patch.id === memory.head_patch_id
    && current.patch.mountable
    && current.patch.base_model_id === modelId,
  );
  const description = typeof memory.metadata?.description === 'string'
    ? memory.metadata.description
    : `${memory.base_model_id}${requested && !mounted ? ' · pending verification' : ''}`;
  return {
    id: memory.id,
    name: memory.name,
    description,
    version: current?.version ?? 1,
    status: memory.status === 'failed'
      ? 'failed'
      : mounted
        ? 'mounted'
        : requested
          ? 'stale'
          : mountable ? 'available' : 'draft',
    mountable,
    versions: versions.map((entry) => entry.version),
  };
}

function patchesForMemory(
  patches: AgoraMemoryPatch[],
  memoryId: string,
): Array<{ patch: AgoraMemoryPatch; version: number }> {
  const selected = patches
    .filter((patch) => patch.memory_id === memoryId)
    .sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }) || left.id.localeCompare(right.id));
  return selected.map((patch, index) => {
    const parsed = Number(patch.version.match(/\d+/)?.[0]);
    return { patch, version: Number.isSafeInteger(parsed) && parsed > 0 ? parsed : index + 1 };
  });
}

function unavailableMemoryState(): MaMemoryState {
  return {
    state: 'unavailable', runtime: null,
    message: 'Select the Agora Local runtime to use MA named memory.',
    modules: [], mountedIds: [], verifiedRevision: null, verifiedAt: null, pendingOperation: null,
    operationReport: null,
  };
}

function failedMemoryState(message: string): MaMemoryState {
  return {
    ...unavailableMemoryState(),
    state: 'failed', runtime: 'agora', message,
  };
}

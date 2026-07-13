import type {
  AgoraMemory,
  AgoraMemoryIntakeTarget,
  AgoraMemoryIntakeTargetResult,
  AgoraMemoryPatch,
  AgoraMemoryProfile,
} from './agora.js';

export interface AgoraAutoIntakePlan {
  ready: boolean;
  reason: string;
  sourceStart: number;
  sourceEnd: number;
  pendingUserTurns: number;
  pendingTokens: number;
  targets: AgoraMemoryIntakeTarget[];
}

export function planAgoraAutoIntake(args: {
  messages: any[];
  checkpointEnd: number;
  profile: AgoraMemoryProfile;
  memories: AgoraMemory[];
  patches: AgoraMemoryPatch[];
}): AgoraAutoIntakePlan {
  const sourceStart = Math.max(0, Math.min(args.messages.length, Math.floor(args.checkpointEnd)));
  const pending = args.messages.slice(sourceStart);
  const pendingUserTurns = pending.filter((message) => message?.role === 'user').length;
  const pendingTokens = Math.ceil(JSON.stringify(pending).length / 4);
  const minTurns = Number(args.profile.auto_intake_policy?.min_user_turns ?? 4);
  const minTokens = Number(args.profile.auto_intake_policy?.min_pending_tokens ?? 2000);
  const thresholdReached = pendingUserTurns >= minTurns || pendingTokens >= minTokens;
  const targetIds = args.profile.auto_intake_target_memory_ids ?? [];
  const targets = targetIds.map((memoryId) => {
    const memory = args.memories.find((item) => item.id === memoryId);
    if (!memory) throw new Error(`自动内化目标不存在: ${memoryId}`);
    if (!memory.head_patch_id) throw new Error(`自动内化目标没有可增量版本: ${memory.name}`);
    return {
      mode: 'increment' as const,
      memory_id: memory.id,
      expected_parent_patch_id: memory.head_patch_id,
      output_name: `${memory.name}@v${args.patches.filter((patch) => patch.memory_id === memory.id).length + 1}`,
    };
  });
  const reason = targetIds.length === 0
    ? 'no_explicit_targets'
    : pending.length === 0
      ? 'no_pending_messages'
      : thresholdReached ? 'ready' : 'below_threshold';
  return {
    ready: reason === 'ready',
    reason,
    sourceStart,
    sourceEnd: args.messages.length,
    pendingUserTurns,
    pendingTokens,
    targets,
  };
}

export function classifyAgoraBatchTargets(targets: AgoraMemoryIntakeTargetResult[]): {
  terminal: boolean;
  completed: AgoraMemoryIntakeTargetResult[];
  blockers: AgoraMemoryIntakeTargetResult[];
  retryable: AgoraMemoryIntakeTargetResult[];
} {
  const terminalStatuses = new Set(['completed', 'noop', 'review', 'conflict', 'failed']);
  return {
    terminal: targets.length > 0 && targets.every((target) => terminalStatuses.has(target.status)),
    completed: targets.filter((target) => target.status === 'completed' || target.status === 'noop'),
    blockers: targets.filter((target) => target.status === 'review' || target.status === 'conflict' || target.status === 'failed'),
    retryable: targets.filter((target) => target.status === 'review' || target.status === 'conflict' || (target.status === 'failed' && target.error?.retryable !== false)),
  };
}

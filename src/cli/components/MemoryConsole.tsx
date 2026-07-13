import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type {
  AgoraMemory,
  AgoraMemoryIntakeTarget,
  AgoraMemoryPatch,
  AgoraMemoryProfile,
} from '../../provider/agora.js';

export interface MemoryConsoleProps {
  project: string;
  memories: AgoraMemory[];
  patches: AgoraMemoryPatch[];
  profile?: AgoraMemoryProfile;
  verifiedPatchIds?: string[];
  verificationStatus?: string;
  activity?: string;
  activeBatch?: Record<string, any>;
  sourceRange?: { start: number; end: number };
  busy?: boolean;
  onApply(memoryIds: string[]): Promise<void> | void;
  onCreate(name: string): Promise<void> | void;
  onRename(memoryId: string, name: string): Promise<void> | void;
  onAuto(enabled: boolean, targetMemoryIds: string[]): Promise<void> | void;
  onInternalize(targets: AgoraMemoryIntakeTarget[]): Promise<void> | void;
  onRollback(memory: AgoraMemory, targetPatchId: string): Promise<void> | void;
  onRetryBlocked(): Promise<void> | void;
  onAbandonBlocked(): Promise<void> | void;
  onCancel(): void;
}

type Mode = 'main' | 'intake' | 'history';
type EditMode = 'create' | 'rename' | 'new-target' | 'output-name' | null;
const FLOW_COLORS = ['cyan', 'blue', 'magenta', 'blue'] as const;

function nextOutputName(memory: AgoraMemory, patches: AgoraMemoryPatch[]): string {
  const versions = patches.filter((patch) => patch.memory_id === memory.id);
  return `${memory.name}@v${versions.length + 1}`;
}

export function MemoryConsole(props: MemoryConsoleProps) {
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<Mode>('main');
  const [historyMemoryId, setHistoryMemoryId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [autoTargets, setAutoTargets] = useState<string[]>([]);
  const [intakeTargets, setIntakeTargets] = useState<string[]>([]);
  const [newTargets, setNewTargets] = useState<Array<{ name: string; output_name: string }>>([]);
  const [outputNames, setOutputNames] = useState<Record<string, string>>({});
  const [intakeConfirm, setIntakeConfirm] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>(null);
  const [editValue, setEditValue] = useState('');
  const [error, setError] = useState('');
  const [flowIndex, setFlowIndex] = useState(0);

  const memory = mode === 'history'
    ? props.memories.find((item) => item.id === historyMemoryId)
    : props.memories[index];
  const history = useMemo(
    () => props.patches.filter((patch) => patch.memory_id === memory?.id),
    [memory?.id, props.patches]
  );
  const mountedIds = useMemo(() => new Set(
    props.profile?.active_memory_patch_ids
      .map((patchId) => props.patches.find((patch) => patch.id === patchId)?.memory_id)
      .filter((id): id is string => Boolean(id)) ?? []
  ), [props.patches, props.profile?.active_memory_patch_ids]);
  const verifiedIds = useMemo(() => new Set(props.verifiedPatchIds ?? []), [props.verifiedPatchIds]);
  const canAnimate = !props.busy && !process.env.NO_COLOR && !process.env.MA_REDUCED_MOTION && process.env.TERM !== 'dumb';

  useEffect(() => {
    setSelected([...mountedIds]);
    setAutoTargets(props.profile?.auto_intake_target_memory_ids ?? []);
  }, [mountedIds, props.profile?.auto_intake_target_memory_ids]);

  useEffect(() => {
    if (!canAnimate) return;
    const timer = setInterval(() => setFlowIndex((value) => (value + 1) % FLOW_COLORS.length), 500);
    return () => clearInterval(timer);
  }, [canAnimate]);

  const run = async (action: () => Promise<void> | void) => {
    setError('');
    try {
      await action();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  useInput((input, key) => {
    if (editMode) return;
    if (key.escape) {
      if (mode !== 'main') {
        setMode('main');
        setHistoryMemoryId(null);
        setIndex(0);
      } else props.onCancel();
      return;
    }
    const rowCount = mode === 'history' ? history.length : props.memories.length;
    if (key.upArrow) return setIndex((value) => Math.max(0, value - 1));
    if (key.downArrow) return setIndex((value) => Math.min(Math.max(0, rowCount - 1), value + 1));

    if (mode === 'history') {
      if (input === 'r' && memory && history[index]) {
        void run(() => props.onRollback(memory, history[index].id));
      }
      return;
    }

    if (input === ' ' && memory) {
      setIntakeConfirm(false);
      const setter = mode === 'intake' ? setIntakeTargets : setSelected;
      setter((value) => value.includes(memory.id)
        ? value.filter((id) => id !== memory.id)
        : [...value, memory.id]);
      return;
    }
    if (mode === 'main' && input === 'n') {
      setEditValue('');
      setEditMode('create');
      return;
    }
    if (mode === 'main' && input === 'e' && memory) {
      setEditValue(memory.name);
      setEditMode('rename');
      return;
    }
    if (mode === 'main' && input === 'a' && memory) {
      setAutoTargets((value) => value.includes(memory.id)
        ? value.filter((id) => id !== memory.id)
        : [...value, memory.id]);
      return;
    }
    if (mode === 'main' && input === 't' && props.profile) {
      void run(() => props.onAuto(!props.profile?.auto_intake_policy?.enabled, autoTargets));
      return;
    }
    if (mode === 'main' && input === 'i') {
      setIntakeTargets([]);
      setNewTargets([]);
      setIntakeConfirm(false);
      setMode('intake');
      setIndex(0);
      return;
    }
    if (mode === 'main' && input === 'h' && memory) {
      setHistoryMemoryId(memory.id);
      setMode('history');
      setIndex(0);
      return;
    }
    if (mode === 'main' && input === 'R' && props.activeBatch) {
      void run(() => props.onRetryBlocked());
      return;
    }
    if (mode === 'main' && input === 'D' && props.activeBatch) {
      void run(() => props.onAbandonBlocked());
      return;
    }
    if (mode === 'intake' && input === 'n') {
      setEditValue('');
      setEditMode('new-target');
      return;
    }
    if (mode === 'intake' && input === 'v' && memory && intakeTargets.includes(memory.id)) {
      setEditValue(outputNames[memory.id] ?? nextOutputName(memory, props.patches));
      setEditMode('output-name');
      return;
    }
    if (key.return) {
      if (mode === 'main') {
        void run(() => props.onApply(selected));
        return;
      }
      if (!intakeConfirm) {
        setIntakeConfirm(true);
        return;
      }
      const targets: AgoraMemoryIntakeTarget[] = [
        ...intakeTargets.flatMap((memoryId) => {
          const targetMemory = props.memories.find((item) => item.id === memoryId);
          if (!targetMemory) return [];
          return [{
            mode: 'increment' as const,
            memory_id: memoryId,
            expected_parent_patch_id: targetMemory.head_patch_id ?? null,
            output_name: outputNames[memoryId] ?? nextOutputName(targetMemory, props.patches),
          }];
        }),
        ...newTargets.map((target) => ({ mode: 'create' as const, ...target })),
      ];
      if (targets.length === 0) {
        setError('请至少选择一个已有 Memory，或按 n 新建目标。');
        return;
      }
      void run(async () => {
        await props.onInternalize(targets);
        setMode('main');
        props.onCancel();
      });
    }
  });

  const submitEdit = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    const succeeded = await run(async () => {
      if (editMode === 'create') await props.onCreate(value);
      if (editMode === 'rename' && memory) await props.onRename(memory.id, value);
      if (editMode === 'output-name' && memory) {
        setIntakeConfirm(false);
        setOutputNames((current) => ({ ...current, [memory.id]: value }));
      }
      if (editMode === 'new-target') {
        setIntakeConfirm(false);
        const [name, output] = value.split('|').map((part) => part.trim());
        if (!name) throw new Error('请输入 Memory 名称。');
        setNewTargets((current) => [...current, { name, output_name: output || `${name}@v1` }]);
      }
    });
    if (succeeded) {
      setEditMode(null);
      setEditValue('');
    }
  };

  const flowColor = canAnimate ? FLOW_COLORS[flowIndex] : 'cyan';
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>Memory · {props.project}</Text>
      {mode === 'history' ? (
        <>
          <Text bold>{memory?.name ?? 'Memory'} · 版本历史</Text>
          {history.length === 0 ? <Text dimColor>  暂无版本</Text> : history.map((patch, row) => (
            <Text key={patch.id} color={row === index ? 'cyan' : undefined}>
              {row === index ? '› ' : '  '}{patch.name} · {patch.version}
              {patch.id === memory?.head_patch_id ? ' · current head' : ''}
              {verifiedIds.has(patch.id) ? ' · mounted' : ''}
            </Text>
          ))}
          <Text dimColor>r CAS 回滚当前版本 · Esc 返回</Text>
        </>
      ) : (
        <>
          <Text bold>{mode === 'intake' ? '内化目标（同一份对话增量）' : '具名记忆'}</Text>
          {mode === 'intake' && props.sourceRange ? (
            <Text color={intakeConfirm ? 'yellow' : undefined}>
              Source: 本会话消息 {props.sourceRange.start}～{props.sourceRange.end}
              {intakeConfirm ? ` · 确认一次提交 ${intakeTargets.length + newTargets.length} 个目标，再按 Enter` : ''}
            </Text>
          ) : null}
          {props.memories.length === 0 ? <Text dimColor>  没有 Memory，按 n 新建</Text> : null}
          {props.memories.map((item, row) => {
            const patch = props.patches.find((candidate) => candidate.id === item.head_patch_id);
            const checked = mode === 'intake' ? intakeTargets.includes(item.id) : selected.includes(item.id);
            const mounted = Boolean(item.head_patch_id && verifiedIds.has(item.head_patch_id));
            return (
              <Text key={item.id} color={mounted ? flowColor : row === index ? 'cyan' : undefined} bold={mounted}>
                {row === index ? '› ' : '  '}{checked ? '☑' : '☐'} {item.name}
                {patch ? ` · ${patch.version}` : ' · 尚无版本'}
                {mounted ? ' · verified' : mountedIds.has(item.id) ? ` · ${props.verificationStatus ?? 'pending'}` : ''}
                {mode === 'main' && autoTargets.includes(item.id) ? ' · auto' : ''}
                {mode === 'intake' && outputNames[item.id] ? ` → ${outputNames[item.id]}` : ''}
              </Text>
            );
          })}
          {mode === 'intake' && newTargets.map((target) => (
            <Text key={`${target.name}:${target.output_name}`} color="green">  ＋ {target.name} → {target.output_name}</Text>
          ))}
          {mode === 'main' && props.activeBatch ? (
            <Text color="yellow">
              待处理 batch: {Array.isArray(props.activeBatch.targets)
                ? props.activeBatch.targets.filter((target: any) => ['review', 'conflict', 'failed'].includes(String(target?.status))).length
                : 0} 个目标 · Shift+R 仅重试未完成目标 · Shift+D 放弃并推进 checkpoint
            </Text>
          ) : null}
          {mode === 'intake' ? (
            <Text dimColor>Space 多选增量目标 · n 新建目标（名称 | 版本名）· v 修改版本名 · Enter 预览/确认 · Esc 返回</Text>
          ) : (
            <Text dimColor>Space 挂载 · Enter 应用 · i 内化 · n 新建 · e 重命名 · h 历史 · a 自动目标 · t 自动开关 · Shift+R 重试 · Shift+D 放弃 · Esc 返回</Text>
          )}
        </>
      )}
      {editMode ? (
        <Box>
          <Text>{editMode === 'new-target' ? 'Memory 名称 | 输出版本名: ' : editMode === 'output-name' ? '输出版本名: ' : editMode === 'create' ? '新建 Memory: ' : '重命名: '}</Text>
          <TextInput value={editValue} onChange={setEditValue} onSubmit={(value) => { void submitEdit(value); }} />
        </Box>
      ) : null}
      {error ? <Text color="red">{error} · 请修改后重试</Text> : null}
      {props.activity ? <Text color="yellow">Activity: {props.activity}</Text> : null}
    </Box>
  );
}

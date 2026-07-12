import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { AgoraMemoryPatch, AgoraMemoryProfile } from '../../provider/agora.js';

export interface MemoryConsoleProps {
  project: string;
  profiles: AgoraMemoryProfile[];
  patches: AgoraMemoryPatch[];
  activeProfileId?: string;
  activity?: string;
  onUse(profileId: string): void;
  onApply(profileId: string, patchIds: string[], writableFamily: string | null): void;
  onCreate(name: string): void;
  onRename(profileId: string, name: string): void;
  onAuto(profileId: string, enabled: boolean): void;
  onInternalize(profileId: string): void;
  onCancel(): void;
}

export function MemoryConsole(props: MemoryConsoleProps) {
  const initial = Math.max(0, props.profiles.findIndex((profile) => profile.id === props.activeProfileId));
  const [profileIndex, setProfileIndex] = useState(initial);
  const [patchIndex, setPatchIndex] = useState(0);
  const [focus, setFocus] = useState<'profiles' | 'patches'>('profiles');
  const [selected, setSelected] = useState<string[]>([]);
  const [writableFamily, setWritableFamily] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<'create' | 'rename' | null>(null);
  const [editValue, setEditValue] = useState('');
  const profile = props.profiles[profileIndex];
  const compatiblePatches = useMemo(
    () => props.patches.filter((patch) => !profile || patch.base_model_id === profile.base_model_id),
    [profile, props.patches]
  );

  useEffect(() => {
    setSelected(profile?.active_memory_patch_ids ?? []);
    setWritableFamily(profile?.writable_patch_family ?? null);
  }, [profile?.id]);

  useInput((input, key) => {
    if (editMode) return;
    if (key.escape) return props.onCancel();
    if (key.tab) return setFocus((value) => value === 'profiles' ? 'patches' : 'profiles');
    if (key.upArrow) {
      if (focus === 'profiles') setProfileIndex((value) => Math.max(0, value - 1));
      else setPatchIndex((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow) {
      if (focus === 'profiles') setProfileIndex((value) => Math.min(props.profiles.length - 1, value + 1));
      else setPatchIndex((value) => Math.min(compatiblePatches.length - 1, value + 1));
      return;
    }
    if (input === 'n') {
      setEditValue('');
      setEditMode('create');
      return;
    }
    if (input === 'e' && profile) {
      setEditValue(profile.name);
      setEditMode('rename');
      return;
    }
    if (input === 'a' && profile) {
      props.onAuto(profile.id, !profile.auto_intake_policy?.enabled);
      return;
    }
    if (input === 'i' && profile) {
      props.onInternalize(profile.id);
      return;
    }
    const patch = compatiblePatches[patchIndex];
    if (focus === 'patches' && input === ' ' && patch?.mountable) {
      setSelected((value) => value.includes(patch.id)
        ? value.filter((id) => id !== patch.id)
        : [...value, patch.id]);
      return;
    }
    if (focus === 'patches' && input === 'w' && patch?.mountable) {
      setWritableFamily((value) => value === patch.family ? null : patch.family);
      if (!selected.includes(patch.id)) setSelected((value) => [...value, patch.id]);
      return;
    }
    if (key.return && profile) {
      if (focus === 'profiles') props.onUse(profile.id);
      else props.onApply(profile.id, selected, writableFamily);
    }
  });

  const submitEdit = (value: string) => {
    const name = value.trim();
    if (name) {
      if (editMode === 'create') props.onCreate(name);
      if (editMode === 'rename' && profile) props.onRename(profile.id, name);
    }
    setEditMode(null);
    setEditValue('');
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>Memory Console · 项目: {props.project}</Text>
      <Text bold>Profiles {focus === 'profiles' ? '‹' : ''}</Text>
      {props.profiles.length === 0 ? <Text dimColor>  没有 Profile，按 n 新建</Text> : null}
      {props.profiles.map((item, index) => (
        <Text key={item.id} color={focus === 'profiles' && index === profileIndex ? 'cyan' : undefined}>
          {focus === 'profiles' && index === profileIndex ? '› ' : '  '}
          {item.name} · {item.active_memory_patch_ids.length} patches · auto {item.auto_intake_policy?.enabled ? 'on' : 'off'}
          {item.id === props.activeProfileId ? ' · verified' : ''}
        </Text>
      ))}
      <Text bold>Patches {focus === 'patches' ? '‹' : ''}</Text>
      {compatiblePatches.length === 0 ? <Text dimColor>  没有兼容 Patch</Text> : null}
      {compatiblePatches.map((patch, index) => {
        const checked = selected.includes(patch.id);
        const writable = writableFamily === patch.family;
        return (
          <Text key={patch.id} color={focus === 'patches' && index === patchIndex ? 'cyan' : undefined} dimColor={!patch.mountable}>
            {focus === 'patches' && index === patchIndex ? '› ' : '  '}
            {checked ? '☑' : '☐'} {patch.name} · {patch.version} · {writable ? '主记忆/可写' : 'overlay'} · {patch.status}
          </Text>
        );
      })}
      {editMode ? (
        <Box><Text>{editMode === 'create' ? '新建名称: ' : '重命名: '}</Text><TextInput value={editValue} onChange={setEditValue} onSubmit={submitEdit} /></Box>
      ) : null}
      {props.activity ? <Text color="yellow">Activity: {props.activity}</Text> : null}
      <Text dimColor>Tab 切区 · Space 挂载 · w 设主记忆 · Enter 应用 · n 新建 · e 重命名 · a 自动 · i 内化 · Esc 返回</Text>
    </Box>
  );
}

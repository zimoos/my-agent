import React from 'react';
import { Box, Text } from 'ink';
import type { ProviderSessionState } from '../../mcp/types.js';

interface StatusBarProps {
  model: string;
  provider?: string;
  providerState?: ProviderSessionState | null;
  taskCount?: number;
  debug?: boolean;
  contextUsed?: number;
  contextTotal?: number;
  contextThreshold?: number;
  contextSource?: string;
  memoryActivity?: string;
}

export function StatusBar({
  model,
  provider,
  providerState,
  taskCount,
  debug,
  contextUsed,
  contextTotal,
  contextThreshold,
  contextSource,
  memoryActivity,
}: StatusBarProps) {
  const isAgora = provider?.toLowerCase() === 'agora';
  let ctxLabel = '';
  let ctxColor: 'red' | 'yellow' | undefined;
  if (contextUsed != null && contextTotal && contextTotal > 0) {
    const threshold = contextThreshold && contextThreshold > 0
      ? contextThreshold
      : contextTotal;
    const pct = Math.round((contextUsed / threshold) * 100);
    ctxColor = pct > 100 ? 'red' : pct > 80 ? 'yellow' : undefined;
    const source = contextSource ? ` ${contextSource}` : '';
    ctxLabel = ` · ctx: ${formatK(contextUsed)}/${formatK(threshold)} trigger · win ${formatK(contextTotal)}${source}`;
    if (ctxColor) ctxLabel = ` · ${pct > 100 ? 'context risk' : 'context warning'}${ctxLabel}`;
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {'  '}Provider: {provider || 'openai'} · Model: {shortText(model)}
        {ctxColor ? <Text color={ctxColor}>{ctxLabel}</Text> : ctxLabel}
        {taskCount ? ` · tasks: ${taskCount}` : ''}
        {debug ? ' · 🔧 debug' : ''}
      </Text>
      {isAgora ? <Text dimColor>{formatAgoraMemoryLine(providerState, memoryActivity)}</Text> : null}
      <Text dimColor>{'  '}Ctrl+V 图片 · ESC 中断 · 双击 ESC 切会话 · /memory 记忆 · /quit 退出</Text>
    </Box>
  );
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}m`;
  return `${Math.round(n / 1000)}k`;
}

function shortText(value: string | undefined, max = 24): string {
  const text = value?.trim() || '-';
  if (text.length <= max) return text;
  if (text.includes('/')) return text.split('/').slice(-1)[0].slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

function formatAgoraMemoryLine(state?: ProviderSessionState | null, activity?: string): string {
  const memory = state?.memory;
  const status = typeof memory?.status === 'string' && memory.status
    ? memory.status
    : 'unknown';
  const patches = Array.isArray(memory?.active_memory_patch_ids)
    ? memory.active_memory_patch_ids.length
    : 0;
  const profile = typeof memory?.profile_name === 'string'
    ? memory.profile_name
    : typeof memory?.profile_id === 'string' ? memory.profile_id : '未选择 Profile';
  return `  Memory: ${shortText(profile, 32)} · ${patches} patches · ${status}${activity ? ` · ${activity}` : ''}`;
}

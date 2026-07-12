import React, { useEffect, useState } from 'react';
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
  animateMemory?: boolean;
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
  animateMemory = true,
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
  const [memoryColorIndex, setMemoryColorIndex] = useState(0);
  const memoryColors = ['cyan', 'blue', 'magenta', 'blue'] as const;
  const canAnimateMemory = animateMemory && !process.env.NO_COLOR && !process.env.MA_REDUCED_MOTION && process.env.TERM !== 'dumb';
  useEffect(() => {
    if (!canAnimateMemory) return;
    const timer = setInterval(() => setMemoryColorIndex((value) => (value + 1) % memoryColors.length), 500);
    return () => clearInterval(timer);
  }, [canAnimateMemory]);

  const memory = providerState?.memory;
  const mounted = Array.isArray(memory?.mounted_memories) ? memory.mounted_memories : [];
  const memoryStatus = typeof memory?.status === 'string' ? memory.status : 'unknown';
  const firstMounted = mounted[0];
  const memoryLabel = firstMounted
    ? `${firstMounted.memory_name}@${firstMounted.version}${mounted.length > 1 ? ` +${mounted.length - 1}` : ''}`
    : (memory?.active_memory_patch_ids?.length ?? 0) > 0
      ? `${memory?.active_memory_patch_ids?.length} 个记忆`
      : '未挂载';
  const autoNames = mounted
    .filter((item) => memory?.auto_target_memory_ids?.includes(item.memory_id))
    .map((item) => item.memory_name);

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {'  '}Provider: {provider || 'openai'} · Model: {shortText(model)}
        {ctxColor ? <Text color={ctxColor}>{ctxLabel}</Text> : ctxLabel}
        {taskCount ? ` · tasks: ${taskCount}` : ''}
        {debug ? ' · 🔧 debug' : ''}
      </Text>
      {isAgora ? (
        <Text dimColor>
          {'  '}Memory: <Text color={memoryStatus === 'mounted' ? memoryColors[memoryColorIndex] : undefined} bold={memoryStatus === 'mounted'}>{shortText(memoryLabel, 42)}</Text>
          {` · ${memoryStatus}`}
          {autoNames.length > 0 ? ` · auto: ${autoNames.join(', ')}` : ''}
          {providerState?.runtime_trust === 'unverified' ? ' · unverified runtime' : ''}
          {memoryActivity ? ` · ${memoryActivity}` : ''}
        </Text>
      ) : null}
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

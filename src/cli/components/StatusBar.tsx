import React from 'react';
import { Text } from 'ink';
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
}: StatusBarProps) {
  const agoraLabel = provider?.toLowerCase() === 'agora'
    ? formatAgoraStatus(model, providerState)
    : '';
  let ctxLabel = '';
  if (contextUsed != null && contextTotal && contextTotal > 0) {
    const threshold = contextThreshold && contextThreshold > 0
      ? contextThreshold
      : contextTotal;
    const pct = Math.round((contextUsed / threshold) * 100);
    const color = pct > 100 ? 'red' : pct > 80 ? 'yellow' : undefined;
    const source = contextSource ? ` ${contextSource}` : '';
    ctxLabel = ` · ctx: ${formatK(contextUsed)}/${formatK(threshold)} trigger · win ${formatK(contextTotal)}${source}`;
    if (color) {
      return (
        <Text dimColor>
          {'  '}Ctrl+V 图片 · ESC 中断 · 双击 ESC 切会话 · /quit 退出
          {taskCount ? ` · tasks: ${taskCount}` : ''}
          {agoraLabel}
          <Text color={color}>{ctxLabel}</Text>
          {debug ? ' · 🔧 debug' : ''}
        </Text>
      );
    }
  }

  return (
    <Text dimColor>
      {'  '}Ctrl+V 图片 · ESC 中断 · 双击 ESC 切会话 · /quit 退出
      {taskCount ? ` · tasks: ${taskCount}` : ''}
      {agoraLabel}
      {ctxLabel}
      {debug ? ' · 🔧 debug' : ''}
    </Text>
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

function shortId(value: string | undefined): string {
  const text = value?.trim();
  if (!text) return '-';
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}…${text.slice(-3)}`;
}

function formatAgoraStatus(model: string, state?: ProviderSessionState | null): string {
  const memory = state?.memory;
  const status = typeof memory?.status === 'string' && memory.status
    ? memory.status
    : 'unknown';
  const patches = Array.isArray(memory?.active_memory_patch_ids)
    ? memory.active_memory_patch_ids.length
    : 0;
  const patchLabel = patches > 0 ? `(${patches})` : '';
  return ` · agora:${shortText(model)} · mem ${status}${patchLabel} · sess ${shortId(state?.agora_session_id)}`;
}

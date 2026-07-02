import React from 'react';
import { Text } from 'ink';

interface StatusBarProps {
  model: string;
  taskCount?: number;
  debug?: boolean;
  contextUsed?: number;
  contextTotal?: number;
  contextThreshold?: number;
  contextSource?: string;
}

export function StatusBar({
  model,
  taskCount,
  debug,
  contextUsed,
  contextTotal,
  contextThreshold,
  contextSource,
}: StatusBarProps) {
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
      {ctxLabel}
      {debug ? ' · 🔧 debug' : ''}
    </Text>
  );
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}m`;
  return `${Math.round(n / 1000)}k`;
}

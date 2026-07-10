import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SessionMeta } from '../../session/store.js';

export interface SessionPickerSession extends SessionMeta {
  preview: string;
}

export interface SessionPickerProps {
  sessions: SessionPickerSession[];
  currentSessionId: string;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

export function selectProjectSessions(
  sessions: SessionMeta[],
  currentSessionId: string,
  currentCwd: string,
  limit = 8
): SessionMeta[] {
  return sessions
    .filter((session) => {
      if (session.id === currentSessionId) return true;
      return session.cwd === currentCwd && session.messageCount > 0;
    })
    .slice(0, limit);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part) {
        return typeof part.text === 'string' ? part.text : '';
      }
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

function isRealUserMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('（子任务）')) return false;
  if (trimmed.startsWith('Please provide your answer based on the tool results above.')) return false;
  if (trimmed.startsWith('[MA internal continuation request]')) return false;
  return true;
}

function truncate(text: string, max = 58): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function getSessionUserPreview(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    const text = extractText(msg.content);
    if (isRealUserMessage(text)) return truncate(text);
  }
  return '(没有用户消息)';
}

export function formatSessionLabel(session: SessionPickerSession, now = Date.now(), _currentCwd?: string): string {
  const ageMs = Math.max(0, now - session.createdAt);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let age: string;
  if (ageMs < minute) {
    age = '刚刚';
  } else if (ageMs < hour) {
    age = `${Math.floor(ageMs / minute)}分钟前`;
  } else if (ageMs < day) {
    age = `${Math.floor(ageMs / hour)}小时前`;
  } else {
    age = `${Math.floor(ageMs / day)}天前`;
  }

  return `${session.preview || '(没有用户消息)'}  ·  ${age}`;
}

export function SessionPicker({ sessions, currentSessionId, onSelect, onCancel }: SessionPickerProps) {
  const [selected, setSelected] = useState(0);
  const renderedAt = useMemo(() => Date.now(), []);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setSelected((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((prev) => Math.min(sessions.length - 1, prev + 1));
      return;
    }
    if (key.return && sessions[selected]) {
      onSelect(sessions[selected].id);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>选择会话</Text>
      {sessions.map((session, index) => {
        const active = index === selected;
        const current = session.id === currentSessionId;
        return (
          <Text key={session.id} color={active ? 'cyan' : undefined} dimColor={!active && current}>
            {active ? '› ' : '  '}
            {formatSessionLabel(session, renderedAt)}
            {current ? '  当前' : ''}
          </Text>
        );
      })}
      <Text dimColor>↑/↓ 选择 · Enter 切换 · Esc 取消</Text>
    </Box>
  );
}

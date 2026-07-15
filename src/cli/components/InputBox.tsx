import React, { useState, useCallback, useEffect } from 'react';
import * as path from 'node:path';
import { Box, Text } from 'ink';
import { CustomTextInput } from './CustomTextInput.js';
import type { UiImage } from '../state/types.js';
import { getSuggestedCommands, type Command } from '../utils/commands.js';

interface InputBoxProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  pendingImages?: UiImage[];
  onClearPendingImages?: () => void;
  onOpenSessionPicker?: () => void;
  initialValue?: string;
  onValueChange?: (value: string) => void;
}

const PASTE_JUNK = /\[200~|\[201~|\x1b\[200~|\x1b\[201~/g;
const ESC_CONFIRM_MS = 650;
const MAX_COMMAND_SUGGESTIONS = 8;

interface CommandSuggestion {
  name: string;
  description: string;
}

export function InputBox({ onSubmit, disabled, pendingImages, onClearPendingImages, onOpenSessionPicker, initialValue = '', onValueChange }: InputBoxProps) {
  const [value, setValue] = useState(initialValue);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState('');
  const [escapeArmedAt, setEscapeArmedAt] = useState(0);
  const [hint, setHint] = useState('');
  const [commands, setCommands] = useState<CommandSuggestion[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);

  useEffect(() => {
    let alive = true;
    getSuggestedCommands()
      .then((all) => {
        if (!alive) return;
        const items = Array.from(all.entries())
          .map(([name, command]: [string, Command]) => ({
            name,
            description: command.description,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setCommands(items);
      })
      .catch(() => {
        if (alive) setCommands([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const commandQuery = value.startsWith('/') && !value.includes(' ')
    ? value
    : '';
  const commandSuggestions = commandQuery
    ? commands
        .filter((command) => command.name.startsWith(commandQuery))
        .slice(0, MAX_COMMAND_SUGGESTIONS)
    : [];
  const showCommandSuggestions = commandQuery.length > 0 && commandSuggestions.length > 0;

  const clearEscapeState = useCallback(() => {
    setEscapeArmedAt(0);
    setHint('');
  }, []);

  useEffect(() => {
    if (!hint) return;
    const timeout = escapeArmedAt > 0 ? ESC_CONFIRM_MS : 1600;
    const timer = setTimeout(() => {
      setEscapeArmedAt(0);
      setHint('');
    }, timeout);
    return () => clearTimeout(timer);
  }, [escapeArmedAt, hint]);

  const handleChange = useCallback((newVal: string) => {
    const clean = newVal.replace(PASTE_JUNK, '');
    setValue(clean);
    onValueChange?.(clean);
    setCommandIndex(0);
    clearEscapeState();
  }, [clearEscapeState, onValueChange]);

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.replace(PASTE_JUNK, '').trim();
      if (!trimmed && (!pendingImages || pendingImages.length === 0)) return;
      if (trimmed) {
        setHistory((prev) => [...prev, trimmed]);
      }
      setHistoryIndex(-1);
      setSavedInput('');
      setValue('');
      onValueChange?.('');
      clearEscapeState();
      onSubmit(trimmed);
    },
    [onSubmit, pendingImages, clearEscapeState, onValueChange]
  );

  const handleHistoryUp = useCallback(() => {
    if (showCommandSuggestions) return;
    if (history.length === 0) return;
    if (historyIndex === -1) {
      setSavedInput(value);
    }
    const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
    setHistoryIndex(newIndex);
    handleChange(history[newIndex]);
    clearEscapeState();
  }, [history, historyIndex, value, handleChange, clearEscapeState, showCommandSuggestions]);

  const handleHistoryDown = useCallback(() => {
    if (showCommandSuggestions) return;
    if (historyIndex === -1) return;
    if (historyIndex >= history.length - 1) {
      setHistoryIndex(-1);
      handleChange(savedInput);
    } else {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      handleChange(history[newIndex]);
    }
    clearEscapeState();
  }, [history, historyIndex, savedInput, handleChange, clearEscapeState, showCommandSuggestions]);

  const handleCommandUp = useCallback(() => {
    if (!showCommandSuggestions) return false;
    setCommandIndex((prev) => (prev <= 0 ? commandSuggestions.length - 1 : prev - 1));
    clearEscapeState();
    return true;
  }, [clearEscapeState, commandSuggestions.length, showCommandSuggestions]);

  const handleCommandDown = useCallback(() => {
    if (!showCommandSuggestions) return false;
    setCommandIndex((prev) => (prev >= commandSuggestions.length - 1 ? 0 : prev + 1));
    clearEscapeState();
    return true;
  }, [clearEscapeState, commandSuggestions.length, showCommandSuggestions]);

  const handleCommandTab = useCallback(() => {
    if (!showCommandSuggestions) return;
    const selected = commandSuggestions[Math.min(commandIndex, commandSuggestions.length - 1)];
    if (!selected) return;
    setCommandIndex(0);
    clearEscapeState();
    return `${selected.name} `;
  }, [clearEscapeState, commandIndex, commandSuggestions, showCommandSuggestions]);

  const handleCommandReturn = useCallback(() => {
    if (!showCommandSuggestions) return false;
    const selected = commandSuggestions[Math.min(commandIndex, commandSuggestions.length - 1)];
    if (!selected) return false;
    handleSubmit(selected.name);
    return true;
  }, [commandIndex, commandSuggestions, handleSubmit, showCommandSuggestions]);

  const handleEscape = useCallback(() => {
    const now = Date.now();
    const hasInput = value.length > 0;
    const hasImages = Boolean(pendingImages && pendingImages.length > 0);
    const armed = escapeArmedAt > 0 && now - escapeArmedAt <= ESC_CONFIRM_MS;

    if (!armed) {
      setEscapeArmedAt(now);
      setHint('再按 ESC 选择会话');
      return;
    }

    setEscapeArmedAt(0);
    if (hasInput || hasImages) {
      setValue('');
      setHistoryIndex(-1);
      setSavedInput('');
      onClearPendingImages?.();
    }

    setHint('');
    onOpenSessionPicker?.();
  }, [escapeArmedAt, onClearPendingImages, onOpenSessionPicker, pendingImages, value]);

  return (
    <Box flexDirection="column">
      {pendingImages && pendingImages.length > 0 ? (
        <Box paddingX={1} marginBottom={0}>
          {pendingImages.map((img, i) => (
            <Text key={i} color="yellow">
              📎 {path.basename(img.path)} ({Math.round(img.size / 1024)}KB){' '}
            </Text>
          ))}
          <Text dimColor>(Ctrl+X 清除)</Text>
        </Box>
      ) : null}
      <Box borderStyle="single" borderColor="magenta" paddingX={1}>
        <Text color="magenta">❯ </Text>
        <CustomTextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder={disabled ? 'thinking...' : '输入消息或 /help 查看命令'}
          disabled={disabled}
          onHistoryUp={handleHistoryUp}
          onHistoryDown={handleHistoryDown}
          onUpArrow={handleCommandUp}
          onDownArrow={handleCommandDown}
          onTab={handleCommandTab}
          onReturn={handleCommandReturn}
          onEscape={handleEscape}
        />
      </Box>
      {showCommandSuggestions ? (
        <Box flexDirection="column" paddingX={1}>
          {commandSuggestions.map((command, index) => (
            <Text key={command.name} color={index === commandIndex ? 'cyan' : undefined} dimColor={index !== commandIndex}>
              {index === commandIndex ? '› ' : '  '}
              {command.name}
              <Text dimColor>  {command.description}</Text>
            </Text>
          ))}
          <Text dimColor>↑/↓ 选择 · Tab 补全</Text>
        </Box>
      ) : null}
      {hint ? (
        <Box paddingX={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

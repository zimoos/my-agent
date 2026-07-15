import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ModelChoice } from '../utils/modelProfiles.js';

export interface ModelPickerProps {
  models: ModelChoice[];
  onSelect: (model: ModelChoice) => void;
  onCancel: () => void;
}

export function ModelPicker({ models, onSelect, onCancel }: ModelPickerProps) {
  const initial = Math.max(0, models.findIndex((m) => m.current));
  const [selected, setSelected] = useState(initial);

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
      setSelected((prev) => Math.min(models.length - 1, prev + 1));
      return;
    }
    if (key.return && models[selected]) {
      onSelect(models[selected]);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>选择模型</Text>
      {models.map((model, index) => {
        const active = index === selected;
        const suffix = [
          model.current ? '当前' : '',
          model.source === 'cache' ? 'cache' : '',
          model.status && model.status !== 'available' ? model.status : '',
        ].filter(Boolean).join(' · ');
        return (
          <Text key={model.id} color={active ? 'magenta' : undefined} dimColor={!active && model.current}>
            {active ? '› ' : '  '}
            {model.label}
            {suffix ? `  ${suffix}` : ''}
          </Text>
        );
      })}
      <Text dimColor>↑/↓ 选择 · Enter 下载/切换 · Esc 取消</Text>
    </Box>
  );
}

import type { ModelConfig } from '../mcp/types.js';

export const DEFAULT_CONTEXT_WINDOW = 32_768;

export type ContextWindowSource = 'config' | 'lmstudio' | 'registry' | 'default';

export interface CapabilityHints {
  lmStudioContextWindow?: number;
}

export interface ModelCapabilities {
  contextWindow: number;
  contextWindowSource: ContextWindowSource;
}

const DEEPSEEK_CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
};

export function resolveModelCapabilities(
  model: ModelConfig,
  hints: CapabilityHints = {}
): ModelCapabilities {
  const explicit = positiveInteger(model.contextWindow);
  if (explicit) {
    return { contextWindow: explicit, contextWindowSource: 'config' };
  }

  const lmStudio = positiveInteger(hints.lmStudioContextWindow);
  if (lmStudio) {
    return { contextWindow: lmStudio, contextWindowSource: 'lmstudio' };
  }

  const registry = registryContextWindow(model);
  if (registry) {
    return { contextWindow: registry, contextWindowSource: 'registry' };
  }

  return { contextWindow: DEFAULT_CONTEXT_WINDOW, contextWindowSource: 'default' };
}

function registryContextWindow(model: ModelConfig): number | undefined {
  const provider = (model.provider ?? '').toLowerCase();
  const baseURL = model.baseURL.toLowerCase();
  const modelId = model.model.toLowerCase();
  const isDeepSeek =
    provider === 'deepseek' ||
    baseURL.includes('api.deepseek.com') ||
    modelId.startsWith('deepseek-');
  if (!isDeepSeek) return undefined;
  return DEEPSEEK_CONTEXT_WINDOWS[modelId];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

import type { ModelConfig } from '../mcp/types.js';

export const DEFAULT_CONTEXT_WINDOW = 32_768;
export const DEEPSEEK_REQUEST_BODY_BYTE_LIMIT = 240 * 1024;
export const DEFAULT_REQUEST_BODY_BYTE_LIMIT = 16 * 1024 * 1024;

export type ContextWindowSource = 'config' | 'lmstudio' | 'registry' | 'default';
export type RequestBodyByteLimitSource =
  | 'config'
  | 'deepseek'
  | 'agora'
  | 'lmstudio'
  | 'openai'
  | 'default';

export interface CapabilityHints {
  lmStudioContextWindow?: number;
}

export interface ModelCapabilities {
  contextWindow: number;
  contextWindowSource: ContextWindowSource;
  requestBodyByteLimit: number;
  requestBodyByteLimitSource: RequestBodyByteLimitSource;
}

const DEEPSEEK_CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
};

const AGORA_CONTEXT_WINDOWS: Record<string, number> = {
  'qwen3.6-35b-a3b-q4': 262_144,
};

export function resolveModelCapabilities(
  model: ModelConfig,
  hints: CapabilityHints = {}
): ModelCapabilities {
  let contextWindow: number;
  let contextWindowSource: ContextWindowSource;
  const explicit = positiveInteger(model.contextWindow);
  if (explicit) {
    contextWindow = explicit;
    contextWindowSource = model.contextWindowSource ?? 'config';
  } else {
    const lmStudio = positiveInteger(hints.lmStudioContextWindow);
    const registry = registryContextWindow(model);
    contextWindow = lmStudio ?? registry ?? DEFAULT_CONTEXT_WINDOW;
    contextWindowSource = lmStudio
      ? 'lmstudio'
      : registry
        ? 'registry'
        : 'default';
  }

  const requestBody = resolveRequestBodyByteLimit(model);
  return {
    contextWindow,
    contextWindowSource,
    requestBodyByteLimit: requestBody.limit,
    requestBodyByteLimitSource: requestBody.source,
  };
}

export function resolveRequestBodyByteLimit(model: ModelConfig): {
  limit: number;
  source: RequestBodyByteLimitSource;
} {
  if (model.requestBodyByteLimit !== undefined) {
    const explicit = positiveInteger(model.requestBodyByteLimit);
    if (!explicit) {
      throw new Error(
        `requestBodyByteLimit must be a positive integer, got ${String(model.requestBodyByteLimit)}`
      );
    }
    return {
      limit: explicit,
      source: model.requestBodyByteLimitSource ?? 'config',
    };
  }

  const provider = (model.provider ?? '').toLowerCase();
  const baseURL = model.baseURL.toLowerCase();
  const modelId = model.model.toLowerCase();
  if (
    provider === 'deepseek' ||
    baseURL.includes('api.deepseek.com')
  ) {
    return { limit: DEEPSEEK_REQUEST_BODY_BYTE_LIMIT, source: 'deepseek' };
  }
  if (
    provider === 'agora' ||
    baseURL.startsWith('mcp-stdio://agora') ||
    modelId.startsWith('agora/')
  ) {
    return { limit: DEFAULT_REQUEST_BODY_BYTE_LIMIT, source: 'agora' };
  }
  if (provider === 'lmstudio' || isLmStudioBaseURL(baseURL)) {
    return { limit: DEFAULT_REQUEST_BODY_BYTE_LIMIT, source: 'lmstudio' };
  }
  if (provider === 'openai' || baseURL.includes('api.openai.com')) {
    return { limit: DEFAULT_REQUEST_BODY_BYTE_LIMIT, source: 'openai' };
  }
  return { limit: DEFAULT_REQUEST_BODY_BYTE_LIMIT, source: 'default' };
}

function isLmStudioBaseURL(baseURL: string): boolean {
  try {
    return new URL(baseURL).port === '1234';
  } catch {
    return baseURL.includes(':1234');
  }
}

function registryContextWindow(model: ModelConfig): number | undefined {
  const provider = (model.provider ?? '').toLowerCase();
  const baseURL = model.baseURL.toLowerCase();
  const modelId = model.model.toLowerCase();
  const isDeepSeek =
    provider === 'deepseek' ||
    baseURL.includes('api.deepseek.com') ||
    modelId.startsWith('deepseek-');
  if (isDeepSeek) return DEEPSEEK_CONTEXT_WINDOWS[modelId];

  const isAgora =
    provider === 'agora' ||
    baseURL.startsWith('mcp-stdio://agora') ||
    modelId.startsWith('agora/');
  if (isAgora) return AGORA_CONTEXT_WINDOWS[modelId.replace(/^agora\//, '')];

  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentConfig, AgoraMemoryConfig, AgoraRuntimeConfig, ModelConfig } from './mcp/types.js';
import { readSecret } from './secrets/keychain.js';

export const AGORA_MCP_BASE_URL = 'mcp-stdio://agora';
export const AGORA_MCP_API_KEY = 'agora-mcp';

const DEFAULT_MODEL: ModelConfig = {
  baseURL: 'http://localhost:1234/v1',
  model: 'qwen3-30b-a3b',
  apiKey: 'lm-studio',
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  minP: 0,
  presencePenalty: 0,
  frequencyPenalty: 0,
  repeatPenalty: 1,

};

export function globalConfigDir(): string {
  return path.join(os.homedir(), '.my-agent');
}

export function globalConfigPath(): string {
  return path.join(globalConfigDir(), 'config.json');
}

export function projectConfigPath(): string {
  return path.resolve(process.cwd(), 'config.json');
}

function readJson(filePath: string): Partial<AgentConfig> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw) as Partial<AgentConfig>;
  } catch (err) {
    throw new Error(`Failed to parse config at ${filePath}: ${(err as Error).message}`);
  }
}

export function deepMerge<T extends Record<string, any>>(target: T, source: Record<string, any>): T {
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const existing = (target as any)[key];
      const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
      (target as any)[key] = deepMerge(base, value);
    } else {
      (target as any)[key] = value;
    }
  }
  return target;
}

export interface ConfigLoadResult {
  config: AgentConfig;
  sources: string[];
  createdDefault: boolean;
}

function finalizeConfig(merged: Record<string, any>): AgentConfig {
  if (!merged.model || typeof merged.model !== 'object') {
    merged.model = { ...DEFAULT_MODEL };
  } else {
    merged.model = { ...DEFAULT_MODEL, ...merged.model };
  }
  applyAgoraMemory(merged.model, merged.model.agoraMemory);
  normalizeAgoraModel(merged.model);
  if (!merged.mcpServers || typeof merged.mcpServers !== 'object') {
    merged.mcpServers = {};
  }
  return merged as AgentConfig;
}

function ensureGlobalDefault(): { created: boolean; path: string } {
  const dir = globalConfigDir();
  const file = globalConfigPath();
  if (fs.existsSync(file)) {
    return { created: false, path: file };
  }
  fs.mkdirSync(dir, { recursive: true });
  const defaults = { model: DEFAULT_MODEL };
  fs.writeFileSync(file, JSON.stringify(defaults, null, 2) + '\n', 'utf-8');
  return { created: true, path: file };
}

export function writeGlobalConfig(model: { baseURL: string; model: string; apiKey: string }): void {
  const dir = globalConfigDir();
  const file = globalConfigPath();
  fs.mkdirSync(dir, { recursive: true });

  let existing: Record<string, any> = {};
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* overwrite */ }
  }
  existing.model = model;
  fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
}

function stringField(source: Record<string, any>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function booleanField(source: Record<string, any>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function agoraMemoryConfig(source: unknown): AgoraMemoryConfig | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const memory = source as Record<string, any>;
  const config: AgoraMemoryConfig = {};

  const userId = stringField(memory, 'userId', 'user_id');
  const projectId = stringField(memory, 'projectId', 'project_id');
  const conversationId = stringField(memory, 'conversationId', 'conversation_id');
  const memoryProfile = stringField(memory, 'memoryProfile', 'memory_profile');
  const memoryEnabled = booleanField(memory, 'memoryEnabled', 'memory_enabled');

  if (userId) config.userId = userId;
  if (projectId) config.projectId = projectId;
  if (conversationId) config.conversationId = conversationId;
  if (memoryProfile) config.memoryProfile = memoryProfile;
  if (memoryEnabled !== undefined) {
    config.memoryEnabled = memoryEnabled;
  } else if (memoryProfile) {
    config.memoryEnabled = true;
  }

  return Object.keys(config).length > 0 ? config : null;
}

function agoraMemoryMetadata(source: unknown): Record<string, unknown> | null {
  const memory = agoraMemoryConfig(source);
  if (!memory) return null;
  const metadata: Record<string, unknown> = {};

  if (memory.userId) metadata.user_id = memory.userId;
  if (memory.projectId) metadata.project_id = memory.projectId;
  if (memory.conversationId) metadata.conversation_id = memory.conversationId;
  if (memory.memoryProfile) metadata.memory_profile = memory.memoryProfile;
  if (memory.memoryEnabled !== undefined) metadata.memory_enabled = memory.memoryEnabled;
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function applyAgoraMemory(model: Record<string, any>, source: unknown): void {
  const provider = typeof model.provider === 'string' ? model.provider.toLowerCase() : '';
  if (provider === 'agora') {
    const memory = agoraMemoryConfig(source);
    if (memory) {
      model.agoraMemory = {
        ...(model.agoraMemory && typeof model.agoraMemory === 'object' ? model.agoraMemory : {}),
        ...memory,
      };
    }
    return;
  }
  const metadata = agoraMemoryMetadata(source);
  if (!metadata) return;
  const extraParams =
    model.extraParams && typeof model.extraParams === 'object' && !Array.isArray(model.extraParams)
      ? { ...model.extraParams }
      : {};
  const existingMetadata =
    extraParams.metadata && typeof extraParams.metadata === 'object' && !Array.isArray(extraParams.metadata)
      ? { ...(extraParams.metadata as Record<string, unknown>) }
      : {};
  extraParams.metadata = { ...existingMetadata, ...metadata };
  model.extraParams = extraParams;
}

function credentialAgoraRuntime(credential: Record<string, any>): AgoraRuntimeConfig | undefined {
  const runtime =
    credential.agoraRuntime && typeof credential.agoraRuntime === 'object' && !Array.isArray(credential.agoraRuntime)
      ? { ...credential.agoraRuntime }
      : {};
  if (typeof credential.command === 'string' && credential.command.trim()) runtime.command = credential.command.trim();
  if (Array.isArray(credential.args) && credential.args.every((item) => typeof item === 'string')) {
    runtime.args = [...credential.args];
  }
  if (typeof credential.dataRoot === 'string' && credential.dataRoot.trim()) runtime.dataRoot = credential.dataRoot.trim();
  return Object.keys(runtime).length > 0 ? runtime : undefined;
}

function normalizeAgoraModel(model: Record<string, any>): void {
  const provider = typeof model.provider === 'string' ? model.provider.toLowerCase() : '';
  if (provider !== 'agora') return;

  const extraParams =
    model.extraParams && typeof model.extraParams === 'object' && !Array.isArray(model.extraParams)
      ? { ...model.extraParams }
      : null;
  const existingMetadata =
    extraParams?.metadata && typeof extraParams.metadata === 'object' && !Array.isArray(extraParams.metadata)
      ? { ...(extraParams.metadata as Record<string, unknown>) }
      : null;
  const memoryFromLegacyMetadata = agoraMemoryConfig(existingMetadata);
  if (memoryFromLegacyMetadata) {
    model.agoraMemory = {
      ...memoryFromLegacyMetadata,
      ...(model.agoraMemory && typeof model.agoraMemory === 'object' ? model.agoraMemory : {}),
    };
    for (const key of ['user_id', 'project_id', 'conversation_id', 'memory_profile', 'memory_enabled']) {
      delete existingMetadata?.[key];
    }
    if (extraParams && existingMetadata) {
      if (Object.keys(existingMetadata).length > 0) extraParams.metadata = existingMetadata;
      else delete extraParams.metadata;
      if (Object.keys(extraParams).length > 0) model.extraParams = extraParams;
      else delete model.extraParams;
    }
  }

  model.baseURL = AGORA_MCP_BASE_URL;
  model.apiKey = AGORA_MCP_API_KEY;
}

function resolveDefaultProfile(merged: Record<string, any>): void {
  const defaultProfile =
    typeof merged.defaultProfile === 'string' ? merged.defaultProfile : '';
  if (!defaultProfile) return;

  const profile = merged.profiles?.[defaultProfile];
  if (!profile || typeof profile !== 'object') return;
  const credentialId = profile.credentialId;
  if (typeof credentialId !== 'string') return;
  const credential = merged.credentials?.[credentialId];
  if (!credential || typeof credential !== 'object') return;
  const provider = typeof credential.provider === 'string' ? credential.provider : undefined;
  const isAgora = provider?.toLowerCase() === 'agora';
  if (!isAgora && typeof credential.baseURL !== 'string') return;
  if (typeof profile.model !== 'string') return;

  const model: Record<string, any> = {
    ...(merged.model && typeof merged.model === 'object' ? merged.model : {}),
    provider: credential.provider,
    baseURL: isAgora ? (credential.baseURL ?? AGORA_MCP_BASE_URL) : credential.baseURL,
    model: profile.model,
  };

  if (isAgora) {
    model.apiKey = AGORA_MCP_API_KEY;
    const runtime = credentialAgoraRuntime(credential);
    if (runtime) model.agoraRuntime = runtime;
  } else if (typeof credential.secretRef === 'string') {
    model.secretRef = credential.secretRef;
    model.apiKey = readSecret(
      credential.secretRef,
      `MA needs access to ${credentialId} for this session`
    );
  } else if (credential.apiKeyMode === 'none') {
    model.apiKey = 'lm-studio';
  }

  applyAgoraMemory(model, profile.agoraMemory);
  normalizeAgoraModel(model);
  merged.model = model;
}

export function loadConfigDetailed(configPath?: string): ConfigLoadResult {
  const sources: string[] = [];

  const { created: createdDefault, path: globalPath } = ensureGlobalDefault();

  const merged: Record<string, any> = {};

  if (fs.existsSync(globalPath)) {
    deepMerge(merged, readJson(globalPath));
    sources.push(globalPath);
  }

  const projectPath = projectConfigPath();
  if (fs.existsSync(projectPath) && projectPath !== globalPath) {
    deepMerge(merged, readJson(projectPath));
    sources.push(projectPath);
  }

  if (configPath) {
    const explicit = path.resolve(configPath);
    if (!fs.existsSync(explicit)) {
      throw new Error(`Config file not found: ${explicit}`);
    }
    deepMerge(merged, readJson(explicit));
    if (!sources.includes(explicit)) sources.push(explicit);
  }

  resolveDefaultProfile(merged);

  return {
    config: finalizeConfig(merged),
    sources,
    createdDefault,
  };
}

export function loadHostConfigDetailed(configPath: string | undefined): ConfigLoadResult {
  if (!configPath) throw new Error('Host-only MA requires an explicit config file');
  const explicit = path.resolve(configPath);
  if (!fs.existsSync(explicit)) throw new Error(`Config file not found: ${explicit}`);
  const merged = readJson(explicit) as Record<string, any>;
  if (
    merged.defaultProfile !== undefined
    || merged.credentials !== undefined
    || merged.profiles !== undefined
    || merged.model?.secretRef !== undefined
  ) {
    throw new Error('Host-only MA config cannot contain profiles, credentials, or secret references');
  }
  return {
    config: finalizeConfig(merged),
    sources: [explicit],
    createdDefault: false,
  };
}

export function loadConfig(configPath?: string): AgentConfig {
  return loadConfigDetailed(configPath).config;
}

export function resolveConfigPath(configPath?: string): string | null {
  if (configPath) {
    const explicit = path.resolve(configPath);
    return fs.existsSync(explicit) ? explicit : null;
  }
  const project = projectConfigPath();
  if (fs.existsSync(project)) return project;
  const global = globalConfigPath();
  if (fs.existsSync(global)) return global;
  return null;
}

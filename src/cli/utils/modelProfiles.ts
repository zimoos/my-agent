import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentConfig } from '../../mcp/types.js';
import { AGORA_MCP_API_KEY, AGORA_MCP_BASE_URL, globalConfigPath } from '../../config.js';
import { readSecret } from '../../secrets/keychain.js';

export interface ModelChoice {
  id: string;
  credentialId: string;
  provider: string;
  baseURL: string;
  model: string;
  label: string;
  current: boolean;
  source: 'remote' | 'cache' | 'config';
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function readGlobalConfigJson(): Record<string, any> {
  const file = globalConfigPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function writeGlobalConfigJson(config: Record<string, any>): void {
  const file = globalConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function credentialLabel(provider: string, credentialId: string): string {
  if (provider === 'agora') return credentialId || 'Agora-local';
  if (provider === 'lmstudio') return credentialId || 'LMStudio-local';
  if (provider === 'deepseek') return credentialId || 'DeepSeek';
  return credentialId || provider || 'Model';
}

async function fetchCredentialModels(credentialId: string, credential: any): Promise<{ models: string[]; source: ModelChoice['source'] }> {
  const provider = typeof credential?.provider === 'string' ? credential.provider : '';
  if (provider === 'agora') {
    const cached = Array.isArray(credential?.modelsCache?.models)
      ? unique(credential.modelsCache.models)
      : [];
    return { models: cached, source: cached.length > 0 ? 'cache' : 'config' };
  }
  const baseURL = typeof credential?.baseURL === 'string' ? credential.baseURL : '';
  if (!baseURL) return { models: [], source: 'config' };
  let apiKey = credential.apiKeyMode === 'none' ? 'lm-studio' : '';
  if (typeof credential.secretRef === 'string') {
    apiKey = readSecret(
      credential.secretRef,
      `MA needs access to list models for ${credentialId}`
    );
  }

  try {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as any;
    const rows = Array.isArray(data?.data) ? data.data : [];
    const models = unique(rows.map((m: any) => (typeof m?.id === 'string' ? m.id : '')));
    if (models.length > 0) return { models, source: 'remote' };
  } catch {
    // fall back to cache/config below
  }

  const cached = Array.isArray(credential?.modelsCache?.models)
    ? unique(credential.modelsCache.models)
    : [];
  return { models: cached, source: cached.length > 0 ? 'cache' : 'config' };
}

export async function listModelChoices(config: AgentConfig): Promise<ModelChoice[]> {
  const cfg = readGlobalConfigJson();
  const credentials = {
    ...(cfg.credentials && typeof cfg.credentials === 'object' ? cfg.credentials : {}),
    ...(config.credentials ?? {}),
  };
  const profiles = {
    ...(cfg.profiles && typeof cfg.profiles === 'object' ? cfg.profiles : {}),
    ...(config.profiles ?? {}),
  };
  const currentProfile = cfg.defaultProfile || config.defaultProfile || '';
  const choices: ModelChoice[] = [];

  for (const [credentialId, credential] of Object.entries(credentials) as Array<[string, any]>) {
    const provider = typeof credential?.provider === 'string' ? credential.provider : 'openai';
    const baseURL = provider === 'agora'
      ? AGORA_MCP_BASE_URL
      : typeof credential?.baseURL === 'string'
        ? credential.baseURL
        : '';
    const labelPrefix = credentialLabel(provider, credentialId);
    const fetched = await fetchCredentialModels(credentialId, credential);
    const profileModels = Object.values(profiles)
      .filter((p: any) => p?.credentialId === credentialId && typeof p.model === 'string')
      .map((p: any) => p.model);
    const models = unique([...fetched.models, ...profileModels]);
    for (const model of models) {
      const id = `${credentialId}/${model}`;
      choices.push({
        id,
        credentialId,
        provider,
        baseURL,
        model,
        label: `${labelPrefix}/${model}`,
        current: id === currentProfile || (
          config.model.baseURL === baseURL &&
          config.model.model === model
        ),
        source: fetched.source,
      });
    }
  }

  if (choices.length === 0) {
    choices.push({
      id: `current/${config.model.model}`,
      credentialId: 'current',
      provider: config.model.provider ?? 'openai',
      baseURL: config.model.baseURL,
      model: config.model.model,
      label: `Current/${config.model.model}`,
      current: true,
      source: 'config',
    });
  }

  return choices;
}

export function saveDefaultModelChoice(choice: ModelChoice): void {
  const cfg = readGlobalConfigJson();
  const credentials = cfg.credentials && typeof cfg.credentials === 'object' ? cfg.credentials : {};
  const profiles = cfg.profiles && typeof cfg.profiles === 'object' ? cfg.profiles : {};
  const credential = credentials[choice.credentialId] ?? {
    provider: choice.provider,
    baseURL: choice.provider === 'agora' ? AGORA_MCP_BASE_URL : choice.baseURL,
    apiKeyMode: choice.provider === 'lmstudio' || choice.provider === 'agora' ? 'none' : undefined,
  };
  if ((credential.provider ?? choice.provider) === 'agora') {
    credential.provider = 'agora';
    credential.baseURL = AGORA_MCP_BASE_URL;
    credential.apiKeyMode = 'none';
  }

  credentials[choice.credentialId] = credential;
  const existingProfile =
    profiles[choice.id] && typeof profiles[choice.id] === 'object'
      ? profiles[choice.id]
      : {};
  profiles[choice.id] = {
    ...existingProfile,
    credentialId: choice.credentialId,
    model: choice.model,
    label: choice.label,
  };
  cfg.credentials = credentials;
  cfg.profiles = profiles;
  cfg.defaultProfile = choice.id;
  cfg.model = {
    ...(cfg.model && typeof cfg.model === 'object' ? cfg.model : {}),
    provider: credential.provider ?? choice.provider,
    baseURL: (credential.provider ?? choice.provider) === 'agora'
      ? AGORA_MCP_BASE_URL
      : credential.baseURL ?? choice.baseURL,
    model: choice.model,
    ...(credential.secretRef
      ? { secretRef: credential.secretRef }
      : {
          apiKey:
            (credential.provider ?? choice.provider) === 'agora'
              ? AGORA_MCP_API_KEY
              : credential.apiKeyMode === 'none'
                ? 'lm-studio'
                : cfg.model?.apiKey,
        }),
  };
  if ((credential.provider ?? choice.provider) === 'agora') {
    const selectedProfile = profiles[choice.id];
    if (selectedProfile?.agoraMemory) cfg.model.agoraMemory = selectedProfile.agoraMemory;
    if (credential.agoraRuntime) cfg.model.agoraRuntime = credential.agoraRuntime;
    if (credential.command) cfg.model.agoraRuntime = { ...(cfg.model.agoraRuntime ?? {}), command: credential.command };
    if (credential.args) cfg.model.agoraRuntime = { ...(cfg.model.agoraRuntime ?? {}), args: credential.args };
    if (credential.dataRoot) cfg.model.agoraRuntime = { ...(cfg.model.agoraRuntime ?? {}), dataRoot: credential.dataRoot };
  }
  if (cfg.model.apiKey === undefined) delete cfg.model.apiKey;
  writeGlobalConfigJson(cfg);
}

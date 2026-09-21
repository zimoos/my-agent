import { isAbsolute } from 'node:path';
import type { MaBootstrapV2 } from './public-types.js';
import { cloneRuntimeJson, requireOwnData } from './data.js';

/** Decode only a private-channel bootstrap. Never log or include this object in events. */
export function parseMaBootstrapV2(input: unknown): MaBootstrapV2 {
  const value = cloneRuntimeJson(input);
  const bootstrap = requireOwnData(value, ['schemaVersion', 'kind', 'scope', 'sessionDirectory', 'agentDirectory',
    'config', 'capability', 'resources', 'hostControl']);
  if (bootstrap.schemaVersion !== 2 || bootstrap.kind !== 'ma.runtime.bootstrap') throw new Error('MA_BOOTSTRAP_VERSION');
  const id = (value: unknown): void => {
    if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('MA_BOOTSTRAP_IDENTITY');
  };
  const path = (value: unknown): void => {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error('MA_BOOTSTRAP_PATH');
  };
  const scope = requireOwnData(bootstrap.scope, ['maSessionId', 'workspaceId', 'canonicalCwd', 'hostIdentity', 'providerProfileId']);
  for (const key of ['maSessionId', 'workspaceId', 'hostIdentity', 'providerProfileId']) id(scope[key]);
  path(scope.canonicalCwd); path(bootstrap.sessionDirectory); path(bootstrap.agentDirectory);
  const capability = requireOwnData(bootstrap.capability, ['id', 'providerProfileId', 'providerId', 'modelId', 'input',
    'tools', 'reasoning', 'contextWindow', 'maxOutputTokens', 'cancellation']);
  for (const key of ['id', 'providerProfileId', 'providerId', 'modelId']) id(capability[key]);
  if (capability.providerProfileId !== scope.providerProfileId
    || !Array.isArray(capability.input) || capability.input.some(item => item !== 'text' && item !== 'image')
    || !capability.input.includes('text') || typeof capability.tools !== 'boolean' || typeof capability.reasoning !== 'boolean'
    || !['local', 'confirmed'].includes(String(capability.cancellation))) throw new Error('MA_BOOTSTRAP_CAPABILITY');
  for (const key of ['contextWindow', 'maxOutputTokens']) {
    const number = capability[key];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw new Error('MA_BOOTSTRAP_CAPABILITY');
  }
  const config = requireOwnData(bootstrap.config, ['model', 'mcpServers']);
  const model = requireOwnData(config.model, ['model', 'baseURL', 'apiKey']);
  if (model.model !== capability.modelId || typeof model.baseURL !== 'string' || typeof model.apiKey !== 'string') {
    throw new Error('MA_BOOTSTRAP_MODEL');
  }
  requireOwnData(config.mcpServers, []);
  const resources = requireOwnData(bootstrap.resources, ['skillDirectories', 'instructionFiles', 'extensions']);
  for (const key of ['skillDirectories', 'instructionFiles', 'extensions']) {
    if (!Array.isArray(resources[key]) || resources[key].some(item => typeof item !== 'string')) throw new Error('MA_BOOTSTRAP_RESOURCES');
  }
  for (const entry of [...resources.skillDirectories as string[], ...resources.instructionFiles as string[]]) path(entry);
  const extensions = resources.extensions as string[];
  const expected = ['ma-model-purpose', 'ma-resources', ...(capability.tools ? ['ma-tools'] : []),
    ...(Object.hasOwn(bootstrap, 'virtualUi') ? ['ma-frame'] : [])];
  if (extensions.length !== new Set(extensions).size || expected.some(name => !extensions.includes(name))
    || extensions.some(name => !expected.includes(name))) throw new Error('MA_BOOTSTRAP_EXTENSIONS');
  const host = requireOwnData(bootstrap.hostControl, ['transport', 'protocolVersion']);
  if (host.protocolVersion !== 2 || (host.transport !== 'acp' && host.transport !== 'local')) throw new Error('MA_BOOTSTRAP_HOST');
  if (Object.hasOwn(bootstrap, 'resumeSessionId')) id(bootstrap.resumeSessionId);
  if (Object.hasOwn(bootstrap, 'virtualUi')) {
    const virtualUi = requireOwnData(bootstrap.virtualUi, ['serverId', 'osInstanceId', 'agentId', 'teamId', 'tools']);
    for (const key of ['serverId', 'osInstanceId', 'agentId', 'teamId']) id(virtualUi[key]);
    const tools = requireOwnData(virtualUi.tools, ['current', 'act', 'search']);
    for (const key of ['current', 'act', 'search']) id(tools[key]);
    if (new Set(Object.values(tools)).size !== 3) throw new Error('MA_VUI_TOOL_BINDING_INVALID');
  }
  return value as MaBootstrapV2;
}

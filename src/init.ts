import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import * as readline from 'node:readline/promises';
import {
  clearLine,
  emitKeypressEvents,
  moveCursor,
  type Key,
} from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { AGORA_MCP_API_KEY, AGORA_MCP_BASE_URL, globalConfigDir, globalConfigPath } from './config.js';
import { createDefaultSkills } from './skills/loadSkills.js';
import { makeSecretRef, maskSecret, storeSecret } from './secrets/keychain.js';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
};

function isMaInstalled(): boolean {
  try {
    execSync('which ma', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

function installMa(): boolean {
  const projectRoot = findProjectRoot(import.meta.dirname);
  try {
    console.log(`${C.dim}Installing 'ma' command globally...${C.reset}`);
    execSync('npm run build', { cwd: projectRoot, stdio: 'pipe' });
    try {
      execSync('npm link', { cwd: projectRoot, stdio: 'pipe' });
    } catch {
      console.log(`${C.dim}Retrying with sudo...${C.reset}`);
      execSync('sudo npm link', { cwd: projectRoot, stdio: 'inherit' });
    }
    return true;
  } catch (err) {
    console.error(`${C.red}Failed to install: ${(err as Error).message}${C.reset}`);
    return false;
  }
}

function builtServer(projectRoot: string, name: string): string {
  return path.join(projectRoot, 'dist', 'servers', `${name}.js`);
}

function sourceServer(projectRoot: string, name: string): string {
  return path.join(projectRoot, 'servers', `${name}.ts`);
}

function serverCommand(projectRoot: string, name: string): { command: string; args: string[] } {
  const js = builtServer(projectRoot, name);
  if (fs.existsSync(js)) {
    return { command: process.execPath, args: [js] };
  }

  const tsxBin = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  return { command: tsxBin, args: [sourceServer(projectRoot, name)] };
}

function normalizeBaseURL(provider: string, baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/$/, '');
  if (provider === 'agora') return AGORA_MCP_BASE_URL;
  if (provider === 'lmstudio' && !trimmed.endsWith('/v1')) return `${trimmed}/v1`;
  return trimmed;
}

function providerFromBaseURL(baseURL: string): 'agora' | 'deepseek' | 'lmstudio' | 'openai' {
  if (baseURL.trim().startsWith('mcp-stdio://agora')) return 'agora';
  try {
    const url = new URL(baseURL);
    if (url.hostname === 'api.deepseek.com' || url.hostname.endsWith('.deepseek.com')) return 'deepseek';
    if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === '8000') return 'agora';
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return 'lmstudio';
  } catch {
    if (baseURL.includes('api.deepseek.com')) return 'deepseek';
    if (baseURL.includes(':8000')) return 'agora';
    if (baseURL.includes('localhost') || baseURL.includes('127.0.0.1')) return 'lmstudio';
  }
  return 'openai';
}

function defaultCredentialName(provider: string): string {
  if (provider === 'agora') return 'agora';
  if (provider === 'deepseek') return 'DeepSeek';
  if (provider === 'lmstudio') return 'LMStudio-local';
  return 'OpenAI';
}

function clearLines(count: number): void {
  for (let i = 0; i < count; i++) {
    moveCursor(output, 0, -1);
    clearLine(output, 0);
  }
}

async function selectOption<T>(
  title: string,
  options: Array<{ label: string; value: T }>
): Promise<T> {
  if (!input.isTTY || !output.isTTY) {
    return options[0].value;
  }

  let selected = 0;
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);

  const render = () => {
    output.write(`${C.bold}${title}${C.reset}\n`);
    for (let i = 0; i < options.length; i++) {
      const marker = i === selected ? `${C.cyan}❯${C.reset}` : ' ';
      output.write(`${marker} ${options[i].label}\n`);
    }
    output.write(`${C.dim}Use ↑/↓, Enter to select${C.reset}\n`);
  };

  render();
  return await new Promise<T>((resolve) => {
    const onKeypress = (_str: string, key: Key) => {
      if (key.name === 'up') {
        clearLines(options.length + 2);
        selected = (selected - 1 + options.length) % options.length;
        render();
        return;
      }
      if (key.name === 'down') {
        clearLines(options.length + 2);
        selected = (selected + 1) % options.length;
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        input.off('keypress', onKeypress);
        input.setRawMode(wasRaw);
        clearLines(options.length + 2);
        output.write(`${C.bold}${title}${C.reset}\n`);
        output.write(`${C.cyan}✓${C.reset} ${options[selected].label}\n\n`);
        resolve(options[selected].value);
        return;
      }
      if (key.name === 'c' && key.ctrl) {
        input.off('keypress', onKeypress);
        input.setRawMode(wasRaw);
        process.exit(130);
      }
    };
    input.on('keypress', onKeypress);
  });
}

async function questionHidden(
  rl: readline.Interface,
  prompt: string,
  fallback = ''
): Promise<string> {
  const originalWrite = (rl as any).output.write;
  (rl as any).output.write = function muted(chunk: string, ...args: any[]) {
    if (typeof chunk === 'string' && chunk.includes(prompt)) {
      return originalWrite.call(this, chunk, ...args);
    }
    return true;
  };
  try {
    const answer = await rl.question(prompt);
    output.write('\n');
    return answer || fallback;
  } finally {
    (rl as any).output.write = originalWrite;
  }
}

async function fetchModelIds(baseURL: string, apiKey: string): Promise<string[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ac.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows
      .map((m: any) => (typeof m?.id === 'string' ? m.id : ''))
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function chooseModel(
  rl: readline.Interface,
  providerLabel: string,
  models: string[],
  fallback: string
): Promise<string> {
  if (models.length === 0) {
    return await rl.question(`${C.cyan}Model name ${C.dim}(${fallback})${C.reset}: `) || fallback;
  }
  console.log(`${C.green}✓ Found ${models.length} model(s) from ${providerLabel}${C.reset}`);
  const manualValue = '__manual__';
  const selected = await selectOption<string>(
    'Choose model',
    [
      ...models.map((m) => ({ label: `${providerLabel}-${m}`, value: m })),
      { label: 'Manual input', value: manualValue },
    ]
  );
  if (selected !== manualValue) return selected;
  return await rl.question(`${C.cyan}Model name ${C.dim}(${fallback})${C.reset}: `) || fallback;
}

function readExistingConfig(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function makeProfileId(credentialId: string, model: string): string {
  return `${credentialId}/${model}`;
}

async function collectProfileConfig(rawArgs: string[]): Promise<{
  provider: string;
  providerLabel: string;
  credentialId: string;
  baseURL: string;
  model: string;
  apiKey: string;
  secretRef?: string;
  models: string[];
}> {
  if (rawArgs.length >= 2) {
    const rawBaseURL = rawArgs[0];
    const provider = providerFromBaseURL(rawBaseURL);
    const baseURL = normalizeBaseURL(provider, rawBaseURL);
    const apiKey = rawArgs[2] || (provider === 'agora' ? AGORA_MCP_API_KEY : provider === 'lmstudio' ? 'lm-studio' : '');
    const credentialId = defaultCredentialName(provider);
    return {
      provider,
      providerLabel: credentialId.replace(/-local$/, ''),
      credentialId,
      baseURL,
      model: rawArgs[1],
      apiKey,
      models: [],
    };
  }

  const rl = readline.createInterface({ input, output });
  try {
    console.log(`${C.bold}my-agent init${C.reset}\n`);
    const provider = await selectOption<'lmstudio' | 'deepseek' | 'agora'>(
      'Model source',
      [
        { label: 'LM Studio local', value: 'lmstudio' },
        { label: 'Agora local', value: 'agora' },
        { label: 'DeepSeek official', value: 'deepseek' },
      ]
    );
    const providerLabel = provider === 'deepseek' ? 'DeepSeek' : provider === 'agora' ? 'Agora' : 'LMStudio';
    const defaultBaseURL = provider === 'deepseek'
      ? 'https://api.deepseek.com'
      : provider === 'agora'
        ? AGORA_MCP_BASE_URL
      : 'http://localhost:1234/v1';
    const baseURL = normalizeBaseURL(
      provider,
      await rl.question(`${C.cyan}Base URL ${C.dim}(${defaultBaseURL})${C.reset}: `) || defaultBaseURL
    );
    const defaultCredential = defaultCredentialName(provider);
    const credentialId = await rl.question(`${C.cyan}Credential name ${C.dim}(${defaultCredential})${C.reset}: `) || defaultCredential;
    const apiKey = provider === 'agora'
      ? AGORA_MCP_API_KEY
      : provider === 'lmstudio'
        ? 'lm-studio'
      : await questionHidden(rl, `${C.cyan}API key ${C.dim}(stored in Keychain)${C.reset}: `);
    const models = provider === 'agora' ? [] : await fetchModelIds(baseURL, apiKey);
    const fallback = provider === 'deepseek'
      ? 'deepseek-v4-pro'
      : provider === 'agora'
        ? 'qwen3.6-35b-a3b-q4'
        : 'qwen3-30b-a3b';
    const model = await chooseModel(rl, providerLabel, models, fallback);
    return { provider, providerLabel, credentialId, baseURL, model, apiKey, models };
  } finally {
    rl.close();
  }
}

export async function runInit(rawArgs = process.argv.slice(2)): Promise<void> {
  const args = rawArgs.filter(a => a !== '--');
  const profile = await collectProfileConfig(args);
  const { provider, providerLabel, credentialId, baseURL, model, apiKey, models } = profile;

  const projectRoot = findProjectRoot(import.meta.dirname);

  const profileId = makeProfileId(credentialId, model);
  const file = globalConfigPath();
  const existing = readExistingConfig(file);
  const credentials = {
    ...(existing.credentials && typeof existing.credentials === 'object' ? existing.credentials : {}),
  };
  const profiles = {
    ...(existing.profiles && typeof existing.profiles === 'object' ? existing.profiles : {}),
  };
  let secretRef: string | undefined;

  if (provider === 'deepseek') {
    if (!apiKey) throw new Error('DeepSeek API key is required');
    secretRef = makeSecretRef(credentialId);
    storeSecret(secretRef, apiKey);
  }

  credentials[credentialId] = {
    provider,
    baseURL,
    ...(secretRef
      ? { secretRef, apiKeyMode: 'secret', authPolicy: 'session' }
      : { apiKeyMode: 'none' }),
    modelsCache: {
      fetchedAt: new Date().toISOString(),
      models: models.length > 0 ? models : [model],
    },
  };
  profiles[profileId] = {
    credentialId,
    model,
    label: `${providerLabel}-${model}`,
  };

  const modelConfig: Record<string, any> = {
    provider,
    baseURL,
    model,
    ...(secretRef ? { secretRef } : { apiKey: provider === 'agora' ? AGORA_MCP_API_KEY : 'lm-studio' }),
  };

  const config: Record<string, any> = {
    defaultProfile: profileId,
    credentials,
    profiles,
    model: modelConfig,
    mcpServers: {
      exec: serverCommand(projectRoot, 'exec-mcp'),
      fs: serverCommand(projectRoot, 'fs-mcp'),
      'fs-edit': serverCommand(projectRoot, 'fs-edit-mcp'),
      grep: serverCommand(projectRoot, 'grep-mcp'),
      web: serverCommand(projectRoot, 'web-mcp'),
    },
  };

  const dir = globalConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  Object.assign(existing, config);

  fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

  console.log(`${C.green}✓ Config saved to ~/.my-agent/config.json${C.reset}`);
  if (secretRef) {
    console.log(`${C.green}✓ API key stored in macOS Keychain (${maskSecret(apiKey)})${C.reset}`);
  }
  console.log(`${C.dim}  profile: ${profileId}${C.reset}`);
  console.log(`${C.dim}  baseURL: ${baseURL}${C.reset}`);
  console.log(`${C.dim}  model:   ${model}${C.reset}`);
  console.log(`${C.dim}  exec:    ${config.mcpServers.exec.command} ${config.mcpServers.exec.args[0]}${C.reset}`);
  console.log(`${C.dim}  fs:      ${config.mcpServers.fs.command} ${config.mcpServers.fs.args[0]}${C.reset}`);

  console.log(`${C.green}✓ built-in output compression${C.reset}`);

  // Create .ma directory with example skills
  const cwd = process.cwd();
  const maSkillsDir = path.join(cwd, '.ma', 'skills');

  if (!fs.existsSync(maSkillsDir)) {
    fs.mkdirSync(maSkillsDir, { recursive: true });
    await createDefaultSkills(maSkillsDir);
    console.log(`${C.green}✓ Created .ma/skills/ directory with example skills${C.reset}`);
    console.log(`${C.dim}  Try: /skills, /deploy environment=staging, /git-status${C.reset}`);
  } else {
    console.log(`${C.green}✓ .ma/skills/ directory already exists${C.reset}`);
  }

  // check if ma CLI is globally installed
  if (isMaInstalled()) {
    console.log(`${C.green}✓ 'ma' command is available${C.reset}`);
  } else {
    console.log(`${C.yellow}⚠ 'ma' command not found globally${C.reset}`);
    if (installMa()) {
      console.log(`${C.green}✓ 'ma' command installed${C.reset}`);
    } else {
      console.log(`${C.yellow}  Run 'npm link' manually in the project directory${C.reset}`);
    }
  }

  console.log(`\n${C.bold}Ready! Run 'ma' to start chatting.${C.reset}`);
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  runInit().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

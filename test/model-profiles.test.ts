import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listModelChoices, saveDefaultModelChoice } from '../src/cli/utils/modelProfiles.js';
import type { AgentConfig } from '../src/mcp/types.js';

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const original: Record<string, string | undefined> = {};
  const normalizedEnv = { ...env };
  if (env.HOME && !normalizedEnv.USERPROFILE) {
    normalizedEnv.USERPROFILE = env.HOME;
  }
  const origFetch = globalThis.fetch;
  for (const k of Object.keys(normalizedEnv)) {
    original[k] = process.env[k];
    process.env[k] = normalizedEnv[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(original)) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    globalThis.fetch = origFetch;
  }
}

function config(): AgentConfig {
  return {
    model: {
      provider: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      model: 'qwen-old',
      apiKey: 'lm-studio',
    },
    mcpServers: {},
  };
}

test('model profiles: lists remote models across credentials and persists selected default', async () => {
  const home = mktmp('ma-model-profile-home-');
  fs.mkdirSync(path.join(home, '.my-agent'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.my-agent', 'config.json'),
    JSON.stringify({
      defaultProfile: 'LMStudio-local/qwen-old',
      credentials: {
        'LMStudio-local': {
          provider: 'lmstudio',
          baseURL: 'http://localhost:1234/v1',
          apiKeyMode: 'none',
          modelsCache: { models: ['qwen-old'] },
        },
        'DeepSeek-work': {
          provider: 'deepseek',
          baseURL: 'https://api.deepseek.com',
          secretRef: 'env:MA_TEST_DEEPSEEK_KEY',
          apiKeyMode: 'secret',
        },
      },
      profiles: {
        'LMStudio-local/qwen-old': {
          credentialId: 'LMStudio-local',
          model: 'qwen-old',
        },
      },
    })
  );

  await withEnv({ HOME: home, MA_TEST_DEEPSEEK_KEY: 'sk-test' }, async () => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.startsWith('http://localhost:1234')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen-new' }] }), { status: 200 });
      }
      if (href.startsWith('https://api.deepseek.com')) {
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer sk-test');
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as any;

    const choices = await listModelChoices(config());
    assert.deepEqual(
      choices.map((c) => c.id).sort(),
      ['DeepSeek-work/deepseek-v4-pro', 'LMStudio-local/qwen-new', 'LMStudio-local/qwen-old'].sort()
    );

    const selected = choices.find((c) => c.id === 'DeepSeek-work/deepseek-v4-pro');
    assert.ok(selected);
    saveDefaultModelChoice(selected);

    const saved = JSON.parse(fs.readFileSync(path.join(home, '.my-agent', 'config.json'), 'utf-8'));
    assert.equal(saved.defaultProfile, 'DeepSeek-work/deepseek-v4-pro');
    assert.equal(saved.model.model, 'deepseek-v4-pro');
    assert.equal(saved.model.secretRef, 'env:MA_TEST_DEEPSEEK_KEY');
    assert.equal(saved.model.apiKey, undefined);
  });
});

test('model profiles: saving Agora default preserves memory binding metadata', async () => {
  const home = mktmp('ma-model-profile-home-');
  fs.mkdirSync(path.join(home, '.my-agent'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.my-agent', 'config.json'),
    JSON.stringify({
      credentials: {
        agora: {
          provider: 'agora',
          baseURL: 'http://127.0.0.1:8000/v1',
          apiKeyMode: 'none',
          modelsCache: { models: ['qwen3.6-35b-a3b-q4'] },
        },
      },
      profiles: {
        'agora/qwen3.6-35b-a3b-q4': {
          credentialId: 'agora',
          model: 'qwen3.6-35b-a3b-q4',
          label: 'Agora-qwen3.6-35b-a3b-q4',
          agoraMemory: {
            userId: 'agent-user',
            projectId: 'my-agent',
            conversationId: 'conv-001',
            memoryProfile: 'profile-agora-demo',
          },
        },
      },
    })
  );

  await withEnv({ HOME: home }, async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 404 })) as any;

    const selected = (await listModelChoices(config())).find(
      (choice) => choice.id === 'agora/qwen3.6-35b-a3b-q4'
    );
    assert.ok(selected);
    saveDefaultModelChoice(selected);

    const saved = JSON.parse(fs.readFileSync(path.join(home, '.my-agent', 'config.json'), 'utf-8'));
    assert.equal(saved.defaultProfile, 'agora/qwen3.6-35b-a3b-q4');
    assert.equal(saved.model.provider, 'agora');
    assert.equal(saved.model.baseURL, 'mcp-stdio://agora');
    assert.equal(saved.model.apiKey, 'agora-mcp');
    assert.deepEqual(saved.profiles['agora/qwen3.6-35b-a3b-q4'].agoraMemory, {
      userId: 'agent-user',
      projectId: 'my-agent',
      conversationId: 'conv-001',
      memoryProfile: 'profile-agora-demo',
    });
    assert.deepEqual(saved.model.agoraMemory, {
      userId: 'agent-user',
      projectId: 'my-agent',
      conversationId: 'conv-001',
      memoryProfile: 'profile-agora-demo',
    });
  });
});

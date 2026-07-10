import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { deepMerge, loadConfigDetailed } from '../src/config.js';

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  const normalizedEnv = { ...env };
  if (env.HOME && !normalizedEnv.USERPROFILE) {
    normalizedEnv.USERPROFILE = env.HOME;
  }
  for (const k of Object.keys(normalizedEnv)) {
    original[k] = process.env[k];
    process.env[k] = normalizedEnv[k];
  }
  const origCwd = process.cwd();
  try {
    return fn();
  } finally {
    for (const k of Object.keys(original)) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    process.chdir(origCwd);
  }
}

test('deepMerge: merges nested objects, source wins on leaves', () => {
  const t = { a: 1, nested: { x: 1, y: 2 } };
  const s = { b: 2, nested: { y: 99, z: 3 } };
  const out = deepMerge(t as any, s as any);
  assert.deepEqual(out, { a: 1, b: 2, nested: { x: 1, y: 99, z: 3 } });
});

test('deepMerge: replaces arrays (does not concat)', () => {
  const t = { list: [1, 2, 3] };
  const s = { list: [9] };
  const out = deepMerge(t as any, s as any);
  assert.deepEqual(out.list, [9]);
});

test('loadConfigDetailed: creates default global config when none exists', () => {
  const home = mktmp('my-agent-home-');
  const proj = mktmp('my-agent-proj-');
  withEnv({ HOME: home }, () => {
    process.chdir(proj);
    const res = loadConfigDetailed();
    assert.equal(res.createdDefault, true);
    const globalPath = path.join(home, '.my-agent', 'config.json');
    assert.ok(fs.existsSync(globalPath), 'global config should be created');
    const parsed = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
    assert.equal(parsed.model.baseURL, 'http://localhost:1234/v1');
    assert.equal(parsed.model.model, 'qwen3-30b-a3b');
    assert.equal(parsed.model.apiKey, 'lm-studio');
    assert.equal(res.config.model.model, 'qwen3-30b-a3b');
    assert.deepEqual(res.sources, [globalPath]);
  });
});

test('loadConfigDetailed: project config merges over global, project wins', () => {
  const home = mktmp('my-agent-home-');
  const proj = mktmp('my-agent-proj-');
  fs.mkdirSync(path.join(home, '.my-agent'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.my-agent', 'config.json'),
    JSON.stringify({
      model: { baseURL: 'http://global/v1', model: 'global-model', apiKey: 'g' },
      systemPrompt: 'from-global',
    })
  );
  fs.writeFileSync(
    path.join(proj, 'config.json'),
    JSON.stringify({
      mcpServers: { exec: { command: 'tsx', args: ['x.ts'] } },
      systemPrompt: 'from-project',
    })
  );
  withEnv({ HOME: home }, () => {
    process.chdir(proj);
    const { config, sources, createdDefault } = loadConfigDetailed();
    assert.equal(createdDefault, false);
    assert.equal(sources.length, 2);
    assert.equal(config.model.model, 'global-model');
    assert.equal(config.systemPrompt, 'from-project');
    assert.ok(config.mcpServers.exec);
  });
});

test('loadConfigDetailed: project-level model overrides global model', () => {
  const home = mktmp('my-agent-home-');
  const proj = mktmp('my-agent-proj-');
  fs.mkdirSync(path.join(home, '.my-agent'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.my-agent', 'config.json'),
    JSON.stringify({ model: { baseURL: 'http://global/v1', model: 'global-model', apiKey: 'g' } })
  );
  fs.writeFileSync(
    path.join(proj, 'config.json'),
    JSON.stringify({ model: { model: 'project-model' } })
  );
  withEnv({ HOME: home }, () => {
    process.chdir(proj);
    const { config } = loadConfigDetailed();
    assert.equal(config.model.model, 'project-model');
    assert.equal(config.model.baseURL, 'http://global/v1');
    assert.equal(config.model.apiKey, 'g');
  });
});

test('loadConfigDetailed: explicit --config overrides both', () => {
  const home = mktmp('my-agent-home-');
  const proj = mktmp('my-agent-proj-');
  const explicit = path.join(proj, 'alt.json');
  fs.writeFileSync(explicit, JSON.stringify({ model: { model: 'explicit-model' } }));
  withEnv({ HOME: home }, () => {
    process.chdir(proj);
    const { config, sources } = loadConfigDetailed(explicit);
    assert.equal(config.model.model, 'explicit-model');
    assert.ok(sources.includes(explicit));
  });
});

test('loadConfigDetailed: explicit --config missing throws', () => {
  const home = mktmp('my-agent-home-');
  withEnv({ HOME: home }, () => {
    assert.throws(() => loadConfigDetailed('/nonexistent/path/to/config.json'), /Config file not found/);
  });
});

test('loadConfigDetailed: defaults applied when no model in any source', () => {
  const home = mktmp('my-agent-home-');
  const proj = mktmp('my-agent-proj-');
  fs.mkdirSync(path.join(home, '.my-agent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.my-agent', 'config.json'), JSON.stringify({ systemPrompt: 'hi' }));
  withEnv({ HOME: home }, () => {
    process.chdir(proj);
    const { config } = loadConfigDetailed();
    assert.equal(config.model.baseURL, 'http://localhost:1234/v1');
    assert.equal(config.model.model, 'qwen3-30b-a3b');
    assert.equal(config.model.apiKey, 'lm-studio');
  });
});

test('loadConfigDetailed: defaultProfile resolves model through env secretRef without writing apiKey in config', () => {
  const home = mktmp('my-agent-home-');
  const proj = mktmp('my-agent-proj-');
  fs.mkdirSync(path.join(home, '.my-agent'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.my-agent', 'config.json'),
    JSON.stringify({
      defaultProfile: 'DeepSeek-work/deepseek-v4-pro',
      credentials: {
        'DeepSeek-work': {
          provider: 'deepseek',
          baseURL: 'https://api.deepseek.com',
          secretRef: 'env:MA_TEST_DEEPSEEK_KEY',
          apiKeyMode: 'secret',
        },
      },
      profiles: {
        'DeepSeek-work/deepseek-v4-pro': {
          credentialId: 'DeepSeek-work',
          model: 'deepseek-v4-pro',
        },
      },
    })
  );
  withEnv({ HOME: home, MA_TEST_DEEPSEEK_KEY: 'sk-env-secret' }, () => {
    process.chdir(proj);
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.my-agent', 'config.json'), 'utf-8'));
    assert.equal(raw.model, undefined);
    const { config } = loadConfigDetailed();
    assert.equal(config.model.provider, 'deepseek');
    assert.equal(config.model.baseURL, 'https://api.deepseek.com');
    assert.equal(config.model.model, 'deepseek-v4-pro');
    assert.equal(config.model.apiKey, 'sk-env-secret');
    assert.equal(config.model.secretRef, 'env:MA_TEST_DEEPSEEK_KEY');
  });
});

test('loadConfigDetailed: defaultProfile maps Agora memory profile to MCP stdio provider config', () => {
  const home = mktmp('my-agent-home-');
  const proj = mktmp('my-agent-proj-');
  fs.mkdirSync(path.join(home, '.my-agent'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.my-agent', 'config.json'),
    JSON.stringify({
      defaultProfile: 'agora/qwen3.6-35b-a3b-q4',
      model: {
        extraParams: {
          seed: 123,
          metadata: { trace_id: 'keep-me' },
        },
      },
      credentials: {
        agora: {
          provider: 'agora',
          baseURL: 'http://127.0.0.1:8000/v1',
          apiKeyMode: 'none',
        },
      },
      profiles: {
        'agora/qwen3.6-35b-a3b-q4': {
          credentialId: 'agora',
          model: 'qwen3.6-35b-a3b-q4',
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

  withEnv({ HOME: home }, () => {
    process.chdir(proj);
    const { config } = loadConfigDetailed();
    assert.equal(config.model.provider, 'agora');
    assert.equal(config.model.baseURL, 'mcp-stdio://agora');
    assert.equal(config.model.model, 'qwen3.6-35b-a3b-q4');
    assert.equal(config.model.apiKey, 'agora-mcp');
    assert.deepEqual(config.model.agoraMemory, {
      userId: 'agent-user',
      projectId: 'my-agent',
      conversationId: 'conv-001',
      memoryProfile: 'profile-agora-demo',
      memoryEnabled: true,
    });
    assert.deepEqual(config.model.extraParams, {
      seed: 123,
      metadata: {
        trace_id: 'keep-me',
      },
    });
  });
});

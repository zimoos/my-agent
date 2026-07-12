import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeCommand, getAllCommands, getSuggestedCommands } from '../src/cli/utils/commands.js';

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    agent: {},
    connections: [],
    config: { model: { baseURL: 'http://localhost', model: 'm', apiKey: 'k' }, mcpServers: {} },
    exit: () => {},
    ...overrides,
  } as any;
}

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-command-test-'));
  fs.mkdirSync(path.join(dir, '.ma', 'skills'), { recursive: true });
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('/revert calls the UI-aware revert callback', async () => {
  await withTempCwd(async () => {
    let called = 0;
    const result = await executeCommand('/revert', baseContext({
      revertLastTurn: () => {
        called++;
        return true;
      },
    }));

    assert.equal(called, 1);
    assert.equal(result, '[已回退上一轮对话，文件未回退]');
  });
});

test('/revert reports when there is no visible turn to revert', async () => {
  await withTempCwd(async () => {
    const result = await executeCommand('/revert', baseContext({
      revertLastTurn: () => false,
    }));

    assert.equal(result, '[没有可回退的对话]');
  });
});

test('/model opens the model picker when no args are provided', async () => {
  await withTempCwd(async () => {
    let called = 0;
    const result = await executeCommand('/model', baseContext({
      openModelPicker: () => {
        called++;
      },
    }));

    assert.equal(called, 1);
    assert.equal(result, null);
  });
});

test('/memory opens the console and lists named writable profiles', async () => {
  await withTempCwd(async () => {
    let opened = 0;
    const controller = {
      listProfiles: async () => [{
        id: 'profile-a',
        name: 'MA 核心记忆',
        active_memory_patch_ids: ['patch-a', 'overlay-a'],
        writable_patch_family: 'project-memory',
        auto_intake_policy: { enabled: true },
      }],
    };
    const agent = { getMemoryController: () => controller };
    assert.equal(await executeCommand('/memory', baseContext({ agent, openMemoryConsole: () => { opened++; } })), null);
    assert.equal(opened, 1);
    const listed = await executeCommand('/memory list', baseContext({ agent }));
    assert.match(String(listed), /MA 核心记忆/);
    assert.match(String(listed), /writable=project-memory/);
    assert.match(String(listed), /auto=on/);
  });
});

test('/context routes inspection, search, recall, and pin commands to the agent', async () => {
  await withTempCwd(async () => {
    const calls: string[] = [];
    const agent = {
      inspectContext: () => {
        calls.push('inspect');
        return 'context state';
      },
      searchContext: (query: string) => {
        calls.push(`search:${query}`);
        return [
          {
            id: 'p_1',
            role: 'summary',
            summary: 'Relevant session summary',
            text: 'longer relevant text',
          },
        ];
      },
      recallContext: (id: string) => {
        calls.push(`recall:${id}`);
        return `Recalled ${id}`;
      },
      pinContext: (text: string) => {
        calls.push(`pin:${text}`);
        return `Pinned: ${text}`;
      },
    };

    assert.equal(await executeCommand('/context', baseContext({ agent })), 'context state');
    assert.match(
      String(await executeCommand('/context search session', baseContext({ agent }))),
      /p_1 \[summary\] Relevant session summary/
    );
    assert.equal(await executeCommand('/context recall p_1', baseContext({ agent })), 'Recalled p_1');
    assert.equal(await executeCommand('/context pin keep this', baseContext({ agent })), 'Pinned: keep this');
    assert.deepEqual(calls, ['inspect', 'search:session', 'recall:p_1', 'pin:keep this']);
  });
});

test('/help is available for slash command suggestions', async () => {
  await withTempCwd(async () => {
    const commands = await getAllCommands();
    assert.equal(commands.has('/help'), true);

    const result = await executeCommand('/help', baseContext());
    assert.match(String(result), /\/model\s+Open model switcher/);
    assert.match(String(result), /\/help\s+Show commands/);
  });
});

test('slash suggestions only include user-facing commands', async () => {
  await withTempCwd(async () => {
    const suggestions = await getSuggestedCommands();

    assert.deepEqual(
      Array.from(suggestions.keys()).sort(),
      ['/clear', '/exit', '/help', '/memory', '/model']
    );

    const all = await getAllCommands();
    assert.equal(all.has('/abort'), true);
    assert.equal(suggestions.has('/abort'), false);
    assert.equal(suggestions.has('/archive'), false);
    assert.equal(suggestions.has('/models'), false);
    assert.equal(suggestions.has('/tools'), false);
  });
});

test('/model use switches by matching profile id', async () => {
  await withTempCwd(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-model-command-home-'));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      fs.mkdirSync(path.join(home, '.my-agent'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.my-agent', 'config.json'),
        JSON.stringify({
          credentials: {
            'LMStudio-local': {
              provider: 'lmstudio',
              baseURL: 'http://localhost:1234/v1',
              apiKeyMode: 'none',
              modelsCache: { models: ['qwen-a'] },
            },
          },
          profiles: {},
        })
      );
      let selected = '';
      const result = await executeCommand('/model use LMStudio-local/qwen-a', baseContext({
        switchModelChoice: (choice: any) => {
          selected = choice.id;
        },
      }));

      assert.equal(result, null);
      assert.equal(selected, 'LMStudio-local/qwen-a');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

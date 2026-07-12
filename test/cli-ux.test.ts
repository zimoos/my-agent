import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

test('CLI UX PTY: DeepSeek status bar uses provider capability instead of 33k fallback', async (t) => {
  if (process.env.MA_RUN_PTY_TESTS !== '1') {
    t.skip('PTY UI verification runs only in the explicit MA_RUN_PTY_TESTS E2E lane');
    return;
  }
  if (!canSpawnPty()) {
    t.skip('node-pty cannot spawn a basic /bin/echo process in this environment');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cli-ux-'));
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        defaultProfile: '',
        model: {
          provider: 'deepseek',
          baseURL: 'http://127.0.0.1:9/v1',
          model: 'deepseek-v4-flash',
          apiKey: 'test',
        },
        mcpServers: {},
      },
      null,
      2
    ),
    'utf8'
  );

  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = pty.spawn(process.execPath, [tsxCli, 'src/cli/index.tsx', 'chat', '--config', configPath], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
  });

  let output = '';
  child.onData((data) => {
    output += data;
  });

  try {
    await waitFor(() => /win\s+1m\s+registry/.test(stripAnsi(output)), 10_000);
    const plain = stripAnsi(output);
    assert.match(plain, /ctx:/);
    assert.match(plain, /trigger/);
    assert.match(plain, /win 1m registry/);
    assert.doesNotMatch(plain, /33k/);
  } finally {
    child.kill('SIGINT');
  }
});

test('CLI UX PTY: Agora keeps context usage and memory activity on separate readable lines', async (t) => {
  if (process.env.MA_RUN_PTY_TESTS !== '1') {
    t.skip('PTY UI verification runs only in the explicit MA_RUN_PTY_TESTS E2E lane');
    return;
  }
  if (!canSpawnPty()) {
    t.skip('node-pty cannot spawn a basic /bin/echo process in this environment');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cli-agora-ux-'));
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    defaultProfile: '',
    model: {
      provider: 'agora',
      baseURL: 'mcp-stdio://agora',
      model: 'qwen3.6-35b-a3b-q4',
      apiKey: 'agora-mcp',
    },
    mcpServers: {},
  }, null, 2));
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = pty.spawn(process.execPath, [tsxCli, 'src/cli/index.tsx', 'chat', '--config', configPath], {
    name: 'xterm-256color',
    cols: 80,
    rows: 30,
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1' },
  });
  let output = '';
  child.onData((data) => { output += data; });
  try {
    await waitFor(() => /Memory:\s+未挂载/.test(stripAnsi(output)), 10_000);
    const plain = stripAnsi(output);
    assert.match(plain, /ctx:/);
    assert.match(plain, /trigger/);
    assert.match(plain, /Memory:\s+未挂载/);
    assert.match(plain, /unknown/);
    assert.doesNotMatch(plain, /sess\s/);
  } finally {
    child.kill('SIGINT');
  }
});

test('CLI UX PTY: Agora Memory v2 console is name-first and readable at 80 columns', async (t) => {
  if (process.env.MA_RUN_PTY_TESTS !== '1') {
    t.skip('PTY UI verification runs only in the explicit MA_RUN_PTY_TESTS E2E lane');
    return;
  }
  if (!canSpawnPty()) {
    t.skip('node-pty cannot spawn a basic /bin/echo process in this environment');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cli-agora-memory-v2-'));
  const fakeAgora = path.join(tmp, 'fake-agora-v2.mjs');
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(fakeAgora, fakeAgoraV2Source(), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    defaultProfile: '',
    model: {
      provider: 'agora',
      baseURL: 'mcp-stdio://agora',
      model: 'base-a',
      apiKey: 'agora-mcp',
      agoraRuntime: { command: process.execPath, args: [fakeAgora] },
    },
    mcpServers: {},
  }, null, 2));
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = pty.spawn(process.execPath, [tsxCli, 'src/cli/index.tsx', 'chat', '--config', configPath], {
    name: 'xterm-256color',
    cols: 80,
    rows: 30,
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1', MA_REDUCED_MOTION: '1' },
  });
  let output = '';
  child.onData((data) => { output += data; });
  try {
    await waitFor(() => /Memory:\s+未挂载/.test(stripAnsi(output)), 10_000);
    child.write('/memory');
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.write('\r');
    try {
      await waitFor(() => /具名记忆/.test(stripAnsi(output)) && /产品记忆/.test(stripAnsi(output)), 10_000);
    } catch (err) {
      throw new Error(`${(err as Error).message}\nPTY output:\n${stripAnsi(output).slice(-4000)}`);
    }
    const plain = stripAnsi(output);
    assert.match(plain, /Memory ·/);
    assert.match(plain, /产品记忆 · v1/);
    assert.match(plain, /Space 挂载/);
    assert.doesNotMatch(plain, /writable_patch_family|主记忆\/可写|Profiles/);
  } finally {
    child.kill('SIGINT');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function fakeAgoraV2Source(): string {
  return `let buffer = '';
const names = ${JSON.stringify([
    'doctor', 'runtime_capabilities', 'models_list', 'models_status', 'models_download', 'chat_complete',
    'memory_profiles_list', 'memory_profiles_create', 'memory_profiles_update',
    'memory_profile_bindings_list', 'memory_profile_bindings_create', 'memory_patches_list', 'memory_patch_versions',
    'memories_create', 'memories_get', 'memories_list', 'memories_rename', 'memories_rollback',
    'memory_intake_batch_run', 'memory_intake_batch_get',
  ])};
const payloads = {
  doctor: { status: 'ok', version: '0.2.0', contract: { host_protocol_major: 1 } },
  runtime_capabilities: { status: 'ok', contract: { runtime_version: '0.2.0', host_protocol_major: 1, registry_schema_version: 3, capabilities: { named_memories: 1, multi_target_intake: 1, incremental_segments: 1, multi_model_delta_mount: 1, request_boundary_hot_swap: 1, memory_runtime_v2: 1 } } },
  models_list: { models: [{ id: 'base-a', name: 'Base A', status: 'available' }] },
  memories_list: { memories: [{ id: 'memory-a', name: '产品记忆', base_model_id: 'base-a', head_patch_id: 'patch-a', status: 'available' }] },
  memory_profiles_list: { profiles: [{ id: 'profile-a', name: 'project', base_model_id: 'base-a', active_memory_patch_ids: [], auto_intake_target_memory_ids: [], auto_intake_policy: { enabled: false }, status: 'available' }] },
  memory_patches_list: { patches: [{ id: 'patch-a', name: '产品记忆@v1', base_model_id: 'base-a', family: 'memory-a', version: 'v1', mountable: true, status: 'available', memory_id: 'memory-a' }] },
  chat_complete: { status: 'completed', id: 'chat-a', session_id: 'session-a', message: { role: 'assistant', content: 'ok' }, output_text: 'ok', finish_reason: 'stop', active_memory_patch_ids: ['patch-a'], metadata: { session_id: 'session-a', memory: { enabled: true, profile_id: 'profile-a', active_memory_patch_ids: ['patch-a'] }, memory_runtime: { patchset_revision: 2 } }, memory: { enabled: true, profile_id: 'profile-a', active_memory_patch_ids: ['patch-a'] } },
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf('\\n');
    if (idx < 0) return;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.method === 'notifications/initialized') continue;
    let result = {};
    if (req.method === 'tools/list') result = { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) };
    else if (req.method === 'resources/list') result = { resources: [] };
    else if (req.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify(payloads[req.params.name] || { status: 'ok' }) }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
  }
});
`;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for PTY output');
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function canSpawnPty(): boolean {
  try {
    const child = pty.spawn('/bin/echo', ['ok'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: repoRoot,
      env: process.env,
    });
    child.kill();
    return true;
  } catch {
    return false;
  }
}

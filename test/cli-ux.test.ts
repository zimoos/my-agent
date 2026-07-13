import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

test('CLI UX PTY: full startup shell and editable input appear before a slow Agora runtime is ready', async (t) => {
  if (process.env.MA_RUN_PTY_TESTS !== '1') {
    t.skip('PTY UI verification runs only in the explicit MA_RUN_PTY_TESTS E2E lane');
    return;
  }
  if (!canSpawnPty()) {
    t.skip('node-pty cannot spawn a basic /bin/echo process in this environment');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cli-startup-shell-'));
  const slowAgora = path.join(tmp, 'slow-agora.mjs');
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(slowAgora, `let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',(chunk)=>{buffer+=chunk;while(true){const i=buffer.indexOf('\\n');if(i<0)return;const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line)continue;const req=JSON.parse(line);if(req.method==='notifications/initialized')continue;setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'slow',version:'1'}}})+'\\n'),5000);}});
process.stdin.on('close',()=>process.exit(0));\n`);
  fs.writeFileSync(configPath, JSON.stringify({
    defaultProfile: '',
    model: {
      provider: 'agora', baseURL: 'mcp-stdio://agora', model: 'slow-test', apiKey: 'agora-mcp',
      agoraRuntime: { command: process.execPath, args: [slowAgora] },
    },
    mcpServers: {},
  }));
  const builtCli = path.join(repoRoot, 'dist', 'src', 'cli', 'index.js');
  assert.ok(fs.existsSync(builtCli), 'run npm run build before the explicit PTY release lane');
  const firstFrames: number[] = [];
  const editable: number[] = [];
  const coldRuns = 5;
  const warmRuns = Number.parseInt(process.env.MA_STARTUP_PTY_WARM_RUNS ?? '0', 10) || 0;
  try {
    for (let run = 0; run < coldRuns + warmRuns; run++) {
      const started = performance.now();
      const child = pty.spawn(process.execPath, [builtCli, 'chat', '--config', configPath], {
        name: 'xterm-256color', cols: 100, rows: 24, cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', MA_REDUCED_MOTION: '1' },
      });
      let output = '';
      child.onData((data) => { output += data; });
      try {
        await waitFor(() => /runtime 连接中/.test(stripAnsi(output)) && /❯/.test(stripAnsi(output)), 2000);
        firstFrames.push(performance.now() - started);
        child.write(`queued-${run}`);
        await new Promise((resolve) => setTimeout(resolve, 75));
        child.write('\r');
        await waitFor(() => /首条消息已安全排队/.test(stripAnsi(output)) && new RegExp(`queued-${run}`).test(stripAnsi(output)), 2000);
        editable.push(performance.now() - started);
      } finally {
        child.kill('SIGINT');
      }
    }
    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? Infinity;
    const coldFirstFrames = firstFrames.slice(0, coldRuns);
    const coldEditable = editable.slice(0, coldRuns);
    const warmFirstFrames = firstFrames.slice(coldRuns);
    const warmEditable = editable.slice(coldRuns);
    assert.ok(p95(coldFirstFrames) <= 500, `cold first-frame p95 ${p95(coldFirstFrames).toFixed(1)}ms: ${coldFirstFrames}`);
    assert.ok(p95(coldEditable) <= 1000, `cold editable p95 ${p95(coldEditable).toFixed(1)}ms: ${coldEditable}`);
    if (warmRuns > 0) {
      assert.ok(p95(warmFirstFrames) <= 500, `warm first-frame p95 ${p95(warmFirstFrames).toFixed(1)}ms`);
      assert.ok(p95(warmEditable) <= 1000, `warm editable p95 ${p95(warmEditable).toFixed(1)}ms`);
    }
    const reportDir = path.join(repoRoot, 'test', 'benchmark', 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'issue42-startup-shell.json'), JSON.stringify({
      cold: { runs: coldRuns, firstFrames: coldFirstFrames, editable: coldEditable, firstFrameP95: p95(coldFirstFrames), editableP95: p95(coldEditable) },
      warm: { runs: warmRuns, firstFrames: warmFirstFrames, editable: warmEditable, firstFrameP95: warmRuns > 0 ? p95(warmFirstFrames) : null, editableP95: warmRuns > 0 ? p95(warmEditable) : null },
    }, null, 2));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI UX PTY: Agora startup failure stays in TUI and preserves the current draft', async (t) => {
  if (process.env.MA_RUN_PTY_TESTS !== '1') {
    t.skip('PTY UI verification runs only in the explicit MA_RUN_PTY_TESTS E2E lane');
    return;
  }
  if (!canSpawnPty()) {
    t.skip('node-pty cannot spawn a basic /bin/echo process in this environment');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cli-startup-failure-'));
  const failingAgora = path.join(tmp, 'failing-agora.mjs');
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(failingAgora, 'setTimeout(() => process.exit(23), 500);\n');
  fs.writeFileSync(configPath, JSON.stringify({
    defaultProfile: '',
    model: {
      provider: 'agora', baseURL: 'mcp-stdio://agora', model: 'failure-test', apiKey: 'agora-mcp',
      agoraRuntime: { command: process.execPath, args: [failingAgora] },
    },
    mcpServers: {},
  }));
  const builtCli = path.join(repoRoot, 'dist', 'src', 'cli', 'index.js');
  const child = pty.spawn(process.execPath, [builtCli, 'chat', '--config', configPath], {
    name: 'xterm-256color', cols: 100, rows: 24, cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1', MA_REDUCED_MOTION: '1' },
  });
  let output = '';
  child.onData((data) => { output += data; });
  try {
    await waitFor(() => /runtime 连接中/.test(stripAnsi(output)), 1500);
    child.write('draft-survives');
    await waitFor(() => /启动失败:/.test(stripAnsi(output)), 3000);
    const plain = stripAnsi(output);
    assert.match(plain, /draft-survives/);
    assert.match(plain, /\/retry 重试/);
    assert.match(plain, /\/model 切换 Provider\/模型/);
  } finally {
    child.kill('SIGINT');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI UX PTY: queued startup message auto-sends once after Agora becomes ready', async (t) => {
  if (process.env.MA_RUN_PTY_TESTS !== '1') {
    t.skip('PTY UI verification runs only in the explicit MA_RUN_PTY_TESTS E2E lane');
    return;
  }
  if (!canSpawnPty()) {
    t.skip('node-pty cannot spawn a basic /bin/echo process in this environment');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cli-startup-queue-'));
  const fakeAgora = path.join(tmp, 'delayed-agora.mjs');
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(fakeAgora, fakeAgoraV2Source(900), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    defaultProfile: '',
    model: {
      provider: 'agora', baseURL: 'mcp-stdio://agora', model: 'base-a', apiKey: 'agora-mcp',
      agoraRuntime: { command: process.execPath, args: [fakeAgora] },
    },
    mcpServers: {},
  }));
  const builtCli = path.join(repoRoot, 'dist', 'src', 'cli', 'index.js');
  const child = pty.spawn(process.execPath, [builtCli, 'chat', '--config', configPath], {
    name: 'xterm-256color', cols: 100, rows: 24, cwd: repoRoot,
    env: { ...process.env, NO_COLOR: '1', MA_REDUCED_MOTION: '1' },
  });
  let output = '';
  child.onData((data) => { output += data; });
  try {
    await waitFor(() => /runtime 连接中/.test(stripAnsi(output)), 1500);
    child.write('send-after-ready');
    await new Promise((resolve) => setTimeout(resolve, 75));
    child.write('\r');
    await waitFor(() => /首条消息已安全排队/.test(stripAnsi(output)), 1500);
    await waitFor(() => /queued-auto-response/.test(stripAnsi(output)), 10_000);
  } finally {
    child.kill('SIGINT');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

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
    assert.match(plain, /v0\.3\.0/);
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

function fakeAgoraV2Source(initializeDelayMs = 0): string {
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
  chat_complete: { status: 'completed', id: 'chat-a', session_id: 'session-a', message: { role: 'assistant', content: 'queued-auto-response' }, output_text: 'queued-auto-response', finish_reason: 'stop', active_memory_patch_ids: ['patch-a'], metadata: { session_id: 'session-a', memory: { enabled: true, profile_id: 'profile-a', active_memory_patch_ids: ['patch-a'] }, memory_runtime: { patchset_revision: 2 } }, memory: { enabled: true, profile_id: 'profile-a', active_memory_patch_ids: ['patch-a'] } },
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
    const send = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
    if (req.method === 'initialize' && ${initializeDelayMs} > 0) setTimeout(send, ${initializeDelayMs});
    else send();
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

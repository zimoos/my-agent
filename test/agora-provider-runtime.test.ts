import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgoraMcpError, AgoraProviderRuntime } from '../src/provider/agora.js';
import type { ModelConfig } from '../src/mcp/types.js';

const AGORA_DEV_ROOT = process.env.MA_TEST_AGORA_ROOT || '';
const AGORA_DEV_COMMAND = process.env.MA_TEST_AGORA_COMMAND || '';
const AGORA_DEV_PYTHON = process.env.MA_TEST_AGORA_PYTHON || '';
const AGORA_REAL_MODELS = process.env.MA_TEST_AGORA_REAL_MODELS || '';

const MEMORY_TOOLS = [
  'doctor',
  'models_list',
  'chat_complete',
  'memory_profiles_list',
  'memory_profiles_create',
  'memory_profiles_update',
  'memory_profile_bindings_list',
  'memory_profile_bindings_create',
  'memory_sources_create',
  'memory_sources_list',
  'memory_sources_get',
  'memory_intake_run',
  'memory_intake_get',
  'memory_intake_status',
  'memory_patches_list',
  'memory_lineage_advance',
  'memory_patch_versions',
];

const MEMORY_V2_TOOLS = [
  ...MEMORY_TOOLS,
  'runtime_capabilities',
  'memories_create',
  'memories_get',
  'memories_list',
  'memories_rename',
  'memories_rollback',
  'memory_intake_batch_run',
  'memory_intake_batch_get',
];

function model(): ModelConfig {
  return {
    provider: 'agora',
    baseURL: 'mcp-stdio://agora',
    apiKey: 'agora-mcp',
    model: 'base-a',
    agoraMemory: {
      userId: 'user-a',
      projectId: 'project-a',
      conversationId: 'conv-a',
      memoryProfile: 'profile-a',
    },
  };
}

function runtimeWithFakeCalls(
  calls: Array<{ name: string; args: Record<string, any> }>,
  tools = MEMORY_TOOLS
): AgoraProviderRuntime {
  const runtime = new AgoraProviderRuntime(
    model(),
    { requestTimeoutMs: 5000, streamIdleTimeoutMs: 5000, maxRetries: 0 },
    { sessionId: 'ma-session-a', cwd: '/tmp/project-a' }
  );
  (runtime as any).toolNames = new Set(tools);
  (runtime as any).resources = ['agora://doctor'];
  (runtime as any).doctorPayload = { service: 'agora', status: 'ok' };
  (runtime as any).modelsPayload = { service: 'agora', models: [{ id: 'base-a' }] };
  if (tools.includes('memory_intake_batch_run')) {
    (runtime as any).runtimeContract = {
      runtime_version: '0.2.0-dev',
      registry_schema_version: 3,
      capabilities: {
        named_memories: 1,
        multi_target_intake: 1,
        incremental_segments: 1,
        multi_model_delta_mount: 1,
        request_boundary_hot_swap: 1,
        memory_runtime_v2: 1,
      },
    };
  }
  (runtime as any).ready = async () => {};
  (runtime as any).callJsonTool = async (name: string, args: Record<string, any>) => {
    calls.push({ name, args });
    if (name === 'chat_complete') {
      const profileId = args.metadata?.memory_profile || 'profile-a';
      const patchIds = profileId ? ['patch-a'] : [];
      const toolMode = args.tools && !args.messages?.some((msg: any) => msg.role === 'tool');
      return {
        service: 'agora',
        status: 'completed',
        id: 'chatcmpl_fake',
        model: args.model,
        session_id: 'agora-session-a',
        message: toolMode
          ? {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_a',
                  type: 'function',
                  function: { name: 'test__ping', arguments: '{"value":"from-agora"}' },
                },
              ],
            }
          : { role: 'assistant', content: 'ok' },
        output_text: toolMode ? '' : 'ok',
        finish_reason: toolMode ? 'tool_calls' : 'stop',
        metadata: {
          session_id: 'agora-session-a',
          memory_profile_id: profileId,
          memory: {
            enabled: true,
            reason: patchIds.length ? 'selected' : 'empty',
            profile_id: profileId,
            binding_id: 'binding-a',
            active_memory_patch_ids: patchIds,
          },
          memory_runtime: { patchset_revision: 2 },
        },
        memory: {
          enabled: true,
          reason: patchIds.length ? 'selected' : 'empty',
          profile_id: profileId,
          binding_id: 'binding-a',
          active_memory_patch_ids: patchIds,
        },
        active_memory_patch_ids: patchIds,
      };
    }
    if (name === 'memory_profiles_list') return {
      service: 'agora',
      status: 'ok',
      profiles: [{
        id: 'profile-a',
        name: 'Profile A',
        base_model_id: 'base-a',
        active_memory_patch_ids: ['patch-a'],
        auto_intake_target_memory_ids: ['memory-a'],
        writable_patch_family: 'project-memory',
        auto_intake_policy: { enabled: true, activation_mode: 'auto' },
      }],
    };
    if (name === 'memory_patches_list') return {
      service: 'agora',
      status: 'ok',
      patches: [{
        id: 'patch-a',
        name: 'Patch A',
        base_model_id: 'base-a',
        family: 'project-memory',
        version: 'v1',
        mountable: true,
        status: 'available',
        memory_id: 'memory-a',
      }],
    };
    if (name === 'memories_list') return {
      service: 'agora',
      status: 'ok',
      memories: [{ id: 'memory-a', name: '产品记忆', base_model_id: 'base-a', head_patch_id: 'patch-a', status: 'available' }],
    };
    if (name === 'memories_get') return { service: 'agora', status: 'ok', memory: { id: args.memory_id, name: '产品记忆', base_model_id: 'base-a', head_patch_id: 'patch-a', status: 'available' } };
    if (name === 'memories_create') return { service: 'agora', status: 'ok', memory: { id: 'memory-new', name: args.name, base_model_id: args.base_model_id, head_patch_id: null, status: 'available' } };
    if (name === 'memories_rename') return { service: 'agora', status: 'ok', memory: { id: args.memory_id, name: args.name, base_model_id: 'base-a', head_patch_id: 'patch-a', status: 'available' } };
    if (name === 'memories_rollback') return { service: 'agora', status: 'ok', memory: { id: args.memory_id, name: '产品记忆', base_model_id: 'base-a', head_patch_id: args.target_patch_id, status: 'available' } };
    if (name === 'memory_profiles_create') return { service: 'agora', status: 'available', profile: { id: args.id } };
    if (name === 'memory_profiles_update') return { service: 'agora', status: 'available', profile: { id: args.profile_id } };
    if (name === 'memory_profile_bindings_list') return { service: 'agora', status: 'ok', bindings: [] };
    if (name === 'memory_profile_bindings_create') return { service: 'agora', status: 'ok', binding: { id: 'binding-a' } };
    if (name === 'memory_intake_run') {
      return {
        service: 'agora',
        status: 'completed',
        job_id: 'job-a',
        source_id: 'source-a',
        output_memory_patch_id: 'patch-a',
        job: {
          id: 'job-a',
          output_memory_patch_id: 'patch-a',
          result: { lineage: { family: 'project-memory', previous_patch_id: 'patch-a' } },
        },
      };
    }
    if (name === 'memory_intake_get') {
      return {
        service: 'agora',
        status: 'completed',
        job_id: args.job_id,
        source_id: 'source-a',
        output_memory_patch_id: 'patch-a',
        job: {
          id: args.job_id,
          output_memory_patch_id: 'patch-a',
          result: { lineage: { family: 'project-memory', previous_patch_id: 'patch-a' } },
        },
      };
    }
    if (name === 'memory_intake_batch_run' || name === 'memory_intake_batch_get') {
      const targets = (name === 'memory_intake_batch_run' ? args.targets : [{ mode: 'increment', memory_id: 'memory-a', output_name: '产品记忆@v2' }])
        .map((target: any, index: number) => ({
          id: `target-${index}`,
          batch_id: 'batch-a',
          ...target,
          status: 'completed',
          output_patch_id: 'patch-a',
        }));
      return { service: 'agora', status: 'completed', batch_id: 'batch-a', batch: { id: 'batch-a', status: 'completed' }, targets };
    }
    if (name === 'memory_lineage_advance') {
      return { service: 'agora', status: 'activated', active_memory_patch_ids: ['patch-a'] };
    }
    if (name === 'memory_patch_versions') return { service: 'agora', status: 'ok', patches: [{ id: 'patch-a' }, { id: 'patch-previous' }] };
    return { service: 'agora', status: 'ok' };
  };
  return runtime;
}

async function collect(iterable: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function writeFakeAgoraModelRuntime(fakeModulesDir: string): void {
  const mlxLmDir = path.join(fakeModulesDir, 'mlx_lm');
  const mlxLmModelsDir = path.join(mlxLmDir, 'models');
  fs.mkdirSync(mlxLmDir, { recursive: true });
  fs.mkdirSync(mlxLmModelsDir, { recursive: true });
  fs.writeFileSync(
    path.join(mlxLmDir, '__init__.py'),
    `
from __future__ import annotations


class FakeLayer:
    def __call__(self, hidden, *args, **kwargs):
        return hidden


class FakeModel:
    def __init__(self):
        self.layers = [FakeLayer() for _ in range(80)]

    def __call__(self, tokens, *args, **kwargs):
        import mlx.core as mx

        scale = mx.sum(tokens.astype(mx.float32)) * 0.001
        hidden = mx.sin(mx.arange(1, 9, dtype=mx.float32) * scale)[None, None, :]
        for layer in self.layers:
            hidden = layer(hidden)
        return hidden


class FakeTokenizer:
    eos_token_ids = []

    def apply_chat_template(self, messages, **kwargs):
        return "\\n".join(f"{message.get('role', 'user')}: {message.get('content', '')}" for message in messages)

    def encode(self, text, add_special_tokens=False):
        return [ord(char) for char in str(text)]

    def decode(self, token_ids):
        return "".join(chr(int(token_id)) for token_id in token_ids)


class FakeStreamResponse:
    def __init__(self, text):
        self.text = text


def load(path, **kwargs):
    return FakeModel(), FakeTokenizer()


def generate(model, tokenizer, prompt, **kwargs):
    return "fake Agora no-port chat response"


def stream_generate(model, tokenizer, prompt, **kwargs):
    yield FakeStreamResponse("fake Agora ")
    yield FakeStreamResponse("no-port chat response")
`.trimStart(),
    'utf8'
  );
  fs.writeFileSync(
    path.join(mlxLmDir, 'generate.py'),
    `
from __future__ import annotations


def make_sampler(**kwargs):
    return lambda logits: logits


def generate_step(tokens, model, max_tokens=0, sampler=None, logits_processors=None, **kwargs):
    import mlx.core as mx

    try:
        model(tokens[None])
    except Exception:
        try:
            model(mx.array([list(tokens)]))
        except Exception:
            pass

    text = "fake Agora no-port chat response"
    limit = max(0, int(max_tokens or 0))
    for idx in range(limit):
        logits = mx.zeros((1, 70000), dtype=mx.float32)
        for processor in logits_processors or []:
            logits = processor(tokens, logits)
        logprobs = logits[0]
        if callable(sampler):
            token = sampler(logprobs)
        else:
            token = mx.array([ord(text[idx % len(text)])])
        yield token, logprobs
`.trimStart(),
    'utf8'
  );
  fs.writeFileSync(path.join(mlxLmModelsDir, '__init__.py'), '', 'utf8');
  fs.writeFileSync(
    path.join(mlxLmModelsDir, 'cache.py'),
    `
from __future__ import annotations


def make_prompt_cache(*args, **kwargs):
    return []


def load_prompt_cache(*args, **kwargs):
    if kwargs.get("return_metadata"):
        return [], {}
    return []


def save_prompt_cache(*args, **kwargs):
    return None
`.trimStart(),
    'utf8'
  );
}

function seedAgoraMemoryE2eCatalog(dataRoot: string): void {
  const seedCode = `
from __future__ import annotations

import json
from pathlib import Path

from agora_lab.paths import DB_PATH
from agora_lab.registry import Registry
from agora_lab.schemas import BaseModelRecord


root = Path(DB_PATH).parent
model_dir = root / "models" / "Qwen2.5-7B-Instruct"
model_dir.mkdir(parents=True, exist_ok=True)
(model_dir / "config.json").write_text("{}", encoding="utf-8")
registry = Registry(DB_PATH)
registry.upsert_base_model(
    BaseModelRecord(
        id="qwen2.5-7b-fp16",
        name="qwen2.5-7b-fp16",
        provider="mlx",
        model_path="models/Qwen2.5-7B-Instruct",
        quantization="none",
        context_length=32768,
        precision="fp16",
        status="available",
        trainable=True,
        runnable=True,
        family="qwen",
        architecture="dense",
    )
)
`;
  const pythonPath = [AGORA_DEV_ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  execFileSync(AGORA_DEV_PYTHON, ['-c', seedCode], {
    cwd: AGORA_DEV_ROOT,
    env: {
      ...process.env,
      AGORA_DATA_ROOT: dataRoot,
      PYTHONPATH: pythonPath,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    },
    stdio: 'pipe',
  });
}

function readAgoraRuntimeSessionStats(dataRoot: string, sessionId: string): {
  messageCount: number;
  userMessages: number;
  rawLength: number;
} {
  const code = `
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

data_root = Path(sys.argv[1])
session_id = sys.argv[2]
db_path = data_root / "agora.sqlite3"
conn = sqlite3.connect(db_path)
row = conn.execute("select messages from runtime_sessions where id = ?", (session_id,)).fetchone()
if row is None:
    raise SystemExit(f"session not found: {session_id}")
messages_raw = row[0]
messages = json.loads(messages_raw)
print(json.dumps({
    "messageCount": len(messages),
    "userMessages": sum(1 for message in messages if message.get("role") == "user"),
    "rawLength": len(messages_raw),
}))
`;
  const out = execFileSync(AGORA_DEV_PYTHON, ['-c', code, dataRoot, sessionId], {
    cwd: AGORA_DEV_ROOT,
    env: {
      ...process.env,
      AGORA_DATA_ROOT: dataRoot,
      PYTHONPATH: [AGORA_DEV_ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return JSON.parse(out);
}

test('agora provider runtime wraps non-streaming chat_complete as streaming chunks and captures providerState', async () => {
  const calls: Array<{ name: string; args: Record<string, any> }> = [];
  const runtime = runtimeWithFakeCalls(calls);

  assert.ok(runtime.getMemoryController(), 'memory controller should be exposed when all memory tools exist');
  const stream = await runtime.createStreamingChatCompletion({
    model: 'base-a',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    tools: [
      {
        type: 'function',
        function: {
          name: 'test__ping',
          description: 'ping',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    tool_choice: 'auto',
  });
  const chunks = await collect(stream);

  assert.equal(calls[0].name, 'chat_complete');
  assert.deepEqual(calls[0].args.metadata, {
    user_id: 'user-a',
    project_id: 'project-a',
    conversation_id: 'conv-a',
    memory_profile: 'profile-a',
  });
  assert.equal(calls[0].args.max_tokens, 4096);
  assert.equal(calls[0].args.timeout_seconds, 5);
  assert.equal(calls[0].args.session_history_mode, 'replace');
  const promptText = JSON.stringify(calls[0].args.messages);
  assert.doesNotMatch(promptText, /profile-a/);
  assert.doesNotMatch(promptText, /memory_profile/);
  assert.doesNotMatch(promptText, /memory_enabled/);
  assert.equal(chunks.some((chunk) => chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === 'test__ping'), true);
  assert.equal(runtime.getProviderState()?.agora_session_id, 'agora-session-a');
  assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, ['patch-a']);
  assert.equal(runtime.getProviderState()?.memory?.runtime_message_count, 1);
});

test('agora provider runtime exposes granular capability gaps without disabling chat', async () => {
  const runtime = runtimeWithFakeCalls([], ['doctor', 'models_list', 'chat_complete']);
  assert.ok(runtime.getMemoryController());
  assert.equal(runtime.getCapabilities().chat, true);
  assert.equal(runtime.getCapabilities().profileRead, false);
  assert.equal(runtime.getCapabilities().intake, false);
});

test('agora memory internalize queues intake without blocking or overwriting overlays', async () => {
  const calls: Array<{ name: string; args: Record<string, any> }> = [];
  const runtime = runtimeWithFakeCalls(calls);
  await runtime.createChatCompletion({
    model: 'base-a',
    messages: [{ role: 'user', content: '利博是我的同事。' }],
    stream: false,
  });

  const result = await runtime.internalize({ profile_id: 'profile-a' });
  assert.equal(result.isError, false);
  const payload = JSON.parse(result.content);
  assert.equal(payload.status, 'queued');
  assert.equal(payload.job_id, 'job-a');
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      'chat_complete',
      'memory_profiles_list',
      'memory_patches_list',
      'memory_intake_run',
    ]
  );
  assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, ['patch-a']);
});

test('agora profile switch persists project/session scope and waits for a real chat boundary', async () => {
  const calls: Array<{ name: string; args: Record<string, any> }> = [];
  const runtime = runtimeWithFakeCalls(calls);

  const project = await runtime.selectProfile('profile-a');
  assert.equal(project.mount_status, 'pending_next_chat');
  assert.equal(calls.some((call) => call.name === 'chat_complete'), false);
  assert.deepEqual(
    calls.find((call) => call.name === 'memory_profile_bindings_create')?.args,
    {
      profile_id: 'profile-a',
      scope_type: 'project',
      user_id: 'user-a',
      project_id: 'project-a',
    }
  );

  calls.length = 0;
  const conversation = await runtime.selectProfile('profile-a', 'conversation');
  assert.equal(conversation.scope, 'conversation');
  assert.equal(calls.some((call) => call.name === 'chat_complete'), false);
  assert.equal(
    calls.find((call) => call.name === 'memory_profile_bindings_create')?.args.conversation_id,
    'conv-a'
  );
});

test('agora memory v2 requires both tools and granular runtime capabilities', () => {
  const runtime = runtimeWithFakeCalls([], MEMORY_V2_TOOLS);
  assert.equal(runtime.getCapabilities().memoryV2, true);
  assert.equal(runtime.getCapabilities().runtimeMode, 'v2');
  (runtime as any).runtimeContract.capabilities.request_boundary_hot_swap = 0;
  assert.equal(runtime.getCapabilities().memoryV2, false);
  assert.equal(runtime.getCapabilities().runtimeMode, 'legacy');
});

test('agora memory v2 mounts named memories without writable family and verifies on chat boundary', async () => {
  const calls: Array<{ name: string; args: Record<string, any> }> = [];
  const runtime = runtimeWithFakeCalls(calls, MEMORY_V2_TOOLS);

  const mounted = await runtime.mountMemories('profile-a', ['memory-a'], 'project');
  assert.equal(mounted.mount_status, 'pending_next_chat');
  assert.equal(runtime.getProviderState()?.memory?.status, 'pending');
  const update = calls.find((call) => call.name === 'memory_profiles_update');
  assert.deepEqual(update?.args.active_memory_patch_ids, ['patch-a']);
  assert.equal('writable_patch_family' in (update?.args ?? {}), false);
  assert.equal(calls.some((call) => call.name === 'chat_complete'), false);

  await runtime.createChatCompletion({
    model: 'base-a',
    messages: [{ role: 'user', content: 'verify mount' }],
    stream: false,
  });
  assert.equal(runtime.getProviderState()?.memory?.status, 'mounted');
  assert.equal(runtime.getProviderState()?.memory?.patchset_revision, 2);
  assert.equal(runtime.getProviderState()?.memory?.mounted_memories?.[0]?.memory_name, '产品记忆');
});

test('agora memory v2 conversation override uses an isolated profile and does not overwrite project default', async () => {
  const calls: Array<{ name: string; args: Record<string, any> }> = [];
  const runtime = runtimeWithFakeCalls(calls, MEMORY_V2_TOOLS);
  const result = await runtime.mountMemories('profile-a', ['memory-a'], 'conversation');
  assert.equal(result.profile_id, 'profile-a--conversation-conv-a');
  const created = calls.find((call) => call.name === 'memory_profiles_create');
  assert.equal(created?.args.id, 'profile-a--conversation-conv-a');
  const binding = calls.find((call) => call.name === 'memory_profile_bindings_create');
  assert.equal(binding?.args.scope_type, 'conversation');
  assert.equal(binding?.args.conversation_id, 'conv-a');
  assert.equal(calls.some((call) => call.name === 'memory_profiles_update' && call.args.profile_id === 'profile-a'), false);
});

test('agora memory v2 submits one mixed batch and never calls legacy intake or lineage advance', async () => {
  const calls: Array<{ name: string; args: Record<string, any> }> = [];
  const runtime = runtimeWithFakeCalls(calls, MEMORY_V2_TOOLS);
  await runtime.createChatCompletion({
    model: 'base-a',
    messages: [{ role: 'user', content: 'source' }],
    stream: false,
  });
  calls.length = 0;
  const result = await runtime.internalize({
    source_message_start: 0,
    source_message_end: 1,
    targets: [
      { mode: 'create', name: '新记忆', output_name: '新记忆@v1' },
      { mode: 'increment', memory_id: 'memory-a', expected_parent_patch_id: 'patch-a', output_name: '产品记忆@v2' },
    ],
  });
  assert.equal(result.isError, false, result.content);
  assert.equal(JSON.parse(result.content).batch_id, 'batch-a');
  assert.deepEqual(calls.map((call) => call.name), ['memory_intake_batch_run']);
  assert.equal(calls.some((call) => ['memory_intake_run', 'memory_lineage_advance'].includes(call.name)), false);
  assert.equal(calls[0].args.targets.length, 2);
});

test('agora memory v2 preserves explicit auto targets on the profile', async () => {
  const calls: Array<{ name: string; args: Record<string, any> }> = [];
  const runtime = runtimeWithFakeCalls(calls, MEMORY_V2_TOOLS);
  await runtime.setAutoPolicy('profile-a', true, ['memory-a']);
  const update = calls.find((call) => call.name === 'memory_profiles_update');
  assert.deepEqual(update?.args.auto_intake_target_memory_ids, ['memory-a']);
  assert.equal(update?.args.auto_intake_policy.enabled, true);
});

test('agora memory v2 does not claim mounted when PatchSet revision fails to advance', async () => {
  const runtime = runtimeWithFakeCalls([], MEMORY_V2_TOOLS);
  (runtime as any).lastState = {
    provider_id: 'agora',
    memory: { status: 'mounted', active_memory_patch_ids: ['patch-old'], patchset_revision: 2 },
  };
  (runtime as any).markPatchSelectionPending('profile-a', ['patch-a']);
  await runtime.createChatCompletion({
    model: 'base-a',
    messages: [{ role: 'user', content: 'stale revision' }],
    stream: false,
  });
  assert.equal(runtime.getProviderState()?.memory?.status, 'stale');
  assert.deepEqual(runtime.getProviderState()?.memory?.requested_memory_patch_ids, ['patch-a']);
});

const agoraDevE2eTest = fs.existsSync(AGORA_DEV_COMMAND) && fs.existsSync(AGORA_DEV_PYTHON)
  ? test
  : test.skip;

const agoraPackagedE2eTest = fs.existsSync(AGORA_DEV_COMMAND) && fs.existsSync(AGORA_REAL_MODELS)
  ? test
  : test.skip;

agoraPackagedE2eTest('packaged Agora serves a real whitelist model over MCP stdio', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-agora-packaged-e2e-'));
  const dataRoot = path.join(tmp, 'agora-data');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.symlinkSync(path.resolve(AGORA_REAL_MODELS), path.join(dataRoot, 'models'));
  let runtime: AgoraProviderRuntime | null = null;
  try {
    runtime = new AgoraProviderRuntime(
      {
        provider: 'agora',
        baseURL: 'mcp-stdio://agora',
        apiKey: 'agora-mcp',
        model: 'qwen2.5-7b-fp16',
        agoraRuntime: {
          command: AGORA_DEV_COMMAND,
          args: ['mcp', 'serve'],
          dataRoot,
          env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
        },
        agoraMemory: {
          userId: 'user-packaged-e2e',
          projectId: 'my-agent',
          conversationId: 'conv-packaged-e2e',
        },
      },
      { requestTimeoutMs: 30000, streamIdleTimeoutMs: 30000, maxRetries: 0 },
      { sessionId: 'ma-packaged-e2e-session', cwd: tmp }
    );
    await runtime.ready();
    assert.ok((await runtime.listModels()).some((item) => item.id === 'qwen2.5-7b-fp16'));
    assert.equal(runtime.getCapabilities().memoryV2, true);
    const before = await (runtime as any).chatCompletePayload({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '利博是我的同事，请记住。' }],
      stream: false,
      max_tokens: 2,
      temperature: 0,
    } as any);
    assert.ok(runtime.getProviderState()?.agora_session_id);
    const controller = runtime.getMemoryController();
    assert.ok(controller);
    const submitted = await controller.startBatchIntake({
      targets: [{ mode: 'create', name: 'Packaged E2E Memory', output_name: 'Packaged E2E Memory@v1' }],
    });
    let batch = submitted;
    for (let index = 0; index < 300; index++) {
      batch = await controller.getBatchIntake(submitted.batch_id);
      if (batch.targets.every((target) => ['completed', 'noop', 'review', 'conflict', 'failed'].includes(target.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(batch.targets[0]?.status, 'completed', JSON.stringify(batch));
    const memory = (await controller.listMemories()).find((item) => item.name === 'Packaged E2E Memory');
    assert.ok(memory);
    await controller.mountMemories('profile-packaged-e2e', [memory.id]);
    const after = await (runtime as any).chatCompletePayload({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '我的同事是谁？' }],
      stream: false,
      max_tokens: 8,
      temperature: 0,
    } as any);
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, [memory.head_patch_id]);
    assert.equal(after.metadata?.memory_runtime?.base_model_object_id, before.metadata?.memory_runtime?.base_model_object_id);
    assert.equal(after.metadata?.memory_runtime?.model_load_count, before.metadata?.memory_runtime?.model_load_count);
  } finally {
    await runtime?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

agoraDevE2eTest('agora provider runtime uses real v2 MCP stdio for named Memory, batch intake, hot mount, rollback, and disable', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-agora-provider-e2e-'));
  const dataRoot = path.join(tmp, 'agora-data');
  const fakeModules = path.join(tmp, 'fake-model-runtime');
  let runtime: AgoraProviderRuntime | null = null;
  try {
    writeFakeAgoraModelRuntime(fakeModules);
    seedAgoraMemoryE2eCatalog(dataRoot);
    const pythonPath = [fakeModules, AGORA_DEV_ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    runtime = new AgoraProviderRuntime(
      {
        provider: 'agora',
        baseURL: 'mcp-stdio://agora',
        apiKey: 'agora-mcp',
        model: 'qwen2.5-7b-fp16',
        agoraRuntime: {
          command: AGORA_DEV_COMMAND,
          args: ['mcp', 'serve'],
          dataRoot,
          env: {
            PYTHONPATH: pythonPath,
            HF_HUB_OFFLINE: '1',
            TRANSFORMERS_OFFLINE: '1',
          },
        },
        agoraMemory: {
          userId: 'user-e2e',
          projectId: 'my-agent',
          conversationId: 'conv-e2e',
        },
      },
      { requestTimeoutMs: 30000, streamIdleTimeoutMs: 30000, maxRetries: 0 },
      { sessionId: 'ma-e2e-session', cwd: tmp }
    );
    await runtime.ready();
    const controller = runtime.getMemoryController();
    assert.ok(controller, 'real Agora MCP runtime must expose memory controller');
    assert.equal(controller.getCapabilities().memoryV2, true);
    await controller.createMemory('Unique Name Guard');
    await assert.rejects(
      () => controller.createMemory('Unique Name Guard'),
      (err: unknown) => err instanceof AgoraMcpError && err.code === 'memory_name_conflict' && err.field === 'name'
    );

    await runtime.createChatCompletion({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '利博是我的同事。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    assert.ok(runtime.getProviderState()?.agora_session_id, 'chat turn must establish Agora session id');
    await assert.rejects(
      () => controller.startBatchIntake({
        targets: [
          { mode: 'create', name: 'Conflict A', output_name: 'Duplicate Output' },
          { mode: 'create', name: 'Conflict B', output_name: 'Duplicate Output' },
        ],
      }),
      (err: unknown) => err instanceof AgoraMcpError && err.code === 'memory_patch_name_conflict' && err.field === 'output_name'
    );

    const submitted = await controller.startBatchIntake({
      targets: [
        { mode: 'create', name: 'MA E2E Memory', output_name: 'MA E2E Memory@v1' },
        { mode: 'create', name: 'MA E2E Overlay', output_name: 'MA E2E Overlay@v1' },
        { mode: 'create', name: 'MA E2E Preferences', output_name: 'MA E2E Preferences@v1' },
      ],
    });
    let finalized = submitted;
    for (let i = 0; i < 120; i++) {
      finalized = await controller.getBatchIntake(submitted.batch_id);
      if (finalized.targets.every((target) => ['completed', 'noop', 'review', 'conflict', 'failed'].includes(target.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(finalized.targets.map((target) => target.status), ['completed', 'completed', 'completed'], JSON.stringify(finalized));
    const patchV1 = String(finalized.targets.find((target) => target.memory_name === 'MA E2E Memory')?.output_patch_id);
    const overlayPatch = String(finalized.targets.find((target) => target.memory_name === 'MA E2E Overlay')?.output_patch_id);
    const preferencesPatch = String(finalized.targets.find((target) => target.memory_name === 'MA E2E Preferences')?.output_patch_id);
    const listedMemories = await controller.listMemories();
    const memory = listedMemories.find((item) => item.name === 'MA E2E Memory');
    const overlay = listedMemories.find((item) => item.name === 'MA E2E Overlay');
    const preferences = listedMemories.find((item) => item.name === 'MA E2E Preferences');
    assert.ok(memory);
    assert.ok(overlay);
    assert.ok(preferences);

    const mounted = await controller.mountMemories('profile-e2e', [memory.id]);
    assert.equal(mounted.mount_status, 'pending_next_chat');
    assert.equal(runtime.getProviderState()?.memory?.status, 'pending');
    const mcpInstance = (runtime as any).mcp;
    const verifiedA = await (runtime as any).chatCompletePayload({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '先验证单记忆挂载。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, [patchV1]);
    assert.equal(runtime.getProviderState()?.memory?.mounted_memories?.[0]?.memory_name, 'MA E2E Memory');
    assert.equal((runtime as any).mcp, mcpInstance, 'patch mount must not restart Agora subprocess');
    const baseObjectId = verifiedA.metadata?.memory_runtime?.base_model_object_id;
    const loadCount = verifiedA.metadata?.memory_runtime?.model_load_count;

    await controller.mountMemories('profile-e2e', [memory.id, overlay.id, preferences.id]);
    const verifiedABC = await (runtime as any).chatCompletePayload({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '小明的新项目代号是海鸥，请记住。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, [patchV1, overlayPatch, preferencesPatch]);
    assert.equal(verifiedABC.metadata?.memory_runtime?.base_model_object_id, baseObjectId);
    assert.equal(verifiedABC.metadata?.memory_runtime?.model_load_count, loadCount);

    const secondBatch = await controller.startBatchIntake({
      targets: [{
        mode: 'increment',
        memory_id: memory.id,
        expected_parent_patch_id: patchV1,
        output_name: 'MA E2E Memory@v2',
      }],
    });
    let second = secondBatch;
    for (let i = 0; i < 120; i++) {
      second = await controller.getBatchIntake(secondBatch.batch_id);
      if (second.targets.every((target) => ['completed', 'noop', 'review', 'conflict', 'failed'].includes(target.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(second.targets[0]?.status, 'completed', JSON.stringify(second));
    const patchV2 = String(second.targets[0]?.output_patch_id);
    await controller.applyCompletedBatch(second, 'profile-e2e');
    const verifiedV2 = await (runtime as any).chatCompletePayload({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '增量后继续。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, [patchV2, overlayPatch, preferencesPatch]);
    assert.equal(verifiedV2.metadata?.memory_runtime?.base_model_object_id, baseObjectId);
    assert.equal(verifiedV2.metadata?.memory_runtime?.model_load_count, loadCount);

    await controller.mountMemories('profile-e2e', [overlay.id, preferences.id]);
    await runtime.createChatCompletion({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '拔出主记忆后继续。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, [overlayPatch, preferencesPatch]);

    await controller.rollbackMemory(memory.id, patchV2, patchV1);
    await controller.mountMemories('profile-e2e', [memory.id, overlay.id]);
    await runtime.createChatCompletion({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '回滚后继续。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, [patchV1, overlayPatch]);

    const disabled = await controller.disable({ profile_id: 'profile-e2e' });
    assert.equal(disabled.isError, false, disabled.content);
    assert.equal(JSON.parse(disabled.content).mount_status, 'pending_next_chat');
    await runtime.createChatCompletion({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '禁用记忆后继续。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, []);
    assert.equal(runtime.getProviderState()?.memory?.status, 'disabled');

    const sessionId = runtime.getProviderState()?.agora_session_id;
    assert.ok(sessionId, 'chat turn must establish Agora session id');
    await runtime.createChatCompletion({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '第一次窗口。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    await runtime.createChatCompletion({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '第二次请求不能重复追加第一次完整窗口。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    const sessionStats = readAgoraRuntimeSessionStats(dataRoot, sessionId);
    assert.equal(sessionStats.userMessages, 1, 'Agora session history must replace host-provided full windows');
    assert.ok(sessionStats.messageCount <= 3, `Agora session history grew unexpectedly: ${JSON.stringify(sessionStats)}`);
  } finally {
    await runtime?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

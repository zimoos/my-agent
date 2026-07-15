import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgoraProviderRuntime } from '../src/provider/agora.js';
import type { ModelConfig } from '../src/mcp/types.js';

const AGORA_DEV_ROOT = '/Users/zhuqingyu/dev/agora';
const AGORA_DEV_COMMAND = path.join(AGORA_DEV_ROOT, '.venv/bin/agora');
const AGORA_DEV_PYTHON = path.join(AGORA_DEV_ROOT, '.venv/bin/python');

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
  'memory_patch_versions',
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
    if (name === 'memory_profiles_list') return { service: 'agora', status: 'ok', profiles: [] };
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
        job: { id: 'job-a', output_memory_patch_id: 'patch-a' },
      };
    }
    if (name === 'memory_intake_get') {
      return {
        service: 'agora',
        status: 'completed',
        job_id: args.job_id,
        source_id: 'source-a',
        output_memory_patch_id: 'patch-a',
        job: { id: args.job_id, output_memory_patch_id: 'patch-a' },
      };
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
        import hashlib
        import mlx.core as mx
        import numpy as np

        values = np.zeros((1, 1, 4096), dtype="float32")
        token_values = np.array(tokens).reshape(-1).astype("int64")
        digest = hashlib.sha256(token_values.tobytes()).digest()
        bucket = int.from_bytes(digest[:4], "little") % 4096
        values[0, 0, bucket] = 1.0
        hidden = mx.array(values)
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

import numpy as np

from agora_lab.paths import DB_PATH
from agora_lab.registry import Registry
from agora_lab.schemas import BaseModelRecord, MemoryPatchRecord, MemoryRecord


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
patch_dir = root / "patch-old"
patch_dir.mkdir(parents=True, exist_ok=True)
np.savez_compressed(
    patch_dir / "arrays.npz",
    positive=np.ones(4096, dtype="float32"),
    negative=-np.ones(4096, dtype="float32"),
    step=np.array([8.0, 8.0], dtype="float32"),
)
patch_manifest = patch_dir / "manifest.json"
patch_manifest.write_text(
    json.dumps(
        {
            "kind": "multifact_trainable_sequence_memory_patch_v1",
            "base_model_id": "qwen2.5-7b-fp16",
            "facts": [
                {
                    "id": "fact-old",
                    "target_text": "利博是我的同事。",
                    "target_token_ids": [100, 101],
                    "step_biases_array_key": "step",
                    "gate": {
                        "layer": 39,
                        "event": 0,
                        "threshold": 0.0,
                        "positive_array_keys": ["positive"],
                        "negative_array_keys": ["negative"],
                    },
                }
            ],
        }
    ),
    encoding="utf-8",
)
patch_eval = patch_dir / "eval_report.json"
patch_eval.write_text(json.dumps({"status": "seeded"}), encoding="utf-8")
registry.upsert_memory_patch(
    MemoryPatchRecord(
        id="patch-old",
        name="patch-old",
        base_model_id="qwen2.5-7b-fp16",
        patch_type="model_delta",
        compiler_backend="model_delta",
        artifact_path=str(patch_dir),
        manifest_path=str(patch_manifest),
        eval_report_path=str(patch_eval),
        status="experimental",
        family="ma-e2e-memory",
        version="0.0.0-old",
        source_ids=["seed-source"],
        mountable=True,
    )
)
registry.create_memory(
    MemoryRecord(
        id="mem-seeded-e2e",
        name="Seeded MA E2E Memory",
        normalized_name="seeded ma e2e memory",
        base_model_id="qwen2.5-7b-fp16",
    )
)
seeded_v1 = MemoryPatchRecord(
    id="patch-seeded-v1",
    name="Seeded MA E2E Memory@v1",
    base_model_id="qwen2.5-7b-fp16",
    patch_type="model_delta",
    compiler_backend="model_delta",
    artifact_path=str(patch_dir),
    manifest_path=str(patch_manifest),
    eval_report_path=str(patch_eval),
    status="experimental",
    family="mem-seeded-e2e",
    version="v1",
    source_ids=["seed-source-v1"],
    mountable=True,
    memory_id="mem-seeded-e2e",
    normalized_name="seeded ma e2e memory@v1",
)
registry.upsert_memory_patch(seeded_v1)
registry.advance_memory_head(
    memory_id="mem-seeded-e2e",
    expected_parent_patch_id=None,
    new_patch_id=seeded_v1.id,
)
seeded_v2 = MemoryPatchRecord(
    id="patch-seeded-v2",
    name="Seeded MA E2E Memory@v2",
    base_model_id="qwen2.5-7b-fp16",
    patch_type="model_delta",
    compiler_backend="model_delta",
    artifact_path=str(patch_dir),
    manifest_path=str(patch_manifest),
    eval_report_path=str(patch_eval),
    status="experimental",
    family="mem-seeded-e2e",
    version="v2",
    source_ids=["seed-source-v2"],
    mountable=True,
    memory_id="mem-seeded-e2e",
    normalized_name="seeded ma e2e memory@v2",
    parent_patch_id=seeded_v1.id,
)
registry.upsert_memory_patch(seeded_v2)
registry.advance_memory_head(
    memory_id="mem-seeded-e2e",
    expected_parent_patch_id=seeded_v1.id,
    new_patch_id=seeded_v2.id,
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
});

test('agora provider runtime keeps a capability-reporting host controller when memory MCP tools are missing', async () => {
  const runtime = runtimeWithFakeCalls([], ['doctor', 'models_list', 'chat_complete']);
  const controller = runtime.getMemoryController();
  assert.ok(controller);
  assert.equal(controller.getCapabilities().runtimeMode, 'unavailable');
});

test('agora memory internalize waits for the next real chat response metadata before marking the mount verified', async () => {
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
  assert.equal(payload.output_memory_patch_id, 'patch-a');
  assert.equal(payload.mount_status, 'pending_next_chat');
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      'chat_complete',
      'memory_intake_run',
      'memory_profiles_list',
      'memory_profiles_create',
      'memory_profile_bindings_list',
      'memory_profile_bindings_create',
    ]
  );
  assert.equal(runtime.getProviderState()?.memory?.status, 'pending');

  await runtime.createChatCompletion({
    model: 'base-a',
    messages: [{ role: 'user', content: '下一次真实业务请求。' }],
    stream: false,
  });
  assert.equal(calls.at(-1)?.args.metadata.memory_profile, 'profile-a');
  assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, ['patch-a']);
});

const agoraDevE2eTest = fs.existsSync(AGORA_DEV_COMMAND) && fs.existsSync(AGORA_DEV_PYTHON)
  ? test
  : test.skip;

agoraDevE2eTest('agora provider runtime uses real MCP stdio for mount, internalize, rollback, and disable', async () => {
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

    if (controller.getCapabilities().memoryV2) {
      await runtime.createChatCompletion({
        model: 'qwen2.5-7b-fp16',
        messages: [{ role: 'user', content: '利博是我的同事。' }],
        stream: false,
        max_tokens: 8,
      } as any);
      const submitted = await controller.startBatchIntake({
        targets: [{ mode: 'create', name: 'MA E2E Memory', output_name: 'MA E2E Memory@v1' }],
      });
      let finalized = submitted;
      for (let i = 0; i < 120; i++) {
        finalized = await controller.getBatchIntake(submitted.batch_id);
        if (finalized.targets.every((target) => ['completed', 'noop', 'review', 'conflict', 'failed'].includes(target.status))) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(finalized.targets[0]?.status, 'completed', JSON.stringify(finalized));
      const patchV1 = String(finalized.targets[0]?.output_patch_id);
      const memory = (await controller.listMemories()).find((item) => item.name === 'MA E2E Memory');
      assert.ok(memory);
      await controller.mountMemories('profile-e2e', [memory.id]);
      await runtime.createChatCompletion({
        model: 'qwen2.5-7b-fp16',
        messages: [{ role: 'user', content: '验证第一版记忆。' }],
        stream: false,
        max_tokens: 8,
      } as any);
      assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, [patchV1]);

      const seededMemory = (await controller.listMemories()).find((item) => item.id === 'mem-seeded-e2e');
      assert.ok(seededMemory);
      await controller.mountMemories('profile-e2e', [seededMemory.id]);
      await runtime.createChatCompletion({
        model: 'qwen2.5-7b-fp16',
        messages: [{ role: 'user', content: '验证第二版记忆。' }],
        stream: false,
        max_tokens: 8,
      } as any);
      assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, ['patch-seeded-v2']);

      await controller.rollbackMemory(seededMemory.id, 'patch-seeded-v2', 'patch-seeded-v1');
      await controller.mountMemories('profile-e2e', [seededMemory.id]);
      await runtime.createChatCompletion({
        model: 'qwen2.5-7b-fp16',
        messages: [{ role: 'user', content: '验证记忆回滚。' }],
        stream: false,
        max_tokens: 8,
      } as any);
      assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, ['patch-seeded-v1']);

      const disabledV2 = await controller.disable({ profile_id: 'profile-e2e' });
      assert.equal(disabledV2.isError, false, disabledV2.content);
      await runtime.createChatCompletion({
        model: 'qwen2.5-7b-fp16',
        messages: [{ role: 'user', content: '验证记忆停用。' }],
        stream: false,
        max_tokens: 8,
      } as any);
      assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, []);
      return;
    }

    const mounted = await controller.mount({
      profile_id: 'profile-e2e',
      active_memory_patch_ids: ['patch-old'],
    });
    assert.equal(mounted.isError, false, mounted.content);
    assert.equal(runtime.getProviderState()?.memory?.status, 'pending');

    await runtime.createChatCompletion({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '利博是我的同事。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    assert.ok(runtime.getProviderState()?.agora_session_id, 'chat turn must establish Agora session id');
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, ['patch-old']);

    const internalized = await controller.internalize({ profile_id: 'profile-e2e' });
    assert.equal(internalized.isError, false, internalized.content);
    const internalizedPayload = JSON.parse(internalized.content);
    const patchId = internalizedPayload.output_memory_patch_id;
    assert.match(patchId, /^patch_/);
    assert.equal(internalizedPayload.mount_status, 'pending_next_chat');
    await runtime.createChatCompletion({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '验证新 MemoryPatch。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, [patchId]);

    const rolledBack = await controller.rollback({ profile_id: 'profile-e2e', patch_id: 'patch-old' });
    assert.equal(rolledBack.isError, false, rolledBack.content);
    await runtime.createChatCompletion({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '验证 MemoryPatch 回滚。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, ['patch-old']);

    const disabled = await controller.disable({ profile_id: 'profile-e2e' });
    assert.equal(disabled.isError, false, disabled.content);
    await runtime.createChatCompletion({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '验证 MemoryPatch 已停用。' }],
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

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
        import mlx.core as mx

        hidden = mx.ones((1, 1, 8), dtype=mx.float32)
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
from agora_lab.schemas import AdapterRecord, BaseModelRecord, MemoryPatchRecord


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
adapter_dir = root / "adapter-old"
adapter_dir.mkdir(parents=True, exist_ok=True)
(adapter_dir / "adapters.safetensors").write_text("old adapter weights", encoding="utf-8")
adapter_manifest = adapter_dir / "manifest.json"
adapter_manifest.write_text(json.dumps({"adapter_id": "adapter-old"}), encoding="utf-8")
adapter_eval = adapter_dir / "eval_report.json"
adapter_eval.write_text(json.dumps({"status": "seeded"}), encoding="utf-8")
registry.upsert_adapter(
    AdapterRecord(
        id="adapter-old",
        name="adapter-old",
        base_model_id="qwen2.5-7b-fp16",
        method="lora",
        artifact_path=str(adapter_dir),
        manifest_path=str(adapter_manifest),
        training_job_id="train-adapter-old",
        dataset_id="dataset-old",
        training_profile={"rank": 4},
        eval_report_path=str(adapter_eval),
        status="experimental",
        family="ma-e2e-memory",
        version="0.0.0-old",
        base_architecture="dense",
        weights_file="adapters.safetensors",
    )
)
patch_dir = root / "patch-old"
patch_dir.mkdir(parents=True, exist_ok=True)
patch_manifest = patch_dir / "manifest.json"
patch_manifest.write_text(json.dumps({"kind": "lora_adapter_memory_patch_v0"}), encoding="utf-8")
patch_eval = patch_dir / "eval_report.json"
patch_eval.write_text(json.dumps({"status": "seeded"}), encoding="utf-8")
registry.upsert_memory_patch(
    MemoryPatchRecord(
        id="patch-old",
        name="patch-old",
        base_model_id="qwen2.5-7b-fp16",
        patch_type="lora_adapter",
        compiler_backend="qlora_train",
        artifact_path=str(patch_dir),
        manifest_path=str(patch_manifest),
        eval_report_path=str(patch_eval),
        status="experimental",
        family="ma-e2e-memory",
        version="0.0.0-old",
        source_ids=["seed-source"],
        adapter_id="adapter-old",
        mountable=True,
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
});

test('agora provider runtime disables memory controller when required memory MCP tools are missing', async () => {
  const runtime = runtimeWithFakeCalls([], ['doctor', 'models_list', 'chat_complete']);
  assert.equal(runtime.getMemoryController(), null);
});

test('agora memory internalize runs intake, updates profile, binds scope, and verifies via chat metadata', async () => {
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
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      'chat_complete',
      'memory_intake_run',
      'memory_profiles_list',
      'memory_profiles_create',
      'memory_profile_bindings_list',
      'memory_profile_bindings_create',
      'chat_complete',
    ]
  );
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

    const mounted = await controller.mount({
      profile_id: 'profile-e2e',
      active_memory_patch_ids: ['patch-old'],
    });
    assert.equal(mounted.isError, false, mounted.content);
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, ['patch-old']);

    await runtime.createChatCompletion({
      model: 'qwen2.5-7b-fp16',
      messages: [{ role: 'user', content: '利博是我的同事。' }],
      stream: false,
      max_tokens: 8,
    } as any);
    assert.ok(runtime.getProviderState()?.agora_session_id, 'chat turn must establish Agora session id');

    const internalized = await controller.internalize({ profile_id: 'profile-e2e' });
    assert.equal(internalized.isError, false, internalized.content);
    const internalizedPayload = JSON.parse(internalized.content);
    const patchId = internalizedPayload.output_memory_patch_id;
    assert.match(patchId, /^memory-intake-/);
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, [patchId]);

    const rolledBack = await controller.rollback({ profile_id: 'profile-e2e', patch_id: 'patch-old' });
    assert.equal(rolledBack.isError, false, rolledBack.content);
    assert.deepEqual(runtime.getProviderState()?.memory?.active_memory_patch_ids, ['patch-old']);

    const disabled = await controller.disable({ profile_id: 'profile-e2e' });
    assert.equal(disabled.isError, false, disabled.content);
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

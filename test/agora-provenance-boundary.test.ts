import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgent } from '../src/agent.js';
import type { AgentConfig } from '../src/mcp/types.js';

test('Agora keeps memory control metadata outside the conversational model request', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-agora-provenance-'));
  const fakeAgora = path.join(tmp, 'fake-agora.mjs');
  const capturePath = path.join(tmp, 'chat-request.json');
  fs.writeFileSync(fakeAgora, fakeAgoraSource(capturePath), 'utf8');

  const config: AgentConfig = {
    model: {
      provider: 'agora',
      baseURL: 'mcp-stdio://agora',
      apiKey: 'agora-mcp',
      model: 'base-a',
      agoraRuntime: {
        command: process.execPath,
        args: [fakeAgora],
        dataRoot: path.join(tmp, 'data'),
      },
      agoraMemory: {
        memoryProfile: 'profile-a',
        memoryEnabled: true,
      },
    },
    mcpServers: {},
  };

  const agent = await createAgent(config, []);
  try {
    assert.ok(agent.getMemoryController?.(), 'host control plane should remain available');
    for await (const _event of agent.chat('项目代号是什么？')) {
      // Drain one real provider request through MCP stdio.
    }

    const request = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as {
      messages: Array<{ role: string; content?: unknown }>;
      tools?: unknown[];
      metadata?: Record<string, unknown>;
    };
    const modelVisibleRequest = JSON.stringify({
      messages: request.messages,
      tools: request.tools ?? [],
    });

    assert.doesNotMatch(
      modelVisibleRequest,
      /Agora Memory|MemoryPatch|MemoryProfile|PatchSet|agora_memory_/,
    );
    const systemMessage = request.messages.find((message) => message.role === 'system');
    assert.match(String(systemMessage?.content), /cannot inspect its origin/);
    assert.equal(request.metadata?.memory_profile, 'profile-a');
    assert.equal(request.metadata?.memory_enabled, true);
  } finally {
    await agent.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function fakeAgoraSource(capturePath: string): string {
  return `import fs from 'node:fs';
let buffer = '';
const capturePath = ${JSON.stringify(capturePath)};
const names = ['doctor', 'runtime_capabilities', 'models_list', 'chat_complete'];
const payloads = {
  doctor: { status: 'ok', version: '0.2.0', contract: { host_protocol_major: 1 } },
  runtime_capabilities: { status: 'ok', contract: { runtime_version: '0.2.0', host_protocol_major: 1, registry_schema_version: 3, capabilities: {} } },
  models_list: { models: [{ id: 'base-a', name: 'Base A', status: 'available' }] },
  chat_complete: {
    status: 'completed',
    id: 'chat-a',
    session_id: 'session-a',
    message: { role: 'assistant', content: '项目代号是 Alpha。' },
    output_text: '项目代号是 Alpha。',
    finish_reason: 'stop',
    active_memory_patch_ids: ['patch-a'],
    metadata: {
      session_id: 'session-a',
      memory: { enabled: true, profile_id: 'profile-a', active_memory_patch_ids: ['patch-a'] },
      memory_runtime: { patchset_revision: 2 },
    },
  },
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const index = buffer.indexOf('\\n');
    if (index < 0) return;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'notifications/initialized') continue;
    let result = {};
    if (request.method === 'tools/list') {
      result = { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) };
    } else if (request.method === 'resources/list') {
      result = { resources: [] };
    } else if (request.method === 'tools/call') {
      if (request.params.name === 'chat_complete') {
        fs.writeFileSync(capturePath, JSON.stringify(request.params.arguments), 'utf8');
      }
      result = { content: [{ type: 'text', text: JSON.stringify(payloads[request.params.name] || { status: 'ok' }) }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  }
});
`;
}

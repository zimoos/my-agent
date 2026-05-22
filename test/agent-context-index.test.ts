import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import OpenAI from 'openai';
import { createAgent } from '../src/agent.js';
import { createContextManager } from '../src/agent/context-manager.js';
import { createSessionStore } from '../src/session/store.js';
import type { AgentConfig, AgentEvent } from '../src/mcp/types.js';

function findCompletionsPrototype(): any {
  const probe = new OpenAI({ baseURL: 'http://0.0.0.0', apiKey: 'x' });
  return Object.getPrototypeOf((probe as any).chat.completions);
}

function installOpenAiMock(content: string, calls?: any[]) {
  const proto = findCompletionsPrototype();
  const original = proto.create;
  proto.create = function patched(body: any) {
    if (body.stream !== true) throw new Error('expected streaming chat call');
    calls?.push(body);
    const chunks = [
      { choices: [{ delta: { content } }] },
    ];
    return Promise.resolve((async function* () {
      for (const chunk of chunks) yield chunk;
    })() as any);
  };
  return () => {
    proto.create = original;
  };
}

async function drain(gen: AsyncGenerator<AgentEvent, void, unknown>): Promise<void> {
  for await (const _event of gen) {
    // drain
  }
}

const config: AgentConfig = {
  model: {
    baseURL: 'http://127.0.0.1:0',
    model: 'stub-model',
    apiKey: 'stub-key',
  },
  mcpServers: {},
};

test('agent chat writes monotonic transcript index sidecar for visible messages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-agent-index-'));
  const sessionStore = createSessionStore(dir);
  const sessionId = sessionStore.create({
    createdAt: Date.now(),
    cwd: process.cwd(),
    model: 'stub-model',
  });
  const restore = installOpenAiMock(
    'visible answer\n<ma_context_patch>{"ops":[]}</ma_context_patch>'
  );
  try {
    const agent = await createAgent(config, [], { sessionStore, sessionId });
    await drain(agent.chat('hello indexed context'));

    const indexPath = path.join(dir, `${sessionId}.index.jsonl`);
    const rows = fs.readFileSync(indexPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.deepEqual(rows.map((row) => row.i), [0, 1]);
    assert.equal(rows[0].role, 'user');
    assert.equal(rows[0].immutable, true);
    assert.equal(rows[1].role, 'assistant');
    assert.equal(rows[1].immutable, false);
    assert.match(rows[1].text, /visible answer/);
  } finally {
    restore();
  }
});

test('agent chat sends context-manager active context, not full transcript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-agent-context-request-'));
  const sessionStore = createSessionStore(dir);
  const sessionId = sessionStore.create({
    createdAt: Date.now(),
    cwd: process.cwd(),
    model: 'stub-model',
  });
  const oldMessages = [
    { role: 'user', content: 'old task that should stay out of request' },
    { role: 'assistant', content: 'cold noisy assistant history' },
  ] as any[];
  for (const msg of oldMessages) sessionStore.append(sessionId, msg);
  const contextManager = createContextManager(sessionId, dir);
  contextManager.ensureIndexed(oldMessages);
  contextManager.clearActive();
  contextManager.recordMessages([
    { role: 'user', content: 'current active task' },
  ]);

  const calls: any[] = [];
  const restore = installOpenAiMock(
    'visible answer\n<ma_context_patch>{"ops":[]}</ma_context_patch>',
    calls
  );
  try {
    const agent = await createAgent(config, [], {
      resumeMessages: oldMessages,
      sessionStore,
      sessionId,
    });
    await drain(agent.chat('new task'));

    const firstRequest = calls[0].messages;
    const requestText = JSON.stringify(firstRequest);

    assert.match(requestText, /current active task/);
    assert.match(requestText, /new task/);
    assert.doesNotMatch(requestText, /old task that should stay out of request/);
    assert.doesNotMatch(requestText, /cold noisy assistant history/);
  } finally {
    restore();
  }
});

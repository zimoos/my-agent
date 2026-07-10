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

function installOpenAiMockTurns(turns: any[], calls?: any[]) {
  const proto = findCompletionsPrototype();
  const original = proto.create;
  proto.create = function patched(body: any) {
    if (body.stream !== true) throw new Error('expected streaming chat call');
    calls?.push(body);
    const chunks = turns.shift();
    if (!chunks) throw new Error('mock OpenAI: no turn queued');
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
  const restore = installOpenAiMock('visible answer');
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

test('agent chat sends append-only transcript, not context-manager active sidecar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-agent-context-request-'));
  const sessionStore = createSessionStore(dir);
  const sessionId = sessionStore.create({
    createdAt: Date.now(),
    cwd: process.cwd(),
    model: 'stub-model',
  });
  const oldMessages = [
    { role: 'user', content: 'resumed transcript user marker alpha' },
    { role: 'assistant', content: 'resumed transcript assistant marker beta' },
  ] as any[];
  for (const msg of oldMessages) sessionStore.append(sessionId, msg);
  const contextManager = createContextManager(sessionId, dir);
  contextManager.ensureIndexed(oldMessages);
  contextManager.clearActive();
  contextManager.recordMessages([
    { role: 'user', content: 'sidecar poison marker must not reach provider' },
  ]);

  const calls: any[] = [];
  const restore = installOpenAiMockTurns([
    [{ choices: [{ delta: { content: 'visible answer one' } }] }],
    [{ choices: [{ delta: { content: 'visible answer two' } }] }],
  ], calls);
  try {
    const agent = await createAgent(config, [], {
      resumeMessages: oldMessages,
      sessionStore,
      sessionId,
    });
    await drain(agent.chat('new task one'));

    const firstRequest = calls[0].messages;
    const requestText = JSON.stringify(firstRequest);

    assert.match(requestText, /resumed transcript user marker alpha/);
    assert.match(requestText, /resumed transcript assistant marker beta/);
    assert.match(requestText, /new task one/);
    assert.doesNotMatch(requestText, /sidecar poison marker must not reach provider/);

    agent.clearActiveContext();
    await drain(agent.chat('new task two after clearActiveContext'));

    const secondRequest = calls[1].messages;
    const secondText = JSON.stringify(secondRequest);
    assert.match(secondText, /resumed transcript user marker alpha/);
    assert.match(secondText, /resumed transcript assistant marker beta/);
    assert.match(secondText, /new task one/);
    assert.match(secondText, /visible answer one/);
    assert.match(secondText, /new task two after clearActiveContext/);
    assert.doesNotMatch(secondText, /sidecar poison marker must not reach provider/);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent chat removes context_update tool, exposes ma ctx CLI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-agent-ctx-cli-'));
  const sessionStore = createSessionStore(dir);
  const sessionId = sessionStore.create({
    createdAt: Date.now(),
    cwd: process.cwd(),
    model: 'stub-model',
  });
  const oldMessages = [
    { role: 'user', content: 'hello' },
  ] as any[];
  for (const msg of oldMessages) sessionStore.append(sessionId, msg);

  const calls: any[] = [];
  const restore = installOpenAiMockTurns([
    [{ choices: [{ delta: { content: 'hi there' } }] }],
  ], calls);
  try {
    const agent = await createAgent(config, [], {
      resumeMessages: oldMessages,
      sessionStore,
      sessionId,
    });
    await drain(agent.chat('new task'));

    // context_update must NOT be in builtin tools
    const toolNames = calls[0].tools.map((t: any) => t.function?.name);
    assert.ok(
      !toolNames.includes('context_update'),
      'context_update tool must be removed from builtin tools'
    );
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent: ma ctx CLI commands work with context manager directly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ctx-direct-'));
  const sessionStore = createSessionStore(dir);
  const sessionId = sessionStore.create({
    createdAt: Date.now(),
    cwd: process.cwd(),
    model: 'stub-model',
  });
  const cm = createContextManager(sessionId, dir);

  const msgs = [
    { role: 'user', content: 'important question' },
    { role: 'assistant', content: 'verbose tool evidence that should be removable' },
  ];
  cm.ensureIndexed(msgs);
  assert.equal(cm.active().length, 2, 'should have 2 active items');

  // ma ctx rm: remove the assistant message
  const result = cm.drop(1);
  assert.ok(result.includes('Dropped i=1'), `drop result: ${result}`);
  assert.equal(cm.active().length, 1, 'should have 1 item after rm');

  // Removed item should be in pool
  const poolResults = cm.search('verbose tool');
  assert.ok(poolResults.length >= 1, 'removed item should be in pool');

  // ma ctx search
  const searchResults = cm.search('important');
  assert.ok(searchResults.length >= 1, 'search should find indexed items');

  // ma ctx pin
  const pinResult = cm.pin('critical context');
  assert.ok(pinResult.includes('Pinned'), `pin result: ${pinResult}`);

  // ma ctx recall
  const entry = poolResults[0];
  const recallResult = cm.recall(entry.id);
  assert.ok(recallResult.includes('Recalled'), `recall result: ${recallResult}`);

  // ma ctx clear
  const clearResult = cm.clearActive();
  assert.ok(clearResult.includes('Cleared'), `clear result: ${clearResult}`);
  assert.equal(cm.active().length, 0, 'should be empty after clear');

  fs.rmSync(dir, { recursive: true, force: true });
});

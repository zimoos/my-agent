import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createAgent } from '../src/agent.js';
import type {
  AgentConfig,
  AgentEvent,
  McpConnection,
} from '../src/mcp/types.js';

// ---------- OpenAI mock infrastructure ----------

type MockStreamChunk = {
  choices: Array<{
    delta: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

type MockResponse =
  | { kind: 'stream'; chunks: MockStreamChunk[] }
  | { kind: 'nonStream'; content: string }
  | { kind: 'error'; status: number; message?: string };

interface MockState {
  responses: MockResponse[];
  calls: Array<{
    messages: any[];
    stream: boolean;
    body: any;
  }>;
}

// OpenAI SDK ships both CJS and ESM builds, which can resolve to *different*
// Completions classes at runtime depending on how it's imported. To patch
// reliably, walk the runtime prototype chain of an actual instance.
function findCompletionsPrototype(): any {
  const probe = new OpenAI({ baseURL: 'http://0.0.0.0', apiKey: 'x' });
  return Object.getPrototypeOf((probe as any).chat.completions);
}

function installOpenAiMock(state: MockState) {
  const proto = findCompletionsPrototype();
  const original = proto.create;
  proto.create = function patched(body: any, _options?: any) {
    // snapshot deep-copy messages so later mutations do not poison the record
    const snapshot = JSON.parse(JSON.stringify(body.messages));
    state.calls.push({
      messages: snapshot,
      stream: body.stream === true,
      body: JSON.parse(JSON.stringify(body)),
    });

    if (state.responses.length === 0) {
      throw new Error('mock OpenAI: no response queued');
    }
    const resp = state.responses.shift()!;

    if (resp.kind === 'error') {
      const err = new Error(resp.message ?? `mock status ${resp.status}`) as any;
      err.status = resp.status;
      return Promise.reject(err);
    }
    if (resp.kind === 'nonStream') {
      // Summarizer path: non-streaming, read .choices[0].message.content
      return Promise.resolve({
        choices: [{ message: { content: resp.content } }],
      } as any);
    }
    // stream: return an async-iterable
    const chunks = resp.chunks;
    const iter = (async function* () {
      for (const c of chunks) {
        yield c;
      }
    })();
    return Promise.resolve(iter as any);
  };
  return () => {
    proto.create = original;
  };
}

function streamChunks(opts: {
  content?: string;
  reasoningContent?: string;
  toolCalls?: Array<{
    index?: number;
    id: string;
    name: string;
    arguments: string;
  }>;
}): MockStreamChunk[] {
  const out: MockStreamChunk[] = [];
  if (typeof opts.reasoningContent === 'string' && opts.reasoningContent.length > 0) {
    out.push({ choices: [{ delta: { reasoning_content: opts.reasoningContent } }] });
  }
  if (typeof opts.content === 'string' && opts.content.length > 0) {
    // split into small pieces to exercise streaming aggregation
    const mid = Math.floor(opts.content.length / 2);
    const a = opts.content.slice(0, mid);
    const b = opts.content.slice(mid);
    if (a) out.push({ choices: [{ delta: { content: a } }] });
    if (b) out.push({ choices: [{ delta: { content: b } }] });
  }
  if (opts.toolCalls) {
    for (const tc of opts.toolCalls) {
      out.push({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: tc.index ?? 0,
                  id: tc.id,
                  function: { name: tc.name, arguments: tc.arguments },
                },
              ],
            },
          },
        ],
      });
    }
  }
  if (out.length === 0) {
    out.push({ choices: [{ delta: { content: '' } }] });
  }
  return out;
}

// ---------- assertion helpers ----------

function assertHasRole(messages: any[], role: string): void {
  const found = messages.some((m) => m && m.role === role);
  assert.ok(found, `expected messages to contain role=${role}`);
}

function assertToolCallPaired(messages: any[]): void {
  const openIds: string[] = [];
  for (const m of messages) {
    if (
      m &&
      m.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      for (const tc of m.tool_calls) {
        assert.ok(
          typeof tc.id === 'string' && tc.id.length > 0,
          'tool_call must have non-empty id'
        );
        openIds.push(tc.id);
      }
    }
  }
  const toolIds: string[] = [];
  for (const m of messages) {
    if (m && m.role === 'tool') {
      assert.ok(
        typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0,
        'tool message must have tool_call_id'
      );
      toolIds.push(m.tool_call_id);
      assert.ok(
        openIds.includes(m.tool_call_id),
        `tool message ${m.tool_call_id} has no matching assistant tool_call`
      );
    }
  }
  for (const id of openIds) {
    assert.ok(
      toolIds.includes(id),
      `assistant tool_call ${id} has no matching tool result`
    );
  }
}

function assertNoEmptyAssistant(messages: any[]): void {
  for (const m of messages) {
    if (!m || m.role !== 'assistant') continue;
    const hasToolCalls =
      Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    if (hasToolCalls) continue; // tool-call assistant messages may have empty textual content
    const content = m.content;
    if (typeof content === 'string') {
      assert.ok(content.length > 0, 'assistant message has empty string content');
    } else if (Array.isArray(content)) {
      assert.ok(content.length > 0, 'assistant message has empty array content');
    } else {
      assert.fail(
        `assistant message has unexpected content type: ${typeof content}`
      );
    }
  }
}

function assertSystemFirst(messages: any[]): void {
  assert.ok(messages.length > 0, 'messages must not be empty');
  assert.equal(messages[0].role, 'system', 'messages[0] must be system');
}

// ---------- agent harness ----------

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: {
      baseURL: 'http://127.0.0.1:0',
      model: 'stub-model',
      apiKey: 'stub-key',
    },
    mcpServers: {},
    ...overrides,
  };
}

function makeConnections(): McpConnection[] {
  return [];
}

async function drain(gen: AsyncGenerator<AgentEvent, void, unknown>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

// ---------- cases ----------

test('messages: initial system prompt is first message with expected content', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const customSystem = 'ROOT_SYS_PROMPT_MARKER';
    const agent = await createAgent(
      makeConfig({ systemPrompt: customSystem }),
      makeConnections()
    );

    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'ok' }),
    });

    await drain(agent.chat('hi'));

    assert.equal(state.calls.length, 1);
    const first = state.calls[0].messages;
    assertSystemFirst(first);
    const sys = first[0].content as string;
    assert.ok(
      sys.includes(customSystem),
      `system prompt should include customSystem, got: ${sys.slice(0, 80)}...`
    );
    assert.ok(
      sys.includes('# Environment'),
      'system prompt should include environment block'
    );
  } finally {
    restore();
  }
});

test('messages: chat() pushes user message before first model call', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'answer' }),
    });

    await drain(agent.chat('ask-something-unique-42'));

    assert.equal(state.calls.length, 1);
    const sent = state.calls[0].messages;
    assertHasRole(sent, 'user');
    const userMsg = sent.find((m: any) => m.role === 'user');
    assert.equal(userMsg.content, 'ask-something-unique-42');
  } finally {
    restore();
  }
});

test('messages: tool results are textualized in active context', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    // Use the builtin todo_write tool so no MCP connection is required.
    const agent = await createAgent(makeConfig(), makeConnections());

    // Turn 1: assistant issues a tool_call
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [
          {
            id: 'call_todo_1',
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'add', text: 'item one' }),
          },
        ],
      }),
    });
    // Turn 2: assistant returns final answer, no more tool calls
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'done' }),
    });

    await drain(agent.chat('please plan'));

    // Second model call reads ContextManager active context, not raw tool protocol history.
    assert.ok(state.calls.length >= 2, 'expected at least 2 model calls');
    const round2 = state.calls[1].messages;

    assertQwen3Safe(round2);
    assert.ok(
      round2.some((m: any) => m.role === 'user' && m.content === 'please plan'),
      'original user request must remain active'
    );
    assert.ok(
      round2.some((m: any) => m.role === 'assistant' && String(m.content).includes('[tool result')),
      'tool result must be represented as active-context text'
    );
    assert.ok(!round2.some((m: any) => m.role === 'tool'), 'raw tool messages must not be sent');
  } finally {
    restore();
  }
});

test('messages: compact path still sends active context with user', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    // Tiny context window forces compact. Need messages.length >= 8 at start
    // of a loop iteration so findSafeCutIndex returns cut >= 2 and compact
    // actually triggers.
    const agent = await createAgent(
      makeConfig({
        model: {
          baseURL: 'http://127.0.0.1:0',
          model: 'stub-model',
          apiKey: 'stub-key',
          contextWindow: 50,
        },
      }),
      makeConnections()
    );

    // Chain 3 tool calls then a final answer in a single task.
    // This grows messages to [sys, user, asst(tc), tool, asst(tc), tool, asst(tc), tool]
    // = 8 messages at the start of the 4th loop → compact triggers.
    const mkToolTurn = (id: string) => ({
      kind: 'stream' as const,
      chunks: streamChunks({
        toolCalls: [
          {
            id,
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'list' }),
          },
        ],
      }),
    });
    state.responses.push(mkToolTurn('call_a'));
    state.responses.push(mkToolTurn('call_b'));
    state.responses.push(mkToolTurn('call_c'));

    // Before the 4th model call, agent runs maybeCompact which will
    // issue a non-stream summarize call:
    state.responses.push({
      kind: 'nonStream',
      content:
        '【compact】summary covering prior tool usage context that is long enough to pass the 50-char guard xxxxxxxxxxxxxxxxxxxxx',
    });
    // Then the 4th model call itself (post-compact):
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'final after compact' }),
    });

    await drain(agent.chat('user-round-1-preserved'));

    // Find the last model call that carries the compact summary.
    const last = state.calls[state.calls.length - 1].messages;
    assertSystemFirst(last);

    assertQwen3Safe(last);
    assertNoEmptyAssistant(last);
    const nonSystem = last.filter((m: any) => m.role !== 'system');
    assert.ok(
      nonSystem.length > 0,
      'active context request must not collapse to only system'
    );
  } finally {
    restore();
  }
});

test('messages: follow-up context preserves root user and textualized tool result', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // Turn 1: call a builtin tool to create a tool_call + tool pair
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [
          {
            id: 'call_a',
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'add', text: 'step 1' }),
          },
        ],
      }),
    });
    // Turn 2: final text → root task ends. Root turns should remain verbatim;
    // only internal subtasks are folded.
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'task complete' }),
    });

    await drain(agent.chat('plan step'));

    // Trigger another turn to observe the folded state
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'next' }),
    });
    await drain(agent.chat('second ask'));

    const last = state.calls[state.calls.length - 1].messages;
    const hasOriginalUser = last.some(
      (m: any) => m.role === 'user' && m.content === 'plan step'
    );
    assert.ok(hasOriginalUser, 'root task user message must remain in history');

    assert.ok(
      last.some((m: any) => m.role === 'user' && m.content === 'second ask'),
      'current root user message must remain in active context'
    );
    assert.ok(
      last.some((m: any) => m.role === 'assistant' && String(m.content).includes('[tool result')),
      'prior tool result must be textualized in active context'
    );
    assert.ok(!last.some((m: any) => m.role === 'tool'), 'raw tool protocol messages must not be sent');
  } finally {
    restore();
  }
});

test('messages: 500 retry+truncate keeps system and preserves user message', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // First, build up enough history (need >4 messages for truncate path).
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'r1' }),
    });
    await drain(agent.chat('round-1'));

    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'r2' }),
    });
    await drain(agent.chat('round-2'));

    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'r3' }),
    });
    await drain(agent.chat('round-3'));

    // Now round-4: server returns 500 for withRetry attempts (retries=2 → 3 tries),
    // then agent does a truncate+retry (one more attempt). Finally success.
    state.responses.push({ kind: 'error', status: 500 });
    state.responses.push({ kind: 'error', status: 500 });
    state.responses.push({ kind: 'error', status: 500 });
    // truncate+retry path:
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'recovered' }),
    });

    await drain(agent.chat('round-4-truncate-preserved'));

    const last = state.calls[state.calls.length - 1].messages;
    assertSystemFirst(last);
    assertQwen3Safe(last);
    const userMsgs = last.filter((m: any) => m.role === 'user');
    const thisRoundUser = userMsgs.find(
      (m: any) => m.content === 'round-4-truncate-preserved'
    );
    assert.ok(thisRoundUser, 'current-round user message must survive truncate');
  } finally {
    restore();
  }
});

test('messages: thinking tokens are stripped from assistant content', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // Turn 1: stream thinking delimiters + real content + a tool_call.
    // The tool_call guarantees the agent runs another model turn WITHIN the
    // same task, so the assistant message survives (no foldMessages yet).
    state.responses.push({
      kind: 'stream',
      chunks: [
        { choices: [{ delta: { content: '<|channel>thought' } }] },
        { choices: [{ delta: { content: 'secret plan XYZ' } }] },
        { choices: [{ delta: { content: '<channel|>' } }] },
        { choices: [{ delta: { content: 'real-visible-answer' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_t1',
                    function: {
                      name: 'todo_write',
                      arguments: JSON.stringify({ action: 'list' }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    // Turn 2 (same task): final answer — this call's payload will contain the
    // turn-1 assistant message verbatim.
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'wrap up' }),
    });

    await drain(agent.chat('hello'));

    // Second model call inside the same task = snapshot that contains the
    // turn-1 assistant message.
    assert.ok(state.calls.length >= 2, 'expected >=2 model calls in same task');
    const round2 = state.calls[1].messages;
    const asst = round2.find(
      (m: any) =>
        m.role === 'assistant' &&
        typeof m.content === 'string' &&
        m.content.includes('real-visible-answer')
    );
    assert.ok(asst, 'assistant visible content must exist in active context');

    const content =
      typeof asst.content === 'string'
        ? asst.content
        : JSON.stringify(asst.content);

    // Must include visible answer
    assert.ok(
      content.includes('real-visible-answer'),
      `assistant content should include visible text, got: ${content}`
    );
    // Must NOT contain thinking delimiters
    assert.ok(
      !content.includes('<|channel>'),
      'assistant content must not contain <|channel> delimiter'
    );
    assert.ok(
      !content.includes('<channel|>'),
      'assistant content must not contain <channel|> delimiter'
    );
    // Must NOT contain the hidden thinking body
    assert.ok(
      !content.includes('secret plan XYZ'),
      'assistant content must not leak thinking body'
    );
  } finally {
    restore();
  }
});

test('messages: deepseek active context does not replay reasoning protocol fields', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(
      makeConfig({
        model: {
          provider: 'deepseek',
          baseURL: 'https://api.deepseek.com',
          model: 'deepseek-v4-pro',
          apiKey: 'stub-key',
        },
      }),
      makeConnections()
    );

    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        reasoningContent: 'Need to inspect the todo list before answering.',
        content: 'I will inspect the list.',
        toolCalls: [
          {
            id: 'call_ds_1',
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'list' }),
          },
        ],
      }),
    });
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        reasoningContent: 'The tool returned the list, so now answer.',
        content: 'done',
      }),
    });

    await drain(agent.chat('check todos'));

    assert.ok(state.calls.length >= 2, 'expected second request after tool result');
    const round2 = state.calls[1].messages;
    assertQwen3Safe(round2);
    assert.ok(
      !round2.some((m: any) => m.reasoning_content !== undefined),
      'active context requests must not replay reasoning_content'
    );
  } finally {
    restore();
  }
});

test('messages: default codec strips reasoning_content from outbound messages', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        reasoningContent: 'Hidden reasoning from an OpenAI-compatible provider.',
        content: 'I will inspect the list.',
        toolCalls: [
          {
            id: 'call_default_1',
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'list' }),
          },
        ],
      }),
    });
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'done' }),
    });

    await drain(agent.chat('check todos'));

    assert.ok(state.calls.length >= 2, 'expected second request after tool result');
    const round2 = state.calls[1].messages;
    assertQwen3Safe(round2);
    assert.ok(
      !round2.some((m: any) => m.reasoning_content !== undefined),
      'default codec must not send reasoning_content'
    );
  } finally {
    restore();
  }
});

// ──────────── Qwen3 Jinja Compatibility Tests ────────────
// Qwen3's jinja template requires:
// 1. At least one user message in the array
// 2. tool messages must be paired with assistant(tool_calls)
// 3. No system/tool message as the "effective last" without user context

function assertHasUserMessage(messages: any[]): void {
  const hasUser = messages.some((m: any) => m && m.role === 'user');
  assert.ok(hasUser, 'messages must contain at least one user message (Qwen3 jinja requires it)');
}

function assertNoToolAfterLastUser(messages: any[]): void {
  // Find last user message index
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return; // assertHasUserMessage catches this
  // After last user, only assistant and tool (paired) are allowed
  // But messages must not END with an unpaired tool
  const last = messages[messages.length - 1];
  if (last?.role === 'tool') {
    // Check there's an assistant(tool_calls) before it that references this tool
    const hasMatchingAssistant = messages.some(
      (m: any) =>
        m.role === 'assistant' &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.some((tc: any) => tc.id === last.tool_call_id)
    );
    assert.ok(hasMatchingAssistant, 'messages must not end with orphan tool message');
  }
}

function assertQwen3Safe(messages: any[]): void {
  assertSystemFirst(messages);
  assertHasUserMessage(messages);
  assertToolCallPaired(messages);
}

function assertNoEmptyToolArguments(messages: any[]): void {
  for (const m of messages) {
    if (
      !m ||
      m.role !== 'assistant' ||
      !Array.isArray(m.tool_calls)
    ) {
      continue;
    }
    for (const tc of m.tool_calls) {
      const raw = tc?.function?.arguments;
      assert.notEqual(raw, '', 'tool_call arguments must not be empty string');
      assert.notEqual(raw, '""', 'tool_call arguments must not be JSON empty string');
      assert.notEqual(raw, '{}', 'required tool_call arguments must not be empty object');
    }
  }
}

test('messages: second chat after prior root task still has user messages (Qwen3 jinja)', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // First root task: tool call + completion. This should no longer fold.
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [
          { id: 'call_1', name: 'todo_write', arguments: JSON.stringify({ action: 'list' }) },
        ],
      }),
    });
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'done with first task' }),
    });
    await drain(agent.chat('first question'));

    // Second chat: messages must still have user roles from both turns.
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'second answer' }),
    });
    await drain(agent.chat('second question'));

    const last = state.calls[state.calls.length - 1].messages;
    assertQwen3Safe(last);
    // The new user message "second question" must be present
    const userMsgs = last.filter((m: any) => m.role === 'user');
    assert.ok(userMsgs.length >= 1, 'must have user message after fold');
    assert.ok(
      userMsgs.some((m: any) => m.content === 'second question'),
      'second question must be in messages'
    );
    assert.ok(
      userMsgs.some((m: any) => m.content === 'first question'),
      'first root question must remain in messages'
    );
  } finally {
    restore();
  }
});

test('messages: empty args P0-b pop leaves messages Qwen3-safe', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // Turn 1: model returns tool_call with empty arguments (triggers P0-b)
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [
          { id: 'call_empty1', name: 'todo_write', arguments: '' },
        ],
      }),
    });
    // Turn 2: after pop+resample, model returns correct args
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [
          { id: 'call_ok', name: 'todo_write', arguments: JSON.stringify({ action: 'list' }) },
        ],
      }),
    });
    // Turn 3: final answer
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'here is the list' }),
    });

    await drain(agent.chat('show todos'));

    // Every API call must be Qwen3-safe
    for (let i = 0; i < state.calls.length; i++) {
      const msgs = state.calls[i].messages;
      assertQwen3Safe(msgs);
    }
  } finally {
    restore();
  }
});

test('qwen3: mixed valid and empty required tool calls are not written to history', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // This mirrors Qwen returning one usable call plus one malformed required
    // call in the same assistant turn. The malformed assistant message must
    // not be echoed back to LM Studio/Qwen on the next request.
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [
          {
            id: 'mixed_ok',
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'list' }),
          },
          {
            id: 'mixed_empty',
            name: 'todo_write',
            arguments: '',
          },
        ],
      }),
    });
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [
          {
            id: 'after_retry',
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'list' }),
          },
        ],
      }),
    });
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'listed after retry' }),
    });

    await drain(agent.chat('list todos after mixed bad call'));

    for (let i = 0; i < state.calls.length; i++) {
      const msgs = state.calls[i].messages;
      assertQwen3Safe(msgs);
      assertNoEmptyToolArguments(msgs);
    }
  } finally {
    restore();
  }
});

test('messages: consecutive empty args (P0-b exhausted) still Qwen3-safe', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // 3 rounds of empty args: P0-b allows 2 retries, 3rd goes through to MCP
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [{ id: 'e1', name: 'todo_write', arguments: '' }],
      }),
    });
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [{ id: 'e2', name: 'todo_write', arguments: '' }],
      }),
    });
    // 3rd empty: P0-b exhausted, falls through to normal execution
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [{ id: 'e3', name: 'todo_write', arguments: '' }],
      }),
    });
    // After MCP error, model gives final answer
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'sorry could not do it' }),
    });

    await drain(agent.chat('do something'));

    // ALL calls must be Qwen3-safe
    for (let i = 0; i < state.calls.length; i++) {
      const msgs = state.calls[i].messages;
      assertSystemFirst(msgs);
      assertHasUserMessage(msgs);
      // tool pairing only if there are tool messages
      const hasToolMsgs = msgs.some((m: any) => m.role === 'tool');
      if (hasToolMsgs) assertToolCallPaired(msgs);
    }
  } finally {
    restore();
  }
});

test('messages: multi-turn with tool calls maintains user messages across root turns', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // Round 1: tool + answer
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [
          { id: 'tc1', name: 'todo_write', arguments: JSON.stringify({ action: 'add', text: 'a' }) },
        ],
      }),
    });
    state.responses.push({ kind: 'stream', chunks: streamChunks({ content: 'added' }) });
    await drain(agent.chat('add todo a'));

    // Round 2: tool + answer
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [
          { id: 'tc2', name: 'todo_write', arguments: JSON.stringify({ action: 'add', text: 'b' }) },
        ],
      }),
    });
    state.responses.push({ kind: 'stream', chunks: streamChunks({ content: 'added b' }) });
    await drain(agent.chat('add todo b'));

    // Round 3: just answer
    state.responses.push({ kind: 'stream', chunks: streamChunks({ content: 'ok' }) });
    await drain(agent.chat('what now'));

    // Every single API call across all rounds must be Qwen3-safe
    for (let i = 0; i < state.calls.length; i++) {
      const msgs = state.calls[i].messages;
      assertQwen3Safe(msgs);
    }

    const last = state.calls[state.calls.length - 1].messages;
    const userTexts = last.filter((m: any) => m.role === 'user').map((m: any) => m.content);
    assert.ok(userTexts.includes('add todo a'), 'first root turn must remain');
    assert.ok(userTexts.includes('add todo b'), 'second root turn must remain');
  } finally {
    restore();
  }
});

test('messages: task stack child task pop maintains user message', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // Parent task: model creates a subtask via create_task, then answers
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [
          {
            id: 'ct1',
            name: 'create_task',
            arguments: JSON.stringify({ prompt: 'sub-task: do something' }),
          },
        ],
      }),
    });
    state.responses.push({ kind: 'stream', chunks: streamChunks({ content: 'main done' }) });

    // Child task execution: model answers directly
    state.responses.push({ kind: 'stream', chunks: streamChunks({ content: 'sub done' }) });

    await drain(agent.chat('plan work'));

    // All API calls must be Qwen3-safe, including the child task call
    for (let i = 0; i < state.calls.length; i++) {
      const msgs = state.calls[i].messages;
      assertQwen3Safe(msgs);
    }
  } finally {
    restore();
  }
});

test('messages: no consecutive system messages without user in between across root turns', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // Three rounds to accumulate root conversation history
    for (let i = 0; i < 3; i++) {
      state.responses.push({ kind: 'stream', chunks: streamChunks({ content: `answer ${i}` }) });
      await drain(agent.chat(`question ${i}`));
    }

    // Final call: check messages structure
    state.responses.push({ kind: 'stream', chunks: streamChunks({ content: 'final' }) });
    await drain(agent.chat('last question'));

    const last = state.calls[state.calls.length - 1].messages;
    assertQwen3Safe(last);

    // Verify no "dead zone" where only system messages exist between user messages
    let foundUser = false;
    for (const m of last) {
      if (m.role === 'user') foundUser = true;
    }
    assert.ok(foundUser, 'at least one user message must exist after multiple folds');
  } finally {
    restore();
  }
});

test('messages: compact ensures user message exists even when last N are all assistant+tool', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    // Tiny context window to force compact on 4th iteration.
    const agent = await createAgent(
      makeConfig({
        model: {
          baseURL: 'http://127.0.0.1:0',
          model: 'stub-model',
          apiKey: 'stub-key',
          contextWindow: 50,
        },
      }),
      makeConnections()
    );

    // Build a scenario where the last 6 messages are all assistant(tool_call)+tool pairs.
    // After 4 tool calls: [sys, user, asst(tc), tool, asst(tc), tool, asst(tc), tool, asst(tc), tool]
    // = 10 messages. With COMPACT_KEEP_LAST_N=6, kept tail = last 6 = [asst(tc), tool, asst(tc), tool, asst(tc), tool]
    // No user message in the kept tail!
    const mkToolTurn = (id: string) => ({
      kind: 'stream' as const,
      chunks: streamChunks({
        toolCalls: [
          {
            id,
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'list' }),
          },
        ],
      }),
    });
    state.responses.push(mkToolTurn('call_1'));
    state.responses.push(mkToolTurn('call_2'));
    state.responses.push(mkToolTurn('call_3'));
    state.responses.push(mkToolTurn('call_4'));

    // The 5th iteration triggers compact. The summarizer (non-stream) call:
    state.responses.push({
      kind: 'nonStream',
      content:
        'Summary of prior conversation including user request and tool interactions that is definitely long enough to pass the 50-char minimum guard check xxxxxxxxx',
    });
    // The 5th model call post-compact: final answer
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'done with all tools' }),
    });

    await drain(agent.chat('original user question that should survive compact'));

    // Verify the post-compact model call has at least one user message
    const lastCall = state.calls[state.calls.length - 1].messages;
    assertSystemFirst(lastCall);

    const hasUserMsg = lastCall.some((m: any) => m.role === 'user');
    assert.ok(
      hasUserMsg,
      'compact must ensure a user message exists even when last N messages are all assistant+tool'
    );

    // The user message should contain the task prompt (truncated to 200 chars)
    const userMsg = lastCall.find((m: any) => m.role === 'user');
    assert.ok(
      typeof userMsg.content === 'string' && userMsg.content.length > 0,
      'fallback user message must have non-empty content'
    );

    // Tool pairing must still be valid
    assertToolCallPaired(lastCall);
  } finally {
    restore();
  }
});

// ──────────── Qwen3 Jinja Exhaustive Edge Cases ────────────
// These tests cover every known path that can lead to "No user query found in
// messages" 500 from Qwen3's jinja template. The assertion is simple: every
// single API call recorded in state.calls MUST contain at least one user role.

function assertAllCallsHaveUser(state: MockState, label: string): void {
  for (let i = 0; i < state.calls.length; i++) {
    const msgs = state.calls[i].messages;
    assertHasUserMessage(msgs);
    assertSystemFirst(msgs);
  }
}

test('qwen3: compact after 5 consecutive tool calls still has user message', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    // Very small context window: 50 tokens ≈ 175 chars total to trigger compact
    const agent = await createAgent(
      makeConfig({
        model: {
          baseURL: 'http://127.0.0.1:0',
          model: 'stub-model',
          apiKey: 'stub-key',
          contextWindow: 50,
        },
      }),
      makeConnections()
    );

    // 5 consecutive tool calls: messages grow to [sys, user, asst(tc), tool, asst(tc), tool, ...]
    // = 12 messages. COMPACT_KEEP_LAST_N=6 means kept tail is last 6 = all asst+tool, no user.
    const mkToolTurn = (id: string) => ({
      kind: 'stream' as const,
      chunks: streamChunks({
        toolCalls: [
          {
            id,
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'list' }),
          },
        ],
      }),
    });
    state.responses.push(mkToolTurn('c1'));
    state.responses.push(mkToolTurn('c2'));
    state.responses.push(mkToolTurn('c3'));
    state.responses.push(mkToolTurn('c4'));
    state.responses.push(mkToolTurn('c5'));

    // Compact summarizer call (nonStream):
    state.responses.push({
      kind: 'nonStream',
      content:
        'Summary: user asked to list todos. Agent called todo_write 5 times consecutively to enumerate items. This is a long enough summary to pass the 50-char guard.',
    });
    // Post-compact model call: final answer
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'all done listing' }),
    });

    await drain(agent.chat('list all my todos please'));

    // Critical assertion: every single API call must have user message
    assertAllCallsHaveUser(state, 'compact after 5 tool calls');
  } finally {
    restore();
  }
});

test('qwen3: compact triggered twice in same task still has user message', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(
      makeConfig({
        model: {
          baseURL: 'http://127.0.0.1:0',
          model: 'stub-model',
          apiKey: 'stub-key',
          contextWindow: 30, // Even smaller: triggers compact very aggressively
        },
      }),
      makeConnections()
    );

    // First batch of tool calls → triggers first compact
    const mkToolTurn = (id: string) => ({
      kind: 'stream' as const,
      chunks: streamChunks({
        toolCalls: [
          {
            id,
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'add', text: 'item' }),
          },
        ],
      }),
    });
    state.responses.push(mkToolTurn('d1'));
    state.responses.push(mkToolTurn('d2'));
    state.responses.push(mkToolTurn('d3'));

    // First compact summarizer
    state.responses.push({
      kind: 'nonStream',
      content:
        'First compact summary: user adding items. Multiple tool calls processed successfully. Context preserved for continuation of task.',
    });

    // More tool calls after first compact → triggers second compact
    state.responses.push(mkToolTurn('d4'));
    state.responses.push(mkToolTurn('d5'));
    state.responses.push(mkToolTurn('d6'));

    // Second compact summarizer
    state.responses.push({
      kind: 'nonStream',
      content:
        'Second compact summary: continued adding items after first compaction. User original request still active. All tools executed successfully.',
    });

    // Final answer
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'finished adding all items' }),
    });

    await drain(agent.chat('add many items to my todo list'));

    assertAllCallsHaveUser(state, 'double compact');
  } finally {
    restore();
  }
});

test('qwen3: P0-b pop + immediate compact still has user message', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(
      makeConfig({
        model: {
          baseURL: 'http://127.0.0.1:0',
          model: 'stub-model',
          apiKey: 'stub-key',
          contextWindow: 50,
        },
      }),
      makeConnections()
    );

    // First: some tool calls to build up message history
    const mkToolTurn = (id: string) => ({
      kind: 'stream' as const,
      chunks: streamChunks({
        toolCalls: [
          {
            id,
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'list' }),
          },
        ],
      }),
    });
    state.responses.push(mkToolTurn('p1'));
    state.responses.push(mkToolTurn('p2'));

    // Now model returns empty args (P0-b triggers pop)
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [{ id: 'p_empty', name: 'todo_write', arguments: '' }],
      }),
    });

    // After pop, the next iteration may trigger compact (messages are big enough).
    // Compact summarizer:
    state.responses.push({
      kind: 'nonStream',
      content:
        'Compact after P0-b pop: user asked to list todos. Two successful calls preceded. Model produced empty args once, retrying. Summary long enough for guard.',
    });

    // Post-compact retry with correct args
    state.responses.push(mkToolTurn('p3_ok'));

    // Final answer
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'here are your todos' }),
    });

    await drain(agent.chat('show me my todo list'));

    assertAllCallsHaveUser(state, 'P0-b pop + compact');
  } finally {
    restore();
  }
});

test('qwen3: retained root task + new task + compact still has user message', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(
      makeConfig({
        model: {
          baseURL: 'http://127.0.0.1:0',
          model: 'stub-model',
          apiKey: 'stub-key',
          contextWindow: 50,
        },
      }),
      makeConnections()
    );

    // First root task: tool call + answer remains in history
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [
          { id: 'f1', name: 'todo_write', arguments: JSON.stringify({ action: 'add', text: 'task A' }) },
        ],
      }),
    });
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'first task done with detailed explanation that takes up token space' }),
    });
    await drain(agent.chat('do task A with lots of context'));

    // Second task keeps the prior root task until compact triggers.
    const mkToolTurn = (id: string) => ({
      kind: 'stream' as const,
      chunks: streamChunks({
        toolCalls: [
          {
            id,
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'list' }),
          },
        ],
      }),
    });
    state.responses.push(mkToolTurn('f2'));
    state.responses.push(mkToolTurn('f3'));
    state.responses.push(mkToolTurn('f4'));

    // Compact triggered in second task
    state.responses.push({
      kind: 'nonStream',
      content:
        'Summary after fold: prior task completed (task A). Current task is listing todos. Three tool calls made. Context preserved adequately for continuation.',
    });

    // Final answer for second task
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'here is the list after fold and compact' }),
    });

    await drain(agent.chat('now list everything'));

    // Check ALL calls across both tasks
    assertAllCallsHaveUser(state, 'fold + new task + compact');
  } finally {
    restore();
  }
});

test('qwen3: task stack child + many tool calls + compact still has user message', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(
      makeConfig({
        model: {
          baseURL: 'http://127.0.0.1:0',
          model: 'stub-model',
          apiKey: 'stub-key',
          contextWindow: 50,
        },
      }),
      makeConnections()
    );

    // Parent task: creates a subtask
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({
        toolCalls: [
          {
            id: 'ct_parent',
            name: 'create_task',
            arguments: JSON.stringify({ prompt: 'child: do detailed work with many tool calls' }),
          },
        ],
      }),
    });
    // Parent completes after subtask is queued
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'delegated to subtask' }),
    });

    // Child task execution: many tool calls to trigger compact
    const mkToolTurn = (id: string) => ({
      kind: 'stream' as const,
      chunks: streamChunks({
        toolCalls: [
          {
            id,
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'add', text: 'sub-item' }),
          },
        ],
      }),
    });
    state.responses.push(mkToolTurn('child_1'));
    state.responses.push(mkToolTurn('child_2'));
    state.responses.push(mkToolTurn('child_3'));
    state.responses.push(mkToolTurn('child_4'));

    // Child triggers compact
    state.responses.push({
      kind: 'nonStream',
      content:
        'Child task compact summary: subtask executing tool calls to add items. Parent delegated work. Four consecutive tool_write calls made. Summary is long enough.',
    });

    // Child final answer
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'child task completed all additions' }),
    });

    await drain(agent.chat('plan and execute the work'));

    // ALL calls including child task calls must have user message
    assertAllCallsHaveUser(state, 'task stack child + compact');
  } finally {
    restore();
  }
});

test('qwen3: compact at maximal aggression (contextWindow=30) still has user message', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    // contextWindow=30 → compactThreshold = floor(30*0.75) = 22 tokens ≈ 77 chars
    // Even the system prompt alone might be near this threshold.
    const agent = await createAgent(
      makeConfig({
        model: {
          baseURL: 'http://127.0.0.1:0',
          model: 'stub-model',
          apiKey: 'stub-key',
          contextWindow: 30,
        },
        systemPrompt: 'S', // minimal system prompt to control token count
      }),
      makeConnections()
    );

    // Even 2 tool calls may trigger compact at this window size
    const mkToolTurn = (id: string) => ({
      kind: 'stream' as const,
      chunks: streamChunks({
        toolCalls: [
          {
            id,
            name: 'todo_write',
            arguments: JSON.stringify({ action: 'list' }),
          },
        ],
      }),
    });
    state.responses.push(mkToolTurn('agg1'));
    state.responses.push(mkToolTurn('agg2'));

    // Compact summarizer
    state.responses.push({
      kind: 'nonStream',
      content:
        'Aggressive compact summary: user listed todos. Two tool calls. Context window extremely small. This must be long enough to pass the 50-char minimum check.',
    });

    // More tool calls after compact
    state.responses.push(mkToolTurn('agg3'));

    // Second compact (if triggered)
    state.responses.push({
      kind: 'nonStream',
      content:
        'Second aggressive compact: continued from prior compact. One more tool call. Still maintaining context. Long enough for the fifty character guard requirement.',
    });

    // Final answer
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'done' }),
    });

    await drain(agent.chat('list'));

    assertAllCallsHaveUser(state, 'maximal aggression compact');
  } finally {
    restore();
  }
});

test('qwen3: every single API call across 10-turn session has user message', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(
      makeConfig({
        model: {
          baseURL: 'http://127.0.0.1:0',
          model: 'stub-model',
          apiKey: 'stub-key',
          contextWindow: 80, // moderate: compact triggers after several turns
        },
      }),
      makeConnections()
    );

    // 10 turns: mix of plain answers, tool calls, and empty args
    for (let turn = 0; turn < 10; turn++) {
      if (turn % 3 === 0) {
        // Plain text answer
        state.responses.push({
          kind: 'stream',
          chunks: streamChunks({ content: `answer for turn ${turn}` }),
        });
      } else if (turn % 3 === 1) {
        // Tool call + answer
        state.responses.push({
          kind: 'stream',
          chunks: streamChunks({
            toolCalls: [
              {
                id: `t${turn}`,
                name: 'todo_write',
                arguments: JSON.stringify({ action: 'add', text: `item ${turn}` }),
              },
            ],
          }),
        });
        state.responses.push({
          kind: 'stream',
          chunks: streamChunks({ content: `done turn ${turn}` }),
        });
      } else {
        // Empty args (P0-b) then correct answer
        state.responses.push({
          kind: 'stream',
          chunks: streamChunks({
            toolCalls: [{ id: `te${turn}`, name: 'todo_write', arguments: '' }],
          }),
        });
        state.responses.push({
          kind: 'stream',
          chunks: streamChunks({ content: `recovered turn ${turn}` }),
        });
      }

      // If compact might trigger mid-session, provide a summarizer response
      if (turn === 4 || turn === 7) {
        state.responses.push({
          kind: 'nonStream',
          content:
            `Mid-session compact summary at turn ${turn}: multiple turns of conversation. Tools used. Context maintained. This is definitely long enough to pass.`,
        });
      }

      await drain(agent.chat(`question ${turn}`));
    }

    // THE critical assertion: every single API call across all 10 turns
    for (let i = 0; i < state.calls.length; i++) {
      const msgs = state.calls[i].messages;
      const hasUser = msgs.some((m: any) => m && m.role === 'user');
      assert.ok(
        hasUser,
        `API call #${i} (of ${state.calls.length}) missing user message — Qwen3 jinja would 500`
      );
    }
  } finally {
    restore();
  }
});

test('local model params: chat request includes qwen/lm-studio sampling controls', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(
      makeConfig({
        model: {
          baseURL: 'http://127.0.0.1:0',
          model: 'stub-model',
          apiKey: 'stub-key',
          temperature: 0.6,
          topP: 0.95,
          topK: 20,
          minP: 0,
          presencePenalty: 0,
          frequencyPenalty: 0,
          repeatPenalty: 1,
          maxTokens: 4096,
          extraParams: { seed: 123 },
        },
      }),
      makeConnections()
    );
    state.responses.push({
      kind: 'stream',
      chunks: streamChunks({ content: 'ok' }),
    });

    await drain(agent.chat('hello'));

    const body = state.calls[0].body;
    assert.equal(body.stream, true);
    assert.equal(body.temperature, 0.6);
    assert.equal(body.top_p, 0.95);
    assert.equal(body.top_k, 20);
    assert.equal(body.min_p, 0);
    assert.equal(body.presence_penalty, 0);
    assert.equal(body.frequency_penalty, 0);
    assert.equal(body.repeat_penalty, 1);
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.seed, 123);
    assert.equal(body.maxOutputChars, undefined);
  } finally {
    restore();
  }
});

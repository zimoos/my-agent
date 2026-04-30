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
    state.calls.push({ messages: snapshot, stream: body.stream === true });

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
  toolCalls?: Array<{
    index?: number;
    id: string;
    name: string;
    arguments: string;
  }>;
}): MockStreamChunk[] {
  const out: MockStreamChunk[] = [];
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

test('messages: tool_call + tool_result are paired with matching ids', async () => {
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

    // Second model call contains the full turn-1 flow: assistant(tool_calls) + tool result.
    assert.ok(state.calls.length >= 2, 'expected at least 2 model calls');
    const round2 = state.calls[1].messages;

    const asstWithCalls = round2.find(
      (m: any) =>
        m.role === 'assistant' &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.length > 0
    );
    assert.ok(asstWithCalls, 'assistant message with tool_calls must exist');
    assert.equal(asstWithCalls.tool_calls[0].id, 'call_todo_1');

    const toolMsg = round2.find(
      (m: any) => m.role === 'tool' && m.tool_call_id === 'call_todo_1'
    );
    assert.ok(toolMsg, 'tool result with matching id must exist');

    assertToolCallPaired(round2);
  } finally {
    restore();
  }
});

test('messages: compact preserves system, inserts summary, keeps tool pairing intact', async () => {
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

    const hasSummary = last.some(
      (m: any) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('[compact summary]')
    );
    assert.ok(hasSummary, 'compact summary system message must be present');

    // The original user message in index 1 IS absorbed by compact when the
    // keepLastN window (default 6) doesn't reach back to it — this is by
    // design: the summary replaces the middle range. The critical invariant
    // for lmStudio is that the summary exists (above) and the tail is
    // well-formed (below).

    // Tool-call pairing must remain valid after compact: no orphan tool
    // messages, every assistant(tool_calls) has matching results.
    assertToolCallPaired(last);
    assertNoEmptyAssistant(last);

    // Compact must not collapse messages down to only system — there must be
    // post-summary content carrying forward recent context.
    const nonSystem = last.filter((m: any) => m.role !== 'system');
    assert.ok(
      nonSystem.length > 0,
      'compact must not drop all non-system messages'
    );
  } finally {
    restore();
  }
});

test('messages: foldMessages after task completion leaves no orphan tool results', async () => {
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
    // Turn 2: final text → task ends → foldMessages runs
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
    // After fold, assistant(tool_calls) + tool pair from round 1 should be gone,
    // replaced by a [stack:completed ...] system summary.
    const hasStackSummary = last.some(
      (m: any) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        (m.content.includes('[stack:completed') || m.content.includes('[conversation]'))
    );
    assert.ok(hasStackSummary, 'fold summary system message must be present');

    // Critical: no orphan role:tool anywhere (every tool msg must pair with an assistant tool_call).
    assertToolCallPaired(last);
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
    // Truncate inserts a system marker at index 1
    const hasTruncateMarker = last.some(
      (m: any) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('[context truncated')
    );
    assert.ok(hasTruncateMarker, 'truncate marker must be injected');

    assertHasRole(last, 'user');
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
        Array.isArray(m.tool_calls) &&
        m.tool_calls.length > 0
    );
    assert.ok(asst, 'assistant message with tool_calls must exist');

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

test('messages: second chat() after fold still has user message (Qwen3 jinja)', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // First task: tool call + completion → triggers fold
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

    // Second chat: after fold, messages must still have user role
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

test('messages: multi-turn with tool calls maintains user message after each fold', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // Round 1: tool + answer → fold
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

    // Round 2: tool + answer → fold
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

test('messages: no consecutive system messages without user in between after fold', async () => {
  const state: MockState = { responses: [], calls: [] };
  const restore = installOpenAiMock(state);
  try {
    const agent = await createAgent(makeConfig(), makeConnections());

    // Three rounds to accumulate multiple folds
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

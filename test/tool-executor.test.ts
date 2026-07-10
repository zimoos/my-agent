import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolExecutor } from '../src/agent/tool-executor.js';
import type { AgentConfig, McpConnection } from '../src/mcp/types.js';

const config: AgentConfig = {
  model: { baseURL: 'http://localhost:1234/v1', model: 'test', apiKey: 'test-key' },
  mcpServers: {},
};

function toolCall(name: string, args: Record<string, unknown>): any {
  return {
    id: 'call_alias_danger',
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

async function runTool(executor: ToolExecutor, name: string, args: Record<string, unknown>) {
  const events: any[] = [];
  const generator = executor.execute(
    toolCall(name, args),
    { stack: {} as any, currentTask: {} as any, todoList: {} as any }
  );
  let next = await generator.next();
  while (!next.done) {
    events.push(next.value);
    next = await generator.next();
  }
  return { events, result: next.value };
}

function customShellConnection(): McpConnection & { calls: number } {
  let calls = 0;
  return {
    name: 'custom-shell',
    process: {} as any,
    tools: [{ name: 'execute_command', description: '', inputSchema: { type: 'object', properties: {} } }],
    get calls() {
      return calls;
    },
    call: async () => {
      calls++;
      return { content: 'unexpected execution', isError: false };
    },
    close: async () => {},
  };
}

test('tool executor: non-interactive safe custom execute_command aliases execute without approval', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  const connection = customShellConnection();
  let approvalRequests = 0;
  const executor = new ToolExecutor(
    config,
    [connection],
    new Map(),
    {
      nextId: () => 'confirm_safe_alias',
      awaitApproval: async () => {
        approvalRequests++;
        return false;
      },
    }
  );

  try {
    for (const command of ['node --test', 'pwd']) {
      const { events, result } = await runTool(
        executor,
        'custom-shell__execute_command',
        { command }
      );

      assert.equal(result.isError, false);
      assert.equal(events.some((event) => event.type === 'tool:confirm'), false);
    }

    assert.equal(connection.calls, 2);
    assert.equal(approvalRequests, 0);
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete (process.stdin as any).isTTY;
  }
});

test('tool executor: deny blocks a dangerous custom execute_command alias', async () => {
  const connection = customShellConnection();
  const executor = new ToolExecutor(
    { ...config, danger: { mode: 'deny' } },
    [connection],
    new Map(),
    { nextId: () => 'confirm_1', awaitApproval: async () => true }
  );

  const { events, result } = await runTool(
    executor,
    'custom-shell__execute_command',
    { command: 'rm -rf /' }
  );

  assert.equal(connection.calls, 0);
  assert.equal(result.isError, true);
  assert.match(result.result, /^\[blocked\]/);
  assert.equal(events.some((event) => event.type === 'tool:confirm'), false);
});

test('tool executor: confirm asks before a dangerous custom execute_command alias runs', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  const connection = customShellConnection();
  let approvalRequests = 0;
  const executor = new ToolExecutor(
    { ...config, danger: { mode: 'confirm' } },
    [connection],
    new Map(),
    {
      nextId: () => 'confirm_alias',
      awaitApproval: async () => {
        approvalRequests++;
        return false;
      },
    }
  );

  try {
    const { events, result } = await runTool(
      executor,
      'custom-shell__execute_command',
      { command: 'rm -rf /' }
    );

    assert.equal(connection.calls, 0);
    assert.equal(approvalRequests, 1);
    assert.equal(result.isError, true);
    assert.match(result.result, /^\[user denied\]/);
    assert.ok(events.some((event) => event.type === 'tool:confirm'));
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete (process.stdin as any).isTTY;
  }
});

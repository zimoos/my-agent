import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolExecutor } from '../src/agent/tool-executor.js';
import { FileReadLedger } from '../src/agent/file-read-ledger.js';
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

test('tool executor: ACP host confirmation works without a TTY', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  const connection = customShellConnection();
  let approvalRequests = 0;
  const executor = new ToolExecutor(
    { ...config, danger: { mode: 'confirm' } },
    [connection],
    new Map(),
    {
      nextId: () => 'confirm_host',
      awaitApproval: async () => {
        approvalRequests++;
        return true;
      },
    },
    new FileReadLedger(),
    true,
  );

  try {
    const { events, result } = await runTool(
      executor,
      'custom-shell__execute_command',
      { command: 'rm -rf /' },
    );

    assert.equal(approvalRequests, 1);
    assert.equal(connection.calls, 1);
    assert.equal(result.isError, false);
    assert.ok(events.some((event) => event.type === 'tool:confirm'));
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete (process.stdin as any).isTTY;
  }
});

test('tool executor: read_file pages use receipt-aware history and suppress duplicate bodies', async () => {
  const body = `1│${'middle-evidence-'.repeat(180)}`;
  const receipt = {
    kind: 'read_file_page',
    canonical_path: '/tmp/receipt.ts',
    file_hash: 'd'.repeat(64),
    cursor: '1:0',
    start_line: 1,
    start_column: 0,
    end_line: 1,
    end_column: body.length - 2,
    total_lines: 2,
    complete: false,
    next_offset: 2,
    next_cursor: '2:0',
    body_chars: body.length,
  };
  const connection: McpConnection = {
    name: 'fs',
    process: {} as any,
    tools: [{ name: 'read_file', description: '', inputSchema: { type: 'object', properties: {} } }],
    call: async () => ({
      content: `${body}\n[read_file receipt] ${JSON.stringify(receipt)}`,
      isError: false,
      structuredContent: { read_file_page: receipt },
    }),
    close: async () => {},
  };
  const ledger = new FileReadLedger();
  const executor = new ToolExecutor(
    config,
    [connection],
    new Map(),
    { nextId: () => 'confirm_read', awaitApproval: async () => true },
    ledger,
  );

  const first = await runTool(executor, 'fs__read_file', { path: '/tmp/receipt.ts' });
  assert.match(first.result.result, /middle-evidence/);
  assert.doesNotMatch(first.result.result, /tool result truncated/);
  assert.match(first.result.progressSummary, /页面未读完/);
  assert.ok(first.events.some((event) => event.type === 'tool:result' && /页面未读完/.test(event.content)));

  const duplicate = await runTool(executor, 'fs__read_file', { path: '/tmp/receipt.ts' });
  assert.match(duplicate.result.result, /duplicate_page/);
  assert.doesNotMatch(duplicate.result.result, /middle-evidence/);
  assert.match(duplicate.result.result, /cursor="2:0"/);

  const nextTaskExecutor = new ToolExecutor(
    config,
    [connection],
    new Map(),
    { nextId: () => 'confirm_read_again', awaitApproval: async () => true },
    ledger,
  );
  const firstReadInNextTask = await runTool(nextTaskExecutor, 'fs__read_file', { path: '/tmp/receipt.ts' });
  assert.match(firstReadInNextTask.result.result, /middle-evidence/);
  assert.doesNotMatch(firstReadInNextTask.result.result, /duplicate_page/);
});

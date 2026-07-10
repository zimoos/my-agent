import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import OpenAI from 'openai';
import { createAgent } from '../src/agent.js';
import { connectMcpServer } from '../src/mcp/client.js';
import type { AgentConfig, AgentEvent, McpConnection } from '../src/mcp/types.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

type StreamChunk = {
  choices: Array<{
    finish_reason?: string | null;
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

function findCompletionsPrototype(): any {
  const probe = new OpenAI({ baseURL: 'http://0.0.0.0', apiKey: 'test-key' });
  return Object.getPrototypeOf((probe as any).chat.completions);
}

function installProviderResponses(responses: StreamChunk[][]): () => void {
  const proto = findCompletionsPrototype();
  const original = proto.create;
  proto.create = function patched() {
    const chunks = responses.shift();
    if (!chunks) throw new Error('test provider: no response queued');
    return Promise.resolve((async function* () {
      for (const chunk of chunks) yield chunk;
    })() as any);
  };
  return () => {
    proto.create = original;
  };
}

function textResponse(content: string): StreamChunk[] {
  return [
    { choices: [{ delta: { content } }] },
    { choices: [{ finish_reason: 'stop', delta: {} }] },
  ];
}

function toolResponse(
  id: string,
  name: string,
  args: Record<string, unknown>
): StreamChunk[] {
  return [
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id,
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
      }],
    },
    { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
  ];
}

async function drain(
  stream: AsyncGenerator<AgentEvent, void, unknown>
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const config: AgentConfig = {
  model: {
    baseURL: 'http://127.0.0.1:0',
    model: 'evidence-gate-test',
    apiKey: 'test-key',
  },
  mcpServers: {},
  danger: { mode: 'off' },
};

async function realMcpConnection(name: string, serverFile: string): Promise<McpConnection> {
  return connectMcpServer(name, {
    command: process.execPath,
    args: ['--import', 'tsx', join(REPO_ROOT, 'servers', serverFile)],
    cwd: REPO_ROOT,
  });
}

function verifiedEvidenceFrom(events: AgentEvent[]): Record<string, unknown> {
  const result = events.find((event) => event.type === 'tool:result');
  assert.ok(result && result.type === 'tool:result', 'real tool result must be emitted');
  const evidence = result.structuredContent?.['my-agent/evidence'];
  assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence));
  assert.equal((evidence as Record<string, unknown>).status, 'verified');
  assert.equal(typeof (evidence as Record<string, unknown>).operation, 'string');
  return evidence as Record<string, unknown>;
}

function textOnlyWriteConnection(): McpConnection {
  return {
    name: 'fs',
    process: {} as any,
    tools: [{
      name: 'write_file',
      description: 'Write a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    }],
    call: async () => ({
      content: 'write_file completed',
      isError: false,
    }),
    close: async () => {},
  };
}

function canonicalEvidence(operation: string): Record<string, unknown> {
  return {
    'my-agent/evidence': {
      operation,
      status: 'verified',
    },
  };
}

function scriptedMcpConnection(
  name: string,
  toolName: string,
  results: Array<{
    content: string;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>
): McpConnection & { calls: Array<{ toolName: string; args: Record<string, any> }> } {
  const calls: Array<{ toolName: string; args: Record<string, any> }> = [];
  const queued = [...results];
  return {
    name,
    process: {} as any,
    tools: [{
      name: toolName,
      description: `Scripted fake ${toolName}`,
      inputSchema: {
        type: 'object',
        properties: {},
      },
    }],
    calls,
    call: async (calledToolName, args) => {
      calls.push({ toolName: calledToolName, args });
      const result = queued.shift();
      if (!result) throw new Error(`scripted MCP ${name}: no result queued`);
      return {
        content: result.content,
        isError: result.isError ?? false,
        structuredContent: result.structuredContent,
      };
    },
    close: async () => {},
  };
}

function taskFailed(events: AgentEvent[]): Extract<AgentEvent, { type: 'task:failed' }> {
  const failed = events.find((event) => event.type === 'task:failed');
  assert.ok(failed && failed.type === 'task:failed');
  return failed;
}

test('action task: successful tool text cannot report done without required evidence', async () => {
  const restore = installProviderResponses([
    toolResponse('call_write_1', 'fs__write_file', {
      path: './evidence-gate-output.txt',
      content: 'hello\n',
    }),
    textResponse('Created evidence-gate-output.txt successfully.'),
  ]);
  const agent = await createAgent(config, [textOnlyWriteConnection()]);

  try {
    const events = await drain(agent.chat(
      'Write the exact text hello into ./evidence-gate-output.txt and report completion.'
    ));
    const done = events.find((event) => event.type === 'task:done');
    const failed = events.find((event) => event.type === 'task:failed');

    assert.equal(done, undefined, 'action task must not emit task:done without evidence');
    assert.ok(failed && failed.type === 'task:failed');
    assert.match(failed.error, /evidence|proof|verify|证据|验证/i);
  } finally {
    restore();
    await agent.close();
  }
});

const missingEvidenceAliasCases = [
  {
    serverName: 'custom-shell',
    toolName: 'execute_command',
    fullToolName: 'custom-shell__execute_command',
    args: { command: 'printf alias-exec-ok', cwd: '/tmp', timeout: 1000 },
  },
  {
    serverName: 'project-editor',
    toolName: 'file_edit',
    fullToolName: 'project-editor__file_edit',
    args: { path: 'notes.txt', old_string: 'before', new_string: 'after' },
  },
  {
    serverName: 'artifact-writer',
    toolName: 'write_file',
    fullToolName: 'artifact-writer__write_file',
    args: { path: 'notes.txt', content: 'after\n' },
  },
] as const;

for (const action of missingEvidenceAliasCases) {
  test(`action task: arbitrary alias ${action.fullToolName} cannot complete without evidence`, async () => {
    const connection = scriptedMcpConnection(action.serverName, action.toolName, [{
      content: `${action.toolName} succeeded with text only`,
    }]);
    const restore = installProviderResponses([
      toolResponse(`call_${action.toolName}_alias_missing`, action.fullToolName, action.args),
      textResponse(`${action.toolName} completed successfully.`),
    ]);
    const agent = await createAgent(config, [connection]);

    try {
      const events = await drain(agent.chat(`Run ${action.fullToolName} and report completion.`));
      const failed = taskFailed(events);

      assert.equal(connection.calls.length, 1);
      assert.equal(events.some((event) => event.type === 'task:done'), false);
      assert.match(failed.error, /missing_evidence|evidence|proof|verify|证据|验证/i);
    } finally {
      restore();
      await agent.close();
    }
  });
}

for (const mode of ['deny', 'confirm'] as const) {
  test(`danger ${mode}: arbitrary execute_command alias is blocked by its tool suffix`, async () => {
    const connection = scriptedMcpConnection('custom-shell', 'execute_command', [{
      content: 'dangerous command should never reach the alias server',
    }]);
    const restore = installProviderResponses([
      toolResponse('call_alias_danger', 'custom-shell__execute_command', {
        command: 'rm -rf /',
      }),
      textResponse('The command was handled.'),
    ]);
    const agent = await createAgent({ ...config, danger: { mode } }, [connection]);

    try {
      const events = await drain(agent.chat('Run the command now.'));
      const result = events.find((event) => event.type === 'tool:result');

      assert.equal(connection.calls.length, 0, 'danger policy must run before alias routing');
      assert.ok(result && result.type === 'tool:result');
      assert.equal(result.ok, false);
      assert.match(result.content, /^\[blocked\]/);
    } finally {
      restore();
      await agent.close();
    }
  });
}

const realActionCases = [
  {
    label: 'file_edit',
    serverName: 'fs-edit',
    serverFile: 'fs-edit-mcp.ts',
    fullToolName: 'fs-edit__file_edit',
    args: (dir: string) => ({
      path: join(dir, 'edited.txt'),
      old_string: 'before',
      new_string: 'after',
    }),
    prepare: (dir: string) => writeFile(join(dir, 'edited.txt'), 'before\n', 'utf8'),
    verify: async (dir: string) => assert.equal(
      await readFile(join(dir, 'edited.txt'), 'utf8'),
      'after\n',
    ),
  },
  {
    label: 'write_file',
    serverName: 'fs',
    serverFile: 'fs-mcp.ts',
    fullToolName: 'fs__write_file',
    args: (dir: string) => ({
      path: join(dir, 'written.txt'),
      content: 'written by the real fs tool\n',
    }),
    prepare: async () => {},
    verify: async (dir: string) => assert.equal(
      await readFile(join(dir, 'written.txt'), 'utf8'),
      'written by the real fs tool\n',
    ),
  },
  {
    label: 'execute_command',
    serverName: 'exec-mcp',
    serverFile: 'exec-mcp.ts',
    fullToolName: 'exec-mcp__execute_command',
    args: (dir: string) => ({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('command-evidence-ok')")}`,
      cwd: dir,
    }),
    prepare: async () => {},
    verify: async () => {},
  },
] as const;

for (const action of realActionCases) {
  test(`action task: real ${action.label} evidence permits completion`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'my-agent-evidence-gate-'));
    await action.prepare(dir);
    const connection = await realMcpConnection(action.serverName, action.serverFile);
    const restore = installProviderResponses([
      toolResponse(`call_${action.label}`, action.fullToolName, action.args(dir)),
      textResponse(`${action.label} completed and verified.`),
    ]);
    const agent = await createAgent(config, [connection]);

    try {
      const events = await drain(agent.chat(`Perform the ${action.label} action now.`));
      const evidence = verifiedEvidenceFrom(events);

      assert.equal(evidence.operation, action.label);
      assert.ok(events.some((event) => event.type === 'task:done'));
      assert.equal(events.some((event) => event.type === 'task:failed'), false);
      await action.verify(dir);
    } finally {
      restore();
      await agent.close();
      await connection.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('action task: same execute_command retry clears earlier missing evidence when only timeout changes', async () => {
  const command = 'printf semantic-retry-ok';
  const firstArgs = { command, cwd: '/tmp/shared-cwd', timeout: 1000 };
  const retryArgs = { command, cwd: '/tmp/shared-cwd', timeout: 5000 };
  const connection = scriptedMcpConnection('exec-mcp', 'execute_command', [
    { content: 'execute_command succeeded without structured evidence' },
    {
      content: 'execute_command verified on retry',
      structuredContent: canonicalEvidence('execute_command'),
    },
  ]);
  const restore = installProviderResponses([
    toolResponse('call_exec_missing', 'exec-mcp__execute_command', firstArgs),
    toolResponse('call_exec_verified_retry', 'exec-mcp__execute_command', retryArgs),
    textResponse('The command retry is verified and complete.'),
  ]);
  const agent = await createAgent(config, [connection]);

  try {
    const events = await drain(agent.chat('Run the command and retry until it has proof.'));

    assert.equal(connection.calls.length, 2);
    assert.equal(connection.calls[0].args.command, connection.calls[1].args.command);
    assert.equal(connection.calls[0].args.cwd, connection.calls[1].args.cwd);
    assert.notEqual(connection.calls[0].args.timeout, connection.calls[1].args.timeout);
    assert.equal(events.some((event) => event.type === 'task:failed'), false);
    assert.ok(events.some((event) => event.type === 'task:done'));
  } finally {
    restore();
    await agent.close();
  }
});

test('action task: verified execute_command in another cwd cannot clear missing evidence', async () => {
  // The old cwd-changing retry test was wrong: relative commands observe a different workspace.
  const command = 'printf semantic-retry-ok';
  const firstArgs = { command, cwd: '/tmp/a', timeout: 1000 };
  const retryArgs = { command, cwd: '/tmp/b', timeout: 5000 };
  const connection = scriptedMcpConnection('exec-mcp', 'execute_command', [
    { content: 'execute_command succeeded without structured evidence' },
    {
      content: 'execute_command verified in another cwd',
      structuredContent: canonicalEvidence('execute_command'),
    },
  ]);
  const restore = installProviderResponses([
    toolResponse('call_exec_missing_cwd_a', 'exec-mcp__execute_command', firstArgs),
    toolResponse('call_exec_verified_cwd_b', 'exec-mcp__execute_command', retryArgs),
    textResponse('The command retry is verified and complete.'),
  ]);
  const agent = await createAgent(config, [connection]);

  try {
    const events = await drain(agent.chat('Run the command and retry until it has proof.'));
    const failed = taskFailed(events);

    assert.equal(connection.calls.length, 2);
    assert.equal(connection.calls[0].args.command, connection.calls[1].args.command);
    assert.notEqual(connection.calls[0].args.cwd, connection.calls[1].args.cwd);
    assert.notEqual(connection.calls[0].args.timeout, connection.calls[1].args.timeout);
    assert.equal(events.some((event) => event.type === 'task:done'), false);
    assert.match(failed.error, /call_exec_missing_cwd_a.*final=missing/);
    assert.doesNotMatch(failed.error, /call_exec_verified_cwd_b/);
  } finally {
    restore();
    await agent.close();
  }
});

const executeCommandLaterFailureCases = [
  {
    label: 'missing evidence',
    laterCallId: 'call_exec_later_missing',
    laterResult: { content: 'execute_command later succeeded without structured evidence' },
    finalStatus: 'missing',
  },
  {
    label: 'failed status',
    laterCallId: 'call_exec_later_failed',
    laterResult: { content: 'execute_command later failed', isError: true },
    finalStatus: 'failed',
  },
] as const;

for (const scenario of executeCommandLaterFailureCases) {
  test(`action task: later execute_command retry ${scenario.label} blocks completion after recovery`, async () => {
    const command = 'printf semantic-later-failure';
    const firstArgs = { command, cwd: '/tmp/shared-cwd', timeout: 1000 };
    const verifiedArgs = { command, cwd: '/tmp/shared-cwd', timeout: 5000 };
    const laterArgs = { command, cwd: '/tmp/shared-cwd', timeout: 9000 };
    const connection = scriptedMcpConnection('exec-mcp', 'execute_command', [
      { content: 'execute_command first succeeded without structured evidence' },
      {
        content: 'execute_command verified on recovery',
        structuredContent: canonicalEvidence('execute_command'),
      },
      scenario.laterResult,
    ]);
    const restore = installProviderResponses([
      toolResponse('call_exec_initial_missing', 'exec-mcp__execute_command', firstArgs),
      toolResponse('call_exec_recovered_verified', 'exec-mcp__execute_command', verifiedArgs),
      toolResponse(scenario.laterCallId, 'exec-mcp__execute_command', laterArgs),
      textResponse('The command sequence is complete.'),
    ]);
    const agent = await createAgent(config, [connection]);

    try {
      const events = await drain(agent.chat('Run the command, recover proof, then retry it again.'));
      const failed = taskFailed(events);

      assert.equal(connection.calls.length, 3);
      assert.equal(connection.calls[0].args.command, connection.calls[1].args.command);
      assert.equal(connection.calls[1].args.command, connection.calls[2].args.command);
      assert.equal(connection.calls[0].args.cwd, connection.calls[1].args.cwd);
      assert.equal(connection.calls[1].args.cwd, connection.calls[2].args.cwd);
      assert.notEqual(connection.calls[0].args.timeout, connection.calls[1].args.timeout);
      assert.notEqual(connection.calls[1].args.timeout, connection.calls[2].args.timeout);
      assert.equal(events.some((event) => event.type === 'task:done'), false);
      assert.match(failed.error, new RegExp(`${scenario.laterCallId}.*final=${scenario.finalStatus}`));
      assert.doesNotMatch(failed.error, /call_exec_initial_missing/);
    } finally {
      restore();
      await agent.close();
    }
  });
}

test('action task: a verified retry recovers from an earlier missing-evidence result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'my-agent-evidence-retry-'));
  const path = join(dir, 'retry.txt');
  const realConnection = await realMcpConnection('fs', 'fs-mcp.ts');
  let callCount = 0;
  const retryConnection: McpConnection = {
    name: realConnection.name,
    process: realConnection.process,
    tools: realConnection.tools,
    call: async (toolName, args, signal, onProgress) => {
      callCount++;
      if (callCount === 1) {
        return { content: 'write_file reported success without evidence', isError: false };
      }
      return realConnection.call(toolName, args, signal, onProgress);
    },
    close: () => realConnection.close(),
  };
  const args = { path, content: 'verified retry\n' };
  const restore = installProviderResponses([
    toolResponse('call_write_missing', 'fs__write_file', args),
    toolResponse('call_write_retry', 'fs__write_file', args),
    textResponse('The verified retry completed the write.'),
  ]);
  const agent = await createAgent(config, [retryConnection]);

  try {
    const events = await drain(agent.chat('Write retry.txt and retry if proof is missing.'));

    assert.equal(callCount, 2);
    assert.equal(await readFile(path, 'utf8'), 'verified retry\n');
    assert.ok(events.some((event) => event.type === 'task:done'));
    assert.equal(events.some((event) => event.type === 'task:failed'), false);
  } finally {
    restore();
    await agent.close();
    await retryConnection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('knowledge-only answer: plain assistant text remains completion-compatible', async () => {
  const restore = installProviderResponses([
    textResponse('Paris is the capital of France.'),
  ]);
  const agent = await createAgent(config, []);

  try {
    const events = await drain(agent.chat('What is the capital of France?'));
    assert.ok(events.some((event) => event.type === 'task:done'));
    assert.equal(events.some((event) => event.type === 'task:failed'), false);
    assert.match(
      events
        .filter((event) => event.type === 'token')
        .map((event) => event.text)
        .join(''),
      /Paris/
    );
  } finally {
    restore();
    await agent.close();
  }
});

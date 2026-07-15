import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import * as acpRuntime from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import { MaAcpAgent } from '../src/acp/server.js';
import type { BootstrapOptions, BootstrapResult } from '../src/index.js';
import type { Agent, AgentEvent, ChatContent } from '../src/mcp/types.js';

function fakeAgent(confirmations: Array<{ requestId: string; approved: boolean }>): Agent {
  return {
    async *chat(message: ChatContent, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
      if (message === 'wait') {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'aborted' };
        return;
      }
      yield { type: 'token', text: 'done' };
      yield { type: 'tool:call', name: 'exec-mcp__execute_command', args: { command: 'date' } };
      yield { type: 'tool:confirm', requestId: 'confirm-1', cmd: 'date', reason: 'test' };
      yield { type: 'tool:result', ok: true, content: 'ok' };
      yield { type: 'context:usage', used: 10, total: 100, compactThreshold: 80, source: 'test' };
    },
    reset() {},
    getTaskStack() { return {} as ReturnType<Agent['getTaskStack']>; },
    getArchive() { return null; },
    abortAll() { return 1; },
    revertLastTurnContextOnly() { return 0; },
    respondConfirm(requestId, approved) { confirmations.push({ requestId, approved }); },
    getContextUsage() { return { used: 0, total: 100, compactThreshold: 80, source: 'test' }; },
    inspectContext() { return ''; },
    searchContext() { return []; },
    recallContext() { return ''; },
    pinContext() { return ''; },
    activeContext() { return []; },
    poolContext() { return []; },
    dropContext() { return ''; },
    clearActiveContext() { return ''; },
    async close() {},
  };
}

test('MA ACP exposes a host-owned session, forwards events, permissions, cancellation, and close', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ma-acp-'));
  const updates: acp.SessionNotification[] = [];
  const permissions: acp.RequestPermissionRequest[] = [];
  const confirmations: Array<{ requestId: string; approved: boolean }> = [];
  const bootstrapCalls: Array<{ configPath?: string; options?: BootstrapOptions }> = [];
  let closed = 0;
  const agent = fakeAgent(confirmations);
  agent.close = async () => { closed += 1; };
  const connection = {
    sessionUpdate: async (params: acp.SessionNotification) => { updates.push(params); },
    requestPermission: async (params: acp.RequestPermissionRequest) => {
      permissions.push(params);
      return { outcome: { outcome: 'selected', optionId: 'allow' } } as acp.RequestPermissionResponse;
    },
  } as acp.AgentSideConnection;
  const bootstrapSession = async (
    configPath?: string,
    options?: BootstrapOptions,
  ): Promise<BootstrapResult> => {
    bootstrapCalls.push({ configPath, options });
    return {
      config: {
        model: { baseURL: 'http://127.0.0.1:1/v1', model: 'test', apiKey: 'test' },
        mcpServers: {},
      },
      configPath: configPath ?? null,
      configSources: [],
      createdDefault: false,
      connections: [],
      agent,
      sessionId: 'ma-session-1',
      resumed: false,
      connectionFailures: [],
    };
  };
  const server = new MaAcpAgent(connection, {
    configPath: '/host/ma.json',
    sessionDir: join(cwd, 'sessions'),
    bootstrapSession,
  });

  try {
    const initialized = await server.initialize({ protocolVersion: 1 });
    assert.equal(initialized.agentInfo?.name, 'ma');
    assert.equal(initialized.agentCapabilities?.sessionCapabilities?.close !== undefined, true);

    const created = await server.newSession({
      cwd,
      mcpServers: [{
        name: 'zimoos',
        command: process.execPath,
        args: ['zimoos.mjs'],
        env: [{ name: 'ROLE_INSTANCE_ID', value: 'primary' }],
      }],
      _meta: { mteam: { systemPrompt: 'You are the primary MTEAM agent.' } },
    });
    assert.equal(created.sessionId, 'ma-session-1');
    assert.equal(bootstrapCalls[0]?.configPath, '/host/ma.json');
    assert.equal(bootstrapCalls[0]?.options?.cwd, cwd);
    assert.equal(bootstrapCalls[0]?.options?.systemPrompt, 'You are the primary MTEAM agent.');
    assert.equal(bootstrapCalls[0]?.options?.confirmationChannel, 'host');
    assert.deepEqual(bootstrapCalls[0]?.options?.mcpServers?.zimoos.env, { ROLE_INSTANCE_ID: 'primary' });

    const response = await server.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'ship it' }],
    });
    assert.equal(response.stopReason, 'end_turn');
    assert.deepEqual(
      updates.map((item) => item.update.sessionUpdate),
      ['agent_message_chunk', 'tool_call', 'tool_call_update', 'usage_update'],
    );
    assert.equal(permissions.length, 1);
    assert.deepEqual(confirmations, [{ requestId: 'confirm-1', approved: true }]);

    const waiting = server.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'wait' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await server.cancel({ sessionId: created.sessionId });
    assert.equal((await waiting).stopReason, 'cancelled');

    await server.closeSession({ sessionId: created.sessionId });
    assert.equal(closed, 1);
  } finally {
    await server.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MA ACP rejects non-stdio MCP transports', async () => {
  const server = new MaAcpAgent({} as acp.AgentSideConnection, {
    bootstrapSession: async () => { throw new Error('bootstrap must not run'); },
  });
  await assert.rejects(
    server.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'remote', type: 'http', url: 'http://localhost:1', headers: [] }],
    }),
    /supports stdio MCP only/,
  );
});

test('ma acp CLI completes a real ACP stdio handshake and exits when the host disconnects', async () => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli/index.tsx', 'acp'],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const stream = acpRuntime.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const client: acpRuntime.Client = {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  };
  const connection = new acpRuntime.ClientSideConnection(() => client, stream);
  try {
    const initialized = await connection.initialize({
      protocolVersion: acpRuntime.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    assert.equal(initialized.agentInfo?.name, 'ma');
    assert.equal(initialized.protocolVersion, acpRuntime.PROTOCOL_VERSION);
  } finally {
    child.stdin.end();
  }
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null);
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
});

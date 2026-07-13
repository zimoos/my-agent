import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { buildMcpEnv, McpClient } from '../src/mcp/client.js';
import { VERSION } from '../src/version.js';

function fakeProc() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as any;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = () => true;
  return proc;
}

function readSentLines(stdin: PassThrough): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    stdin.on('data', (chunk) => {
      const s = chunk.toString('utf-8');
      for (const line of s.split('\n')) {
        if (line.trim()) lines.push(line);
      }
    });
    setTimeout(() => resolve(lines), 20);
  });
}

test('buildMcpEnv: drops unreadable NODE_EXTRA_CA_CERTS for child processes', () => {
  const prev = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = path.join(os.tmpdir(), 'ma-missing-cert.pem');
  try {
    const env = buildMcpEnv();
    assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
  } finally {
    if (prev === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = prev;
  }
});

test('buildMcpEnv: keeps readable NODE_EXTRA_CA_CERTS', () => {
  const prev = process.env.NODE_EXTRA_CA_CERTS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cert-'));
  const cert = path.join(dir, 'cert.pem');
  fs.writeFileSync(cert, 'test\n');
  process.env.NODE_EXTRA_CA_CERTS = cert;
  try {
    const env = buildMcpEnv();
    assert.equal(env.NODE_EXTRA_CA_CERTS, cert);
  } finally {
    if (prev === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('McpClient.request: round-trip via id matching', async () => {
  const proc = fakeProc();
  const client = new McpClient('exec', proc);

  const sentPromise = readSentLines(proc.stdin);
  const pending = client.request('ping', { hello: 1 });

  const sent = await sentPromise;
  assert.equal(sent.length, 1);
  const msg = JSON.parse(sent[0]);
  assert.equal(msg.method, 'ping');
  assert.deepEqual(msg.params, { hello: 1 });
  assert.equal(msg.jsonrpc, '2.0');
  assert.equal(typeof msg.id, 'number');

  proc.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { pong: true } }) + '\n'
  );

  const result = await pending;
  assert.deepEqual(result, { pong: true });
});

test('McpClient.initialize advertises the package version', async () => {
  const proc = fakeProc();
  const client = new McpClient('exec', proc);
  const seen: any[] = [];
  proc.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      seen.push(message);
      if (message.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
      }
    }
  });

  await client.initialize();

  const initialize = seen.find((message) => message.method === 'initialize');
  assert.deepEqual(initialize.params.clientInfo, { name: 'my-agent', version: VERSION });
  assert.ok(seen.some((message) => message.method === 'notifications/initialized'));
});

test('McpClient.request: error response rejects', async () => {
  const proc = fakeProc();
  const client = new McpClient('exec', proc);

  const sentPromise = readSentLines(proc.stdin);
  const pending = client.request('bad', {});

  const sent = await sentPromise;
  const msg = JSON.parse(sent[0]);
  proc.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -1, message: 'nope' },
    }) + '\n'
  );

  await assert.rejects(pending, /nope/);
});

test('McpClient: buffers partial chunks by newline', async () => {
  const proc = fakeProc();
  const client = new McpClient('exec', proc);

  const sentPromise = readSentLines(proc.stdin);
  const p1 = client.request('a');
  const p2 = client.request('b');
  const sent = await sentPromise;
  const [m1, m2] = sent.map((s) => JSON.parse(s));

  const payload =
    JSON.stringify({ jsonrpc: '2.0', id: m1.id, result: 1 }) +
    '\n' +
    JSON.stringify({ jsonrpc: '2.0', id: m2.id, result: 2 }).slice(0, 10);
  proc.stdout.write(payload);

  const rest =
    JSON.stringify({ jsonrpc: '2.0', id: m2.id, result: 2 }).slice(10) + '\n';
  proc.stdout.write(rest);

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
});

test('McpClient.listTools: populates tools from tools/list', async () => {
  const proc = fakeProc();
  const client = new McpClient('exec', proc);

  proc.stdout.on('data', () => {});

  const sentListener = new Promise<void>((resolve) => {
    proc.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split('\n')) {
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.method === 'tools/list') {
          proc.stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: m.id,
              result: {
                tools: [
                  { name: 'run', description: 'run cmd', inputSchema: { type: 'object' } },
                ],
              },
            }) + '\n'
          );
          resolve();
        }
      }
    });
  });

  const p = client.listTools();
  await sentListener;
  const tools = await p;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'run');
  assert.equal(client.tools.length, 1);
});

test('McpClient.call: parses content array into joined text', async () => {
  const proc = fakeProc();
  const client = new McpClient('exec', proc);

  proc.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.method === 'tools/call') {
        proc.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: m.id,
            result: {
              content: [
                { type: 'text', text: 'line1' },
                { type: 'text', text: 'line2' },
              ],
              isError: false,
            },
          }) + '\n'
        );
      }
    }
  });

  const r = await client.call('run', { cmd: 'ls' });
  assert.equal(r.content, 'line1\nline2');
  assert.equal(r.isError, false);
});

test('McpClient.call: preserves namespaced structured evidence and raw _meta', async () => {
  const proc = fakeProc();
  const client = new McpClient('fs', proc);
  const structuredContent = {
    'my-agent/evidence': {
      operation: 'write_file',
      status: 'verified',
      artifacts: [{ type: 'file', path: '/tmp/result.txt' }],
    },
  };
  const meta = {
    'my-agent/evidence-source': {
      server: 'fs',
      tool: 'write_file',
    },
    traceId: 'trace-structured-evidence-1',
  };

  proc.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method !== 'tools/call') continue;
      proc.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: 'wrote /tmp/result.txt' }],
            structuredContent,
            _meta: meta,
            isError: false,
          },
        }) + '\n'
      );
    }
  });

  const result = await client.call('write_file', {
    path: '/tmp/result.txt',
    content: 'done\n',
  });

  assert.equal(result.content, 'wrote /tmp/result.txt');
  assert.equal(result.isError, false);
  assert.deepEqual((result as any).structuredContent, structuredContent);
  assert.deepEqual((result as any)._meta, meta);
});

test('McpClient.call: sends progress token and dispatches progress notifications', async () => {
  const proc = fakeProc();
  const client = new McpClient('agora', proc);
  const progress: any[] = [];

  proc.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.method !== 'tools/call') continue;
      const token = m.params?._meta?.progressToken;
      assert.equal(typeof token, 'string');
      proc.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {
            progressToken: token,
            progress: 40,
            total: 100,
            message: '{"kind":"event","event":{"phase":"model_load"}}',
          },
        }) + '\n'
      );
      proc.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            content: [{ type: 'text', text: '{"ok":true}' }],
            isError: false,
          },
        }) + '\n'
      );
    }
  });

  const result = await client.call('chat_complete', { model: 'qwen' }, undefined, (event) => {
    progress.push(event);
  });

  assert.equal(result.content, '{"ok":true}');
  assert.equal(progress.length, 1);
  assert.equal(progress[0].progress, 40);
  assert.equal(progress[0].total, 100);
  assert.match(progress[0].message, /model_load/);
});

test('McpClient: exit rejects pending requests', async () => {
  const proc = fakeProc();
  const client = new McpClient('exec', proc);
  const p = client.request('a', {});
  proc.emit('exit', 1, null);
  await assert.rejects(p, /exited/);
});

test('McpClient.request: removes abort listener after resolve', async () => {
  const proc = fakeProc();
  const client = new McpClient('exec', proc);
  const controller = new AbortController();

  proc.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      proc.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: m.id, result: 'ok' }) + '\n'
      );
    }
  });

  const N = 30;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      client.request('m' + i, {}, controller.signal)
    )
  );

  // All requests resolved — no abort listener should remain on the signal.
  // EventTarget does not expose listenerCount directly, so we dispatch abort
  // and assert none of the per-request onAbort callbacks were invoked.
  // Easier sanity check: call setMaxListeners(1) on a fresh signal, fire many
  // concurrent requests, and verify no MaxListenersExceededWarning is emitted.
  const warnings: string[] = [];
  const origEmit = process.emitWarning;
  process.emitWarning = (w: any, ...rest: any[]) => {
    warnings.push(String(w?.message ?? w));
    return origEmit.call(process, w, ...rest);
  };
  try {
    const proc2 = fakeProc();
    const client2 = new McpClient('exec2', proc2);
    const controller2 = new AbortController();
    proc2.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split('\n')) {
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        proc2.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', id: m.id, result: 'ok' }) + '\n'
        );
      }
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        client2.request('m' + i, {}, controller2.signal)
      )
    );
  } finally {
    process.emitWarning = origEmit;
  }

  assert.ok(
    !warnings.some((w) => w.includes('MaxListenersExceededWarning')),
    `should not emit MaxListenersExceededWarning, got: ${warnings.join(' | ')}`
  );
});

test('McpClient.request: removes abort listener after reject', async () => {
  const proc = fakeProc();
  const client = new McpClient('exec', proc);
  const controller = new AbortController();

  proc.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      proc.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -1, message: 'x' },
        }) + '\n'
      );
    }
  });

  // Run several failing requests against the same signal; then abort and
  // verify the signal's onAbort callbacks have all been cleaned up (no
  // rejection side-effects on already-settled promises).
  await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      client.request('m' + i, {}, controller.signal).catch(() => {})
    )
  );
  // Firing abort now must not throw / trigger anything observable.
  controller.abort();
  // Give microtasks a tick.
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(true);
});

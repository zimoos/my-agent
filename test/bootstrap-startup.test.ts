import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hydrateBootstrap, shutdown, type BootstrapPreparation } from '../src/index.js';
import { createSessionStore } from '../src/session/store.js';

function serverSource(delayMs: number, fail = false): string {
  if (fail) return 'process.exit(23);\n';
  return `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.argv[2], process.argv[3]), String(Date.now()));
let buffer = '';
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
    const result = request.method === 'tools/list' ? { tools: [] } : {
      protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1' }
    };
    setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n'), ${delayMs});
  }
});
`;
}

test('bootstrap hydration connects five MCP servers in parallel, preserves config order, and isolates failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-bootstrap-'));
  try {
    const slowA = join(dir, 'slow-a.mjs');
    const slowB = join(dir, 'slow-b.mjs');
    const slowC = join(dir, 'slow-c.mjs');
    const broken = join(dir, 'broken.mjs');
    const slowD = join(dir, 'slow-d.mjs');
    const slowE = join(dir, 'slow-e.mjs');
    const markers = join(dir, 'markers');
    mkdirSync(markers);
    writeFileSync(slowA, serverSource(140));
    writeFileSync(slowB, serverSource(140));
    writeFileSync(slowC, serverSource(140));
    writeFileSync(broken, serverSource(0, true));
    writeFileSync(slowD, serverSource(140));
    writeFileSync(slowE, serverSource(140));
    const config = {
      model: {
        provider: 'openai',
        baseURL: 'http://127.0.0.1:9/v1',
        model: 'parallel-test',
        apiKey: 'test',
        contextWindow: 32768,
      },
      mcpServers: {
        alpha: { command: process.execPath, args: [slowA, markers, 'alpha'] },
        beta: { command: process.execPath, args: [slowB, markers, 'beta'] },
        gamma: { command: process.execPath, args: [slowC, markers, 'gamma'] },
        broken: { command: process.execPath, args: [broken] },
        delta: { command: process.execPath, args: [slowD, markers, 'delta'] },
        omega: { command: process.execPath, args: [slowE, markers, 'omega'] },
      },
    };
    const sessionStore = createSessionStore(join(dir, 'sessions'));
    const sessionId = sessionStore.create({ createdAt: Date.now(), cwd: dir, model: 'parallel-test' });
    const prepared: BootstrapPreparation = {
      config,
      configPath: null,
      configSources: [],
      createdDefault: false,
      sessionStore,
      sessionId,
      resumed: false,
      contextWindowConfigured: true,
      cwd: dir,
    };
    const boot = await hydrateBootstrap(prepared);
    try {
      const startedAt = ['alpha', 'beta', 'gamma', 'delta', 'omega'].map((name) =>
        Number(readFileSync(join(markers, name), 'utf8'))
      );
      assert.ok(Math.max(...startedAt) - Math.min(...startedAt) < 700, 'MCP processes did not start in parallel');
      assert.deepEqual(boot.connections.map((connection) => connection.name), ['alpha', 'beta', 'gamma', 'delta', 'omega']);
      assert.equal(boot.connectionFailures.length, 1);
      assert.equal(boot.connectionFailures[0]?.name, 'broken');
    } finally {
      await shutdown(boot.connections, boot.agent);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const redirect of [false, true]) test(`authenticated capability discovery ${redirect ? 'rejects redirects without leaking credentials' : 'uses the protected context window'}`, async () => {
  const { createServer } = await import('node:http');
  const dir = mkdtempSync(join(tmpdir(), 'ma-model-metadata-'));
  const requests: string[] = [];
  let redirectedRequests = 0;
  const target = createServer((_req, res) => { redirectedRequests++; res.end('{}'); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetPort = (target.address() as import('node:net').AddressInfo).port;
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.headers.authorization !== 'Bearer test-capability') { res.writeHead(401); res.end('{}'); return; }
    if (redirect) { res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/capture` }); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'ma-text', max_context_length: 131072 }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const sessionStore = createSessionStore(join(dir, 'sessions'));
  try {
    const boot = await hydrateBootstrap({
      config: { model: { provider: 'lmstudio', baseURL: `http://127.0.0.1:${port}/v1`, model: 'ma-text', apiKey: 'test-capability' }, mcpServers: {} },
      configPath: null, configSources: [], createdDefault: false, sessionStore,
      sessionId: sessionStore.create({ createdAt: Date.now(), cwd: dir, model: 'ma-text' }),
      resumed: false, contextWindowConfigured: false, cwd: dir, loadAgentInstructions: false,
    });
    try {
      assert.equal(boot.config.model.contextWindow, redirect ? 32768 : 131072);
      assert.equal(boot.config.model.contextWindowSource, redirect ? 'default' : 'lmstudio');
      assert.deepEqual(requests, ['/v1/models', '/api/v0/models']);
      assert.equal(redirectedRequests, 0);
    } finally { await shutdown(boot.connections, boot.agent); }
  } finally {
    server.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
    rmSync(dir, { recursive: true, force: true });
  }
});

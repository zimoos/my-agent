import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { McpClient } from '../src/mcp/client.js';

function fixture(timeout = 25) {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: () => true,
  });
  const sent: any[] = [];
  proc.stdin.on('data', (bytes: Buffer) => {
    for (const line of bytes.toString().trim().split('\n')) sent.push(JSON.parse(line));
  });
  const client = new McpClient('exec', proc as any, timeout);
  const reply = (id: number, result: unknown) => proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  return { client, sent, reply };
}

test('a declared execution deadline outlives the generic MCP request timer', async () => {
  for (const [name, args] of [
    ['execute_command', { command: 'npm test', timeout: 200 }],
    ['start_process', { command: 'npm start', readyTimeout: 200 }],
  ] as const) {
    const {client, sent, reply} = fixture();
    const pending = client.call(name, args);
    setTimeout(() => reply(sent[0].id, {content:[{type:'text',text:'verified result'}],isError:false}), 65);
    assert.equal((await pending).content,'verified result');
    assert.equal(sent.length,1);
  }
});

test('unrelated tools retain their deadline and receive request-bound cancellation', async () => {
  const {client,sent} = fixture();
  await assert.rejects(client.call('lookup', { timeout: 60_000 }), /timed out after 25ms/);
  assert.equal(sent[1].method,'notifications/cancelled');
  assert.equal(sent[1].params.requestId,sent[0].id);
});

test('abort cancels only the in-flight request and ignores late responses', async () => {
  const {client,sent,reply} = fixture(1000);
  const controller = new AbortController();
  const first = client.call('execute_command', {command:'long build'}, controller.signal);
  const second = client.call('lookup', {});
  controller.abort();
  await assert.rejects(first, {name:'AbortError'});
  const cancel = sent.find(item=>item.method==='notifications/cancelled');
  assert.equal(cancel.params.requestId,sent[0].id);
  reply(sent[0].id,{content:[{type:'text',text:'late'}]});
  reply(sent[1].id,{content:[{type:'text',text:'other request complete'}]});
  assert.equal((await second).content,'other request complete');
  assert.equal(sent.filter(item=>item.method==='notifications/cancelled').length,1);
});

test('initialize is never cancelled and a pre-aborted request is never sent', async () => {
  const {client,sent} = fixture();
  await assert.rejects(client.request('initialize', {}), /timed out/);
  assert.equal(sent.length,1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.call('lookup',{},controller.signal),{name:'AbortError'});
  assert.equal(sent.length,1);
});

test('invalid or unbounded execution deadlines fail before sending a command', async () => {
  const {client,sent} = fixture();
  for (const timeout of [-1,0,Infinity,NaN,3_600_001,'600000']) {
    await assert.rejects(client.call('execute_command',{command:'build',timeout}),/must be an integer/);
  }
  assert.equal(sent.length,0);
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { McpClient } from '../src/mcp/client.js';

function fixture(timeout = 25) {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null,
    kill: () => { proc.exitCode=0; proc.emit('exit',0,null); return true; },
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

test('a negotiated execution cancellation waits for its exact cleanup receipt', async () => {
  const {client,sent,reply}=fixture(1000);
  const init=client.initialize();
  reply(sent[0].id,{capabilities:{experimental:{'my-agent/cancellation-drain':{version:1}}}});
  await init;
  const controller=new AbortController();
  let finished=false;
  const pending=client.call('execute_command',{command:'long build'},controller.signal);
  const outcome=pending.catch(error=>{finished=true;return error;});
  const request=sent.find(item=>item.method==='tools/call');
  controller.abort();
  const drain=sent.find(item=>item.method==='my-agent/wait-cancelled');
  assert.equal(drain.params.requestId,request.id);
  // An ordinary late response does not prove that cancellation has drained.
  reply(request.id,{content:[{type:'text',text:'late result'}]});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(finished,false);
  reply(drain.id,{requestId:request.id,settled:true});
  assert.equal((await outcome).name,'AbortError');
});

test('a wrong or unverified cleanup receipt retires the connection instead of declaring it ready', async () => {
  for(const receipt of [{requestId:999,settled:true},{requestId:3,settled:false}]) {
    const {client,sent,reply}=fixture(1000);
    const init=client.initialize();
    reply(sent[0].id,{capabilities:{experimental:{'my-agent/cancellation-drain':{version:1}}}});
    await init;
    const controller=new AbortController();
    const pending=client.call('execute_command',{command:'long build'},controller.signal);
    const outcome=assert.rejects(pending,/cleanup could not be verified; connection retired/);
    controller.abort();
    const drain=sent.find(item=>item.method==='my-agent/wait-cancelled');
    reply(drain.id,{...receipt,...(!receipt.settled ? {requestId:drain.params.requestId} : {})});
    await outcome;
    await assert.rejects(client.call('lookup',{}),/stdin is closed/);
  }
});

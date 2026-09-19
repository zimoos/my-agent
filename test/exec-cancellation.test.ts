import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { connectMcpServer } from '../src/mcp/client.js';

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try { process.kill(pid,0); return true; }
  catch { return false; }
}
async function until(check:()=>boolean, message:string) {
  const end = Date.now()+15000;
  while (Date.now()<end) { if(check()) return; await pause(25); }
  assert.fail(message);
}

for (const mode of ['execute_command', 'start_process', 'close'] as const) {
test(`${mode}: cancellation kills the real process scope`, async () => {
  const root = await mkdtemp(join(tmpdir(),'ma-exec-cancel-'));
  const pidFile=join(root,'pids.json');
  const lateFile=join(root,'late-write');
  const script=join(root,'slow.mjs');
  const repo=resolve(import.meta.dirname,'..');
  await writeFile(script, `
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e',${JSON.stringify("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")}],{detached:true,stdio:'ignore'});
${mode === 'close' ? "process.on('SIGTERM',()=>{});" : ''}
writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));
setTimeout(()=>writeFileSync(${JSON.stringify(lateFile)},'must not happen'),10000);
setInterval(()=>{},1000);
`);
  const client=await connectMcpServer('exec',{
    command:process.execPath,args:[join(repo,'dist/servers/exec-mcp.js')],cwd:root,
  });
  let pids:number[]=[];
  try {
    const controller=new AbortController();
    const pending=client.call(mode === 'start_process' ? mode : 'execute_command',{
      command:quote(process.execPath)+' '+quote(script),
      ...(mode === 'start_process'
        ? { readyPattern: 'NEVER_READY', readyTimeout: 60_000 }
        : { timeout: 60_000 }),
    },controller.signal);
    const stopped=mode === 'close' ? assert.rejects(pending) : assert.rejects(pending,{name:'AbortError'});
    await until(()=>existsSync(pidFile),'command did not start');
    pids=JSON.parse(await readFile(pidFile,'utf8'));
    if (mode === 'close') await client.close();
    else controller.abort();
    await stopped;
    assert.ok(pids.every(pid=>!alive(pid)), 'cancellation must not return while the old execution scope can still write');
    await until(()=>pids.every(pid=>!alive(pid)),'cancel left an executing child or detached descendant');
    assert.equal(existsSync(lateFile),false);
    if (mode !== 'close') {
      const next=await client.call('execute_command',{command:'printf resumed'});
      assert.equal(next.isError,false);
      assert.match(next.content,/resumed/);
    }
  } finally {
    await client.close();
    for(const pid of pids) if(alive(pid)) { try{process.kill(pid,'SIGKILL');}catch{} }
    await rm(root,{recursive:true,force:true});
  }
});
}

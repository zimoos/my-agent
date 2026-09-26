import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const options = JSON.parse(process.argv[2]);
assert.equal(process.version, 'v22.23.2');
assert.equal(process.env.HOME, undefined);
assert.equal(process.env.CODEX_HOME, undefined);
let networkCalls = 0;
const blocked = () => { networkCalls++; throw new Error('R2_NETWORK_FORBIDDEN'); };
for (const [owner, keys] of [[net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']], [tls, ['connect']], [http, ['request', 'get']], [https, ['request', 'get']], [dns, ['lookup', 'resolve']], [dns.promises, ['lookup', 'resolve']]]) for (const key of keys) owner[key] = blocked;
globalThis.fetch = blocked;
const guardMode = options.mode === 'read' ? 'node-permission' : 'observed-owned-paths';
const realLstat = fs.lstat.bind(fs);
assert.equal(await fs.realpath(options.scratch), options.scratch);
async function guardPath(value) {
  const pathname = resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  const suffix = relative(options.scratch, pathname);
  if (suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)) throw Object.assign(new Error('R2 filesystem path outside owned scratch'), { code: 'R2_FS_SCOPE_DENIED' });
  let current = options.scratch;
  for (const part of suffix.split('/').filter(Boolean)) {
    current = join(current, part);
    try { if ((await realLstat(current)).isSymbolicLink()) throw Object.assign(new Error('R2 fixture symlink rejected'), { code: 'R2_FS_SCOPE_DENIED' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
// Observe real failures without granting access or replacing successful filesystem work.
for (const key of ['open', 'mkdir', 'lstat', 'stat', 'unlink', 'readFile', 'writeFile', 'appendFile', 'chmod', 'truncate', 'readdir', 'realpath']) {
  const original = fs[key];
  fs[key] = async function (...args) {
    if (guardMode === 'observed-owned-paths') await guardPath(args[0]);
    try { return await original.apply(this, args); }
    catch (error) { console.error(JSON.stringify({ filesystemFailure: key, path: String(args[0]), code: error.code, permission: error.permission, resource: error.resource })); throw error; }
  };
}
syncBuiltinESMExports();
let sentinelCode;
try { await fs.readFile(options.sentinel); throw new Error('Personal sentinel became readable'); }
catch (error) { sentinelCode = error.code; assert.equal(sentinelCode, guardMode === 'node-permission' ? 'ERR_ACCESS_DENIED' : 'R2_FS_SCOPE_DENIED'); }
const diagnosticHandle = await fs.open(join(options.directory, 'diagnostic-probe'), 'w');
const diagnosticPrototype = Object.getPrototypeOf(diagnosticHandle);
await diagnosticHandle.close(); await fs.unlink(join(options.directory, 'diagnostic-probe'));
for (const key of ['stat', 'sync', 'writeFile', 'readFile', 'chmod', 'close']) {
  const original = diagnosticPrototype[key];
  diagnosticPrototype[key] = async function (...args) {
    try { return await original.apply(this, args); }
    catch (error) { console.error(JSON.stringify({ handleFailure: key, code: error.code, permission: error.permission, resource: error.resource, message: error.message })); throw error; }
  };
}
const { openExecutionJournal, readExecutionJournal } = await import('./execution-journal.js');
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
if (options.mode === 'read') {
  const result = await readExecutionJournal({ directory: options.directory, sessionId: options.sessionId });
  await send({ pid: process.pid, version: process.version, result, networkCalls, sentinelCode, guardMode });
  process.disconnect();
} else {
  const journal = await openExecutionJournal({ directory: options.directory, sessionId: options.sessionId, ownerId: options.ownerId });
  const handle = await fs.open(join(options.directory, 'execution.jsonl'), 'r');
  const inode = (await handle.stat()).ino; const prototype = Object.getPrototypeOf(handle); await handle.close();
  const sync = prototype.sync; let successReceipts = 0;
  prototype.sync = async function () {
    if ((await this.stat()).ino !== inode) return sync.call(this);
    await send({ kind: 'before-log-sync', pid: process.pid, successReceipts, networkCalls, sentinelCode, guardMode });
    await new Promise(() => {});
  };
  const keepAlive = setInterval(() => {}, 1000);
  await journal.append(options.event);
  successReceipts++;
  clearInterval(keepAlive);
  await send({ kind: 'unexpected-success', successReceipts });
  process.exitCode = 1;
  process.disconnect();
}

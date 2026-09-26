import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

export const scratch = process.env.MA_PI_SESSION_SCRATCH;
assert.ok(scratch);
assert.equal(process.version, 'v22.23.2');
assert.equal(process.versions.bun, undefined);
assert.equal(process.permission.has('fs.read', process.env.MA_PI_PERSONAL_ROOT), false);
assert.equal(process.permission.has('child'), false);
assert.equal(process.permission.has('worker'), false);
assert.throws(() => fs.readFileSync(process.env.MA_PI_DENIED_CANARY), { code: 'ERR_ACCESS_DENIED' });

const networkAttempts = [];
function deniedNetwork(...args) {
  networkAttempts.push(typeof args[0]);
  throw Object.assign(new Error('PI_SESSION_NETWORK_DENIED'), { code: 'PI_SESSION_NETWORK_DENIED' });
}
globalThis.fetch = deniedNetwork;
net.connect = net.createConnection = net.Socket.prototype.connect = deniedNetwork;
tls.connect = http.request = http.get = https.request = https.get = deniedNetwork;
dns.lookup = dns.resolve = dgram.createSocket = deniedNetwork;
assert.throws(() => net.connect({ host: '127.0.0.1', port: 1 }), { code: 'PI_SESSION_NETWORK_DENIED' });
networkAttempts.length = 0;

const fileReads = [];
function observe(filename) {
  if (filename instanceof URL) filename = fileURLToPath(filename);
  if (typeof filename === 'string') fileReads.push(path.resolve(filename));
}
for (const name of ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync', 'accessSync', 'existsSync']) {
  const original = fs[name];
  fs[name] = function (filename, ...args) { observe(filename); return original.call(this, filename, ...args); };
}
for (const object of [fs, fsp]) {
  for (const name of ['readFile', 'open', 'readdir', 'stat', 'lstat', 'access']) {
    const original = object[name];
    object[name] = function (filename, ...args) { observe(filename); return original.call(this, filename, ...args); };
  }
}
syncBuiltinESMExports();

export function isolationEvidence() {
  const roots = ['workspace/.pi', 'workspace/.agents', 'workspace/AGENTS.md', 'agent/auth.json', 'agent/models.json', 'agent/SYSTEM.md', 'agent/extensions', 'agent/skills']
    .map((relative) => path.join(scratch, relative));
  const sentinelReads = fileReads.filter((filename) => roots.some((root) => filename === root || filename.startsWith(`${root}${path.sep}`)));
  assert.deepEqual(sentinelReads, []);
  assert.equal(networkAttempts.length, 0);
  assert.equal(fs.existsSync(path.join(scratch, 'tool-side-effect')), false);
  return { networkAttempts: 0, sentinelReads: 0, personalReadDenied: true, subprocessesDenied: true, fileObservations: fileReads.length };
}

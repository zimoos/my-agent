import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openExecutionJournal, readExecutionJournal } from '../../src/runtime/execution-journal.js';
import { journalTurnVector } from './fixtures/batch1-vectors.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const sessionId = 'ma-session-a';

async function directoryFor(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ma-next-crash-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function childFor(t: TestContext, directory: string, mode: 'hold' | 'probe', ownerId: string): ChildProcess {
  assert.equal(process.version, 'v22.23.2', 'Crash tests must launch the approved real Node runtime');
  const child = spawn(process.execPath, [
    '--import', 'tsx', 'test/runtime/fixtures/journal-child.ts',
    JSON.stringify({ directory, sessionId, ownerId, mode }),
  ], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  return child;
}

function messageFrom(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const capture = (chunk: Buffer) => { stderr += chunk.toString(); };
    const onExit = (code: number | null, signal: string | null) => { cleanup(); reject(new Error(`child exited before IPC (${code}/${signal}): ${stderr}`)); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onMessage = (value: unknown) => { cleanup(); resolve(value as Record<string, unknown>); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`child IPC timeout: ${stderr}`)); }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      child.stderr?.off('data', capture);
    };
    child.stderr?.on('data', capture);
    child.once('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

test('A2 two real processes cannot write one directory; healthy close permits a new owner', async (t) => {
  const directory = await directoryFor(t);
  const owner = childFor(t, directory, 'hold', 'child-owner-a');
  const ready = await messageFrom(owner);
  assert.equal(ready.type, 'ready');
  assert.equal(ready.pid, owner.pid);
  const lockPath = path.join(directory, '.writer.lock');
  const lockBefore = await fs.readFile(lockPath);
  const contender = childFor(t, directory, 'probe', 'child-owner-b');
  const rejected = await messageFrom(contender);
  assert.equal(rejected.acquired, false);
  assert.equal(rejected.code, 'JOURNAL_LOCKED');
  assert.deepEqual(await fs.readFile(lockPath), lockBefore);
  assert.deepEqual(await readExecutionJournal({ directory, sessionId }), {
    entries: [{ ...journalTurnVector(1), seq: 1 }], incompleteTail: false,
  });
  const closed = messageFrom(owner);
  owner.send('close');
  assert.equal((await closed).type, 'closed');
  const successor = childFor(t, directory, 'probe', 'child-owner-c');
  assert.equal((await messageFrom(successor)).acquired, true);
});

test('A2 SIGKILL preserves the unknown lock; readonly diagnosis never takes over or replays', async (t) => {
  const directory = await directoryFor(t);
  const child = childFor(t, directory, 'hold', 'crash-owner-a');
  assert.equal((await messageFrom(child)).type, 'ready');
  const lockPath = path.join(directory, '.writer.lock');
  const logPath = path.join(directory, 'execution.jsonl');
  const lockBefore = await fs.readFile(lockPath);
  const logBefore = await fs.readFile(logPath);
  const exited = once(child, 'exit');
  assert.equal(child.kill('SIGKILL'), true);
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  assert.deepEqual(await readExecutionJournal({ directory, sessionId }), {
    entries: [{ ...journalTurnVector(1), seq: 1 }], incompleteTail: false,
  });
  await assert.rejects(openExecutionJournal({ directory, sessionId, ownerId: 'new-owner' }),
    (error: unknown) => (error as { code?: string }).code === 'JOURNAL_LOCKED');
  assert.deepEqual(await fs.readFile(lockPath), lockBefore);
  assert.deepEqual(await fs.readFile(logPath), logBefore);
  const orphan = JSON.parse(lockBefore.toString()) as { pid: number; sessionId: string; ownerId: string };
  assert.equal(orphan.pid, child.pid);
  assert.equal(orphan.sessionId, sessionId);
  assert.equal(orphan.ownerId, 'crash-owner-a');
});

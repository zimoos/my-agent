import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSessionStore } from '../src/session/store.js';

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('session store: create returns id with s_ prefix and writes empty jsonl + meta', () => {
  const dir = mktmp('sess-');
  const store = createSessionStore(dir);
  const id = store.create({ createdAt: Date.now(), cwd: '/cwd', model: 'stub' });
  assert.match(id, /^s_\d+_[a-z0-9]{4}$/);
  assert.equal(fs.readFileSync(path.join(dir, `${id}.jsonl`), 'utf-8'), '');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.meta.json`), 'utf-8'));
  assert.equal(meta.id, id);
  assert.equal(meta.cwd, '/cwd');
  assert.equal(meta.model, 'stub');
  assert.equal(meta.messageCount, 0);
});

test('session store: append writes one JSON line per call and updates messageCount', () => {
  const dir = mktmp('sess-');
  const store = createSessionStore(dir);
  const id = store.create({ createdAt: Date.now(), cwd: '/', model: 'm' });
  store.append(id, { role: 'user', content: 'hello' });
  store.append(id, { role: 'assistant', content: 'hi' });
  const raw = fs.readFileSync(path.join(dir, `${id}.jsonl`), 'utf-8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { role: 'user', content: 'hello' });
  assert.deepEqual(JSON.parse(lines[1]), { role: 'assistant', content: 'hi' });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.meta.json`), 'utf-8'));
  assert.equal(meta.messageCount, 2);
});

test('session store: provider chat truth preserves MA-local Memory batch checkpoint state', () => {
  const dir = mktmp('sess-');
  const store = createSessionStore(dir);
  try {
    const id = store.create({ createdAt: Date.now(), cwd: '/tmp/project', model: 'agora' });
    store.updateProviderState(id, {
      provider_id: 'agora',
      memory: {
        status: 'pending',
        active_batch: { batch_id: 'batch-a' },
        last_auto_intake_message_end: 12,
        last_auto_intake_runtime_message_end: 13,
      },
    });
    store.updateProviderState(id, {
      provider_id: 'agora',
      agora_session_id: 'chat-a',
      memory: { status: 'mounted', active_memory_patch_ids: ['patch-a'] },
    });
    const state = store.list().find((meta) => meta.id === id)?.providerState;
    assert.equal(state?.memory?.status, 'mounted');
    assert.deepEqual(state?.memory?.active_batch, { batch_id: 'batch-a' });
    assert.equal(state?.memory?.last_auto_intake_message_end, 12);
    assert.equal(state?.memory?.last_auto_intake_runtime_message_end, 13);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session store: load round-trips all appended messages', () => {
  const dir = mktmp('sess-');
  const store = createSessionStore(dir);
  const id = store.create({ createdAt: Date.now(), cwd: '/', model: 'm' });
  const msgs = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'n', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ];
  for (const m of msgs) store.append(id, m);
  const loaded = store.load(id);
  assert.deepEqual(loaded, msgs);
});

test('session store: load skips corrupt JSONL lines', () => {
  const dir = mktmp('sess-');
  const store = createSessionStore(dir);
  const id = store.create({ createdAt: Date.now(), cwd: '/', model: 'm' });
  fs.appendFileSync(
    path.join(dir, `${id}.jsonl`),
    '{"role":"user","content":"ok"}\n{ this is not json\n{"role":"assistant","content":"fine"}\n'
  );
  const loaded = store.load(id);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].role, 'user');
  assert.equal(loaded[1].role, 'assistant');
});

test('session store: list returns newest first, optional limit', async () => {
  const dir = mktmp('sess-');
  const store = createSessionStore(dir);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(store.create({ createdAt: Date.now() + i * 1000, cwd: '/', model: 'm' }));
  }
  const all = store.list();
  assert.equal(all.length, 3);
  assert.equal(all[0].id, ids[2]);
  assert.equal(all[2].id, ids[0]);
  const top = store.list(2);
  assert.equal(top.length, 2);
  assert.equal(top[0].id, ids[2]);
});

test('session store: latest returns newest session id or null when empty', () => {
  const dir = mktmp('sess-');
  const store = createSessionStore(dir);
  assert.equal(store.latest(), null);
  const a = store.create({ createdAt: 1000, cwd: '/', model: 'm' });
  const b = store.create({ createdAt: 2000, cwd: '/', model: 'm' });
  assert.equal(store.latest(), b);
  assert.ok(a !== b);
});

test('session store: prune keeps the N most recent and deletes the rest', () => {
  const dir = mktmp('sess-');
  const store = createSessionStore(dir);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(store.create({ createdAt: 1000 + i, cwd: '/', model: 'm' }));
  }
  const removed = store.prune(2);
  assert.equal(removed, 3);
  const remaining = store.list();
  assert.equal(remaining.length, 2);
  assert.equal(remaining[0].id, ids[4]);
  assert.equal(remaining[1].id, ids[3]);
  for (const gone of ids.slice(0, 3)) {
    assert.equal(fs.existsSync(path.join(dir, `${gone}.jsonl`)), false);
    assert.equal(fs.existsSync(path.join(dir, `${gone}.meta.json`)), false);
  }
});

test('session store: load returns empty array for unknown session id', () => {
  const dir = mktmp('sess-');
  const store = createSessionStore(dir);
  assert.deepEqual(store.load('s_nope_0000'), []);
});

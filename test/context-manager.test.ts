import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createContextManager } from '../src/agent/context-manager.js';

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('context manager: persists pins, pool entries, search, and recall', () => {
  const dir = mktmp('ma-context-');
  const ctx = createContextManager('s_test_0000', dir);

  assert.match(ctx.pin('Use TypeScript strict mode'), /Pinned/);
  const entry = ctx.archive({
    role: 'summary',
    text: 'The user decided that recall results must be filtered before entering active context.',
    summary: 'Recall results need filtering before active context admission.',
    archivedReason: 'completed',
  });
  assert.ok(entry);

  const results = ctx.search('recall filtering');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, entry.id);

  assert.match(ctx.recall(entry.id), /Recalled/);
  const prompt = ctx.formatForPrompt();
  assert.match(prompt, /Use TypeScript strict mode/);
  assert.match(prompt, /Recall results need filtering/);
});

test('context manager: applies hidden next-context patch safely', () => {
  const dir = mktmp('ma-context-');
  const ctx = createContextManager('s_test_0001', dir);

  ctx.applyPatch(JSON.stringify({
    activeTask: {
      id: 'task-1',
      title: 'Implement context hygiene',
      state: 'coding',
    },
    pin: ['Do not show hidden patches to users'],
    hygiene: [
      {
        target: 'Old assumption: recall is a second LLM pass',
        action: 'supersede',
        reason: 'User clarified patch is same-turn output',
      },
      {
        target: 'Tool-call pairing rules',
        action: 'protect',
        reason: 'Safety invariant',
      },
    ],
    archiveToPool: [
      {
        reason: 'completed',
        summary: 'Issue #19 scope was corrected to exclude Mnemo for MVP.',
      },
    ],
  }));

  const inspect = ctx.inspect();
  assert.match(inspect, /Implement context hygiene/);
  assert.match(inspect, /Do not show hidden patches/);
  assert.match(inspect, /supersede/);
  assert.match(inspect, /protected/);
  assert.match(inspect, /Session pool entries: 1/);
});


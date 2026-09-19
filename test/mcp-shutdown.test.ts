import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shutdown } from '../src/index.js';
import type { McpConnection } from '../src/mcp/types.js';

test('shutdown drains independent MCP scopes together even when one close fails', async () => {
  const started: number[] = [];
  let release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  const connections = [0, 1].map(id => ({
    async close() {
      started.push(id);
      if (started.length === 2) release();
      await bothStarted;
      if (id === 0) throw new Error('one retired transport');
    },
  })) as McpConnection[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      shutdown(connections),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP cleanup serialized')), 1000); }),
    ]);
    assert.deepEqual(started, [0, 1]);
  } finally { clearTimeout(timer); release(); }
});

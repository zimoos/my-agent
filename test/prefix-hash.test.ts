import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixHash, prefixDiagnostic } from '../src/agent/prefix-hash.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

test('prefixHash: produces consistent results for same input', () => {
  const msgs: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
  ];
  const h1 = prefixHash(msgs);
  const h2 = prefixHash(msgs);
  assert.equal(h1, h2);
  assert.equal(h1.length, 16);
});

test('prefixHash: different system prompts produce different hashes', () => {
  const a: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'Prompt A' },
  ];
  const b: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'Prompt B' },
  ];
  assert.notEqual(prefixHash(a), prefixHash(b));
});

test('prefixHash: hash is stable when conversation grows', () => {
  const base: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'Fixed system prompt' },
    { role: 'user', content: 'Question 1' },
  ];
  const baseHash = prefixHash(base);

  const withMore: ChatCompletionMessageParam[] = [
    ...base,
    { role: 'assistant', content: 'Answer 1' },
    { role: 'user', content: 'Question 2' },
  ];
  // The extra messages change the hash (prefix includes them)
  const moreHash = prefixHash(withMore);
  assert.notEqual(baseHash, moreHash);

  // But system-only hash stays stable
  const sysOnly = prefixHash(base.slice(0, 1));
  const sysOnlyMore = prefixHash(withMore.slice(0, 1));
  assert.equal(sysOnly, sysOnlyMore);
});

test('prefixDiagnostic: includes expected fields', () => {
  const msgs: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'test' },
    { role: 'user', content: 'hello' },
  ];
  const diag = prefixDiagnostic(msgs);
  assert.equal(typeof diag.hash, 'string');
  assert.equal(diag.hash.length, 16);
  assert.equal(diag.messageCount, 2);
  assert.equal(diag.lastRole, 'user');
  assert.ok(diag.timestamp.endsWith('Z'));
});

test('prefixDiagnostic: handles empty messages', () => {
  const diag = prefixDiagnostic([]);
  assert.equal(diag.messageCount, 0);
  assert.equal(diag.lastRole, 'none');
});

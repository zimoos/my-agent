import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamParser } from '../src/agent/stream-parser.js';
import type { AgentEvent } from '../src/agent/events.js';

async function* chunks(parts: string[]) {
  for (const part of parts) {
    yield { choices: [{ delta: { content: part } }] };
  }
}

test('stream parser: streams visible text and hides tail context patch', async () => {
  const parser = new StreamParser();
  const events: AgentEvent[] = [];
  const gen = parser.parse(chunks([
    'Visible answer',
    ' continues.',
    '\n<ma_context_patch>\n{"pin":["keep this"]}',
    '\n</ma_context_patch>',
  ]));

  let result;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value);
  }

  assert.equal(
    events
      .filter((event): event is Extract<AgentEvent, { type: 'token' }> => event.type === 'token')
      .map((event) => event.text)
      .join(''),
    'Visible answer continues.\n'
  );
  assert.equal(result.content, 'Visible answer continues.\n');
  assert.equal(result.contextPatch, '{"pin":["keep this"]}');
});

test('stream parser: detects split context patch delimiter without leaking it', async () => {
  const parser = new StreamParser();
  const events: AgentEvent[] = [];
  const gen = parser.parse(chunks([
    'Answer',
    '\n<ma_context',
    '_patch>{"hygiene":[]}</ma_context_patch>',
  ]));

  let result;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value);
  }

  const visible = events
    .filter((event): event is Extract<AgentEvent, { type: 'token' }> => event.type === 'token')
    .map((event) => event.text)
    .join('');
  assert.equal(visible, 'Answer\n');
  assert.equal(result.content, 'Answer\n');
  assert.equal(result.contextPatch, '{"hygiene":[]}');
});


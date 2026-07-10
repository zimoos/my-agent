import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __internal__ } from '../src/agent.js';
import { routeToolCall } from '../src/agent/tool-router.js';
import type { McpConnection } from '../src/mcp/types.js';

const {
  mcpToolsToOpenAI,
  normalizeArguments,
  ensureToolCallId,
  normalizeToolCalls,
} = __internal__;

function fakeConn(name: string, toolNames: string[]): McpConnection {
  return {
    name,
    process: {} as any,
    tools: toolNames.map((n) => ({
      name: n,
      description: `desc of ${n}`,
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    })),
    call: async () => ({ content: 'stub', isError: false }),
    close: async () => {},
  };
}

test('mcpToolsToOpenAI: prefixes tool names with server name', () => {
  const conns = [fakeConn('exec', ['run', 'which']), fakeConn('fs', ['read'])];
  const out = mcpToolsToOpenAI(conns);
  const names = out.map((t) => t.function.name);
  assert.deepEqual(names, ['exec__run', 'exec__which', 'fs__read']);
  assert.equal(out[0].type, 'function');
  assert.equal(out[0].function.description, 'desc of run');
});

test('mcpToolsToOpenAI: encodes MCP tool names for OpenAI function-name schema', () => {
  const conns = [fakeConn('mteam-primary', ['zimoos.current', 'zimoos.act'])];
  const out = mcpToolsToOpenAI(conns);
  const names = out.map((t) => t.function.name);
  assert.deepEqual(names, [
    'mteam-primary__zimoos_x2e_current',
    'mteam-primary__zimoos_x2e_act',
  ]);
  for (const name of names) {
    assert.match(name, /^[A-Za-z0-9_-]+$/);
  }
});

test('mcpToolsToOpenAI: uses tool name as fallback description', () => {
  const conn: McpConnection = {
    name: 's',
    process: {} as any,
    tools: [{ name: 'foo', description: '', inputSchema: {} }],
    call: async () => ({ content: '', isError: false }),
    close: async () => {},
  };
  const out = mcpToolsToOpenAI([conn]);
  assert.equal(out[0].function.description, 'foo');
});

test('routeToolCall: splits server and tool', () => {
  const conns = [fakeConn('exec', ['run'])];
  const r = routeToolCall(conns, 'exec__run');
  assert.ok(r);
  assert.equal(r!.conn.name, 'exec');
  assert.equal(r!.toolName, 'run');
});

test('routeToolCall: returns null for unknown server', () => {
  const conns = [fakeConn('exec', ['run'])];
  assert.equal(routeToolCall(conns, 'nope__run'), null);
});

test('routeToolCall: returns null for unknown tool', () => {
  const conns = [fakeConn('exec', ['run'])];
  assert.equal(routeToolCall(conns, 'exec__missing'), null);
});

test('routeToolCall: returns null when no separator', () => {
  const conns = [fakeConn('exec', ['run'])];
  assert.equal(routeToolCall(conns, 'noseparator'), null);
});

test('routeToolCall: handles tool name containing separator', () => {
  const conns = [fakeConn('srv', ['a__b'])];
  const r = routeToolCall(conns, 'srv__a__b');
  assert.ok(r);
  assert.equal(r!.toolName, 'a__b');
});

test('routeToolCall: decodes encoded OpenAI-safe MCP function names', () => {
  const conns = [fakeConn('mteam-primary', ['zimoos.current'])];
  const r = routeToolCall(conns, 'mteam-primary__zimoos_x2e_current');
  assert.ok(r);
  assert.equal(r!.conn.name, 'mteam-primary');
  assert.equal(r!.toolName, 'zimoos.current');
});

test('normalizeArguments: parses JSON string', () => {
  assert.deepEqual(normalizeArguments('{"a":1}'), { a: 1 });
});

test('normalizeArguments: passes through object', () => {
  assert.deepEqual(normalizeArguments({ x: 'y' }), { x: 'y' });
});

test('normalizeArguments: handles null/undefined/empty', () => {
  assert.deepEqual(normalizeArguments(null), {});
  assert.deepEqual(normalizeArguments(undefined), {});
  assert.deepEqual(normalizeArguments(''), {});
  assert.deepEqual(normalizeArguments('   '), {});
});

test('normalizeArguments: extracts JSON from dirty string', () => {
  const raw = 'Sure, here: {"cmd":"ls","dir":"/tmp"} — should work';
  assert.deepEqual(normalizeArguments(raw), { cmd: 'ls', dir: '/tmp' });
});

test('normalizeArguments: returns empty object when unparseable', () => {
  assert.deepEqual(normalizeArguments('garbage no json here'), {});
});

test('normalizeArguments: rejects non-object JSON (array / primitive)', () => {
  assert.deepEqual(normalizeArguments('[1,2,3]'), {});
  assert.deepEqual(normalizeArguments('42'), {});
});

test('ensureToolCallId: keeps non-empty id', () => {
  assert.equal(ensureToolCallId('call_abc'), 'call_abc');
});

test('ensureToolCallId: generates id for empty/null', () => {
  const a = ensureToolCallId('');
  const b = ensureToolCallId(null);
  const c = ensureToolCallId(undefined);
  for (const x of [a, b, c]) {
    assert.match(x, /^call_/);
  }
  assert.notEqual(a, b);
  assert.notEqual(b, c);
});

test('ensureToolCallId: generates id for whitespace-only', () => {
  const x = ensureToolCallId('   ');
  assert.match(x, /^call_/);
});

test('normalizeToolCalls: returns null for empty/non-array', () => {
  assert.equal(normalizeToolCalls(null), null);
  assert.equal(normalizeToolCalls([]), null);
  assert.equal(normalizeToolCalls('not-an-array'), null);
});

test('normalizeToolCalls: fills missing id and stringifies object args', () => {
  const out = normalizeToolCalls([
    { function: { name: 'exec__run', arguments: { cmd: 'ls' } } },
  ]);
  assert.ok(out);
  assert.equal(out!.length, 1);
  assert.match(out![0].id, /^call_/);
  assert.equal(out![0].function.name, 'exec__run');
  assert.equal(out![0].function.arguments, '{"cmd":"ls"}');
});

test('normalizeToolCalls: preserves string arguments as-is', () => {
  const out = normalizeToolCalls([
    { id: 'x', function: { name: 'fs__read', arguments: '{"path":"/a"}' } },
  ]);
  assert.ok(out);
  assert.equal(out![0].id, 'x');
  assert.equal(out![0].function.arguments, '{"path":"/a"}');
});

test('normalizeToolCalls: drops entries without a function name', () => {
  const out = normalizeToolCalls([
    { function: { name: '' } },
    { function: { name: 'ok', arguments: {} } },
    { nofunction: true },
  ]);
  assert.ok(out);
  assert.equal(out!.length, 1);
  assert.equal(out![0].function.name, 'ok');
});

test('normalizeToolCalls: returns null if all entries are invalid', () => {
  const out = normalizeToolCalls([{ function: { name: '' } }, null]);
  assert.equal(out, null);
});

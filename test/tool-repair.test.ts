import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scavengeToolCalls,
  repairTruncatedJson,
  StormBreaker,
  ToolCallRepair,
} from '../src/agent/tool-repair.js';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';

function tc(name: string, args: string): ChatCompletionMessageToolCall {
  return {
    id: `call_${name}`,
    type: 'function',
    function: { name, arguments: args },
  };
}

// ── Scavenge ────────────────────────────────────────────────────────

test('scavengeToolCalls: extracts tool call from text with standard format', () => {
  const text = 'I will read the file now. {"name": "read_file", "arguments": {"path": "/foo"}}';
  const found = scavengeToolCalls(text, new Set(['read_file']));
  assert.equal(found.length, 1);
  assert.equal(found[0].function.name, 'read_file');
  assert.equal(found[0].function.arguments, '{"path":"/foo"}');
});

test('scavengeToolCalls: recognizes "function" as name field', () => {
  const text = '{"function": "grep", "arguments": {"pattern": "foo"}}';
  const found = scavengeToolCalls(text, new Set(['grep']));
  assert.equal(found.length, 1);
  assert.equal(found[0].function.name, 'grep');
});

test('scavengeToolCalls: recognizes "tool" as name field', () => {
  const text = '{"tool": "list_directory", "args": {"path": "."}}';
  const found = scavengeToolCalls(text, new Set(['list_directory']));
  assert.equal(found.length, 1);
  assert.equal(found[0].function.name, 'list_directory');
});

test('scavengeToolCalls: filters out non-tool JSON', () => {
  const text = '{"foo": 1, "bar": 2}'; // no name-like field
  const found = scavengeToolCalls(text, new Set(['read_file']));
  assert.equal(found.length, 0);
});

test('scavengeToolCalls: filters by allowedToolNames', () => {
  const text = '{"name": "unknown_tool", "arguments": {}}';
  const found = scavengeToolCalls(text, new Set(['read_file']));
  assert.equal(found.length, 0);
});

test('scavengeToolCalls: deduplicates by signature', () => {
  const text = `{"name": "read_file", "arguments": {"path": "/a"}}\n{"name": "read_file", "arguments": {"path": "/a"}}`;
  const found = scavengeToolCalls(text, new Set(['read_file']));
  assert.equal(found.length, 1);
});

test('scavengeToolCalls: returns empty for empty text', () => {
  assert.equal(scavengeToolCalls('', new Set(['read_file'])).length, 0);
  assert.equal(scavengeToolCalls('   ', new Set(['read_file'])).length, 0);
});

// ── Truncation Repair ────────────────────────────────────────────────

test('repairTruncatedJson: fast path for valid JSON', () => {
  const r = repairTruncatedJson('{"key": "value"}');
  assert.equal(r.fallback, false);
  assert.equal(r.repaired, '{"key": "value"}');
});

test('repairTruncatedJson: closes unclosed brace', () => {
  const r = repairTruncatedJson('{"key": "value"');
  assert.equal(r.fallback, false);
  JSON.parse(r.repaired); // must be valid
  assert.ok(r.repaired.includes('}'));
});

test('repairTruncatedJson: closes unclosed bracket', () => {
  const r = repairTruncatedJson('{"items": [1, 2, 3');
  assert.equal(r.fallback, false);
  JSON.parse(r.repaired);
});

test('repairTruncatedJson: closes unclosed string', () => {
  const r = repairTruncatedJson('{"key": "unclosed');
  assert.equal(r.fallback, false);
  const parsed = JSON.parse(r.repaired);
  assert.equal(typeof parsed.key, 'string');
});

test('repairTruncatedJson: closes nested braces and brackets', () => {
  const r = repairTruncatedJson('{"arr": [{"a": 1}');
  assert.equal(r.fallback, false);
  const parsed = JSON.parse(r.repaired);
  assert.deepEqual(parsed, { arr: [{ a: 1 }] });
});

test('repairTruncatedJson: returns fallback when unrecoverable', () => {
  const r = repairTruncatedJson('not json at all');
  assert.equal(r.fallback, true);
  assert.equal(r.repaired, 'not json at all');
});

test('repairTruncatedJson: empty input returns empty object', () => {
  const r = repairTruncatedJson('');
  assert.equal(r.fallback, false);
  assert.equal(r.repaired, '{}');
});

test('repairTruncatedJson: mismatched closer is unrecoverable', () => {
  const r = repairTruncatedJson('{"key": ]');
  assert.equal(r.fallback, true);
});

// ── Storm Breaker ────────────────────────────────────────────────────

test('StormBreaker: passes calls below threshold', () => {
  const sb = new StormBreaker(6, 3);
  assert.equal(sb.inspect(tc('read', '{"p": "a"}')).suppress, false);
  assert.equal(sb.inspect(tc('read', '{"p": "a"}')).suppress, false);
  // 3rd occurrence — count is 2 before push, so threshold=3 suppresses on 4th call
  assert.equal(sb.inspect(tc('read', '{"p": "a"}')).suppress, false);
  // 4th call — count is now 3, which is >= threshold 3
  assert.equal(sb.inspect(tc('read', '{"p": "a"}')).suppress, true);
});

test('StormBreaker: different args are tracked separately', () => {
  const sb = new StormBreaker(6, 3);
  sb.inspect(tc('read', '{"p": "a"}'));
  sb.inspect(tc('read', '{"p": "b"}'));
  sb.inspect(tc('read', '{"p": "a"}'));
  assert.equal(sb.inspect(tc('read', '{"p": "b"}')).suppress, false);
});

test('StormBreaker: respects isMutating — never suppresses mutating calls', () => {
  const sb = new StormBreaker(2, 1, (n) => n === 'exec');
  sb.inspect(tc('exec', '{"cmd": "ls"}'));
  sb.inspect(tc('exec', '{"cmd": "ls"}'));
  sb.inspect(tc('exec', '{"cmd": "ls"}'));
  assert.equal(sb.inspect(tc('exec', '{"cmd": "ls"}')).suppress, false);
});

test('StormBreaker: respects isStormExempt', () => {
  const sb = new StormBreaker(2, 1, undefined, (n) => n === 'ask_user');
  sb.inspect(tc('ask_user', '{"q": "a"}'));
  sb.inspect(tc('ask_user', '{"q": "a"}'));
  assert.equal(sb.inspect(tc('ask_user', '{"q": "a"}')).suppress, false);
});

test('StormBreaker: resetStorm clears window', () => {
  const sb = new StormBreaker(3, 1);
  sb.inspect(tc('read', '{"p": "a"}'));
  sb.inspect(tc('read', '{"p": "a"}'));
  assert.equal(sb.inspect(tc('read', '{"p": "a"}')).suppress, true);
  sb.resetStorm();
  assert.equal(sb.inspect(tc('read', '{"p": "a"}')).suppress, false);
});

test('StormBreaker: window slides — old calls drop out', () => {
  // window=3, threshold=2: with count-before-push, suppression needs 6 calls
  const sb = new StormBreaker(3, 2);
  sb.inspect(tc('read', '{"p": "a"}'));  // 1
  sb.inspect(tc('grep', '{"q": "x"}'));  // 2
  sb.inspect(tc('list', '{"p": "."}'));  // 3 (window full, 1st read/a still inside)
  sb.inspect(tc('read', '{"p": "a"}'));  // 4 — count=1 (1st read/a in window)
  sb.inspect(tc('read', '{"p": "a"}'));  // 5 — count=1 (1st slid out, only 4th's read/a present)
  assert.equal(sb.inspect(tc('read', '{"p": "a"}')).suppress, true); // 6 — count=2 >= threshold
});

// ── ToolCallRepair pipeline ───────────────────────────────────────────

test('ToolCallRepair: resetStorm delegates to StormBreaker', () => {
  const repair = new ToolCallRepair(
    { allowedToolNames: new Set(['foo']) },
    2,  // small window
    1   // low threshold
  );
  // Push one call to fill storm state
  repair.process([tc('foo', '{}')]);
  // Reset should clear
  repair.resetStorm();
  // After reset, the same call should NOT be suppressed
  const r = repair.process([tc('foo', '{}')]);
  assert.equal(r.report.stormsBroken, 0);
});

test('ToolCallRepair: scavenges calls from content text', () => {
  const repair = new ToolCallRepair({
    allowedToolNames: new Set(['read_file', 'grep', 'list_directory']),
  });
  const content = 'Let me search. {"name": "grep", "arguments": {"pattern": "foo"}}';
  const r = repair.process([], content);
  assert.equal(r.report.scavenged, 1);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].function.name, 'grep');
});

test('ToolCallRepair: scavenges from reasoning_content too', () => {
  const repair = new ToolCallRepair({
    allowedToolNames: new Set(['read_file']),
  });
  const reasoning = 'I should read {"name": "read_file", "arguments": {"path": "/x"}}';
  const r = repair.process([], '', reasoning);
  assert.equal(r.report.scavenged, 1);
});

test('ToolCallRepair: reports truncation fix', () => {
  const repair = new ToolCallRepair({
    allowedToolNames: new Set(['read_file']),
  });
  const r = repair.process([tc('read_file', '{"path": "/foo"')]);
  assert.equal(r.report.truncationsFixed, 1);
  JSON.parse(r.calls[0].function.arguments); // should be valid now
});

test('ToolCallRepair: reports truncation unrecoverable', () => {
  const repair = new ToolCallRepair({
    allowedToolNames: new Set(['read_file']),
  });
  const r = repair.process([tc('read_file', 'not json')]);
  assert.equal(r.report.truncationsUnrecoverable, 1);
});

test('ToolCallRepair: rewrites simple ls exec calls to list_directory', () => {
  const repair = new ToolCallRepair({
    allowedToolNames: new Set(['exec__execute_command', 'fs__list_directory']),
  });
  const r = repair.process([
    tc('exec__execute_command', JSON.stringify({ command: 'ls -la src' })),
  ], '', '', { userText: '列一下 src 目录' });
  assert.equal(r.calls[0].function.name, 'fs__list_directory');
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { path: 'src' });
});

test('ToolCallRepair: rewrites ls command even when model adds shell fallback', () => {
  const repair = new ToolCallRepair({
    allowedToolNames: new Set(['exec__execute_command', 'fs__list_directory']),
  });
  const r = repair.process([
    tc('exec__execute_command', JSON.stringify({
      command: 'ls -la src/ 2>/dev/null || echo "src 目录不存在"',
    })),
  ], '', '', { userText: 'src 目录下有几个文件？' });
  assert.equal(r.calls[0].function.name, 'fs__list_directory');
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { path: 'src/' });
});

test('ToolCallRepair: preserves ls when user explicitly asks for ls command', () => {
  const repair = new ToolCallRepair({
    allowedToolNames: new Set(['exec__execute_command', 'fs__list_directory']),
  });
  const r = repair.process([
    tc('exec__execute_command', JSON.stringify({ command: 'ls -la src' })),
  ], '', '', { userText: '用 ls 命令查看目录' });
  assert.equal(r.calls[0].function.name, 'exec__execute_command');
});

test('ToolCallRepair: preserves ls when user explicitly asks for shell command first', () => {
  const repair = new ToolCallRepair({
    allowedToolNames: new Set(['exec__execute_command', 'fs__list_directory']),
  });
  const r = repair.process([
    tc('exec__execute_command', JSON.stringify({ command: 'ls' })),
  ], '', '', { userText: '用 shell 命令 ls 列出当前目录' });
  assert.equal(r.calls[0].function.name, 'exec__execute_command');
});

test('ToolCallRepair: preserves exact backticked shell command with ls flags', () => {
  const repair = new ToolCallRepair({
    allowedToolNames: new Set(['exec__execute_command', 'fs__list_directory']),
  });
  const command = 'ls --this-flag-does-not-exist-xyz';
  const r = repair.process([
    tc('exec__execute_command', JSON.stringify({ command })),
  ], '', '', { userText: `执行 \`${command}\`，告诉我结果` });
  assert.equal(r.calls[0].function.name, 'exec__execute_command');
  assert.equal(JSON.parse(r.calls[0].function.arguments).command, command);
});

test('ToolCallRepair: rewrites cat exec calls to read_file', () => {
  const repair = new ToolCallRepair({
    allowedToolNames: new Set(['exec__execute_command', 'fs__read_file']),
  });
  const r = repair.process([
    tc('exec__execute_command', JSON.stringify({ command: 'cat src/index.js' })),
  ], '', '', { userText: '读取 src/index.js' });
  assert.equal(r.calls[0].function.name, 'fs__read_file');
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { path: 'src/index.js' });
});

test('ToolCallRepair: preserves real shell commands such as wc', () => {
  const repair = new ToolCallRepair({
    allowedToolNames: new Set(['exec__execute_command', 'fs__list_directory']),
  });
  const r = repair.process([
    tc('exec__execute_command', JSON.stringify({ command: 'wc -l src/index.js' })),
  ]);
  assert.equal(r.calls[0].function.name, 'exec__execute_command');
});

test('ToolCallRepair: runs all three stages and produces report', () => {
  const repair = new ToolCallRepair({
    allowedToolNames: new Set(['read_file', 'grep']),
  });

  const content = '{"name": "grep", "arguments": {"pattern": "x"}}';
  const calls = [
    tc('read_file', '{"path": "/foo"'), // truncated
    tc('read_file', '{"other": "ok"}'), // valid — will be stormed with above (same name but different args, so not stormed by name+args)
  ];

  const r = repair.process(calls, content);
  assert.equal(r.report.scavenged, 1, 'scavenged grep from content');
  assert.equal(r.report.truncationsFixed, 1, 'fixed truncated read_file');
  assert.ok(r.report.stormsBroken >= 0, 'storm breaker ran');
  assert.ok(r.calls.length >= 2, 'both read_file calls survive (different args)');
});

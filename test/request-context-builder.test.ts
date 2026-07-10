import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { MessageStore } from '../src/agent/message-store.js';
import { RequestContextBuilder } from '../src/agent/request-context-builder.js';
import { compactToolResult } from '../src/agent/compact.js';
import {
  DEEPSEEK_REQUEST_BODY_BYTE_LIMIT,
  resolveModelCapabilities,
} from '../src/provider/capabilities.js';
import type {
  ZimoosFrameSlotValue,
  ZimoosOSFrame,
} from '../src/agent/runtime-context-slots.js';

const ZIMOOS_STATE_RE =
  /<zimoos\b|\[ZimoOS Current Frame\]|["']?protocol["']?\s*:\s*["']zimoos\/os-frame["']|zimoos\/os-frame/;

function frame(overrides: Partial<ZimoosOSFrame> = {}): ZimoosOSFrame {
  return {
    protocol: 'zimoos/os-frame',
    version: '0.1',
    frameId: 'frame-a',
    frameCursor: 'cursor-a',
    osInstanceId: 'os-1',
    agentId: 'agent-1',
    status: 'idle',
    title: 'Frame A Title',
    summary: 'Current virtual desktop state',
    breadcrumb: [{ label: 'Home' }],
    visibleContent: [
      {
        itemId: 'home',
        kind: 'panel',
        title: 'Frame A Visible',
        content: 'Frame A visible content',
        priority: 1,
      },
    ],
    shortcuts: [
      {
        id: 's1',
        cmd: 'open app:notes',
        label: 'Open Notes',
        effectPreview: 'Open notes app',
        riskLevel: 'safe',
        requiresConfirmation: false,
      },
    ],
    handles: [
      {
        id: 'h1',
        label: 'Details',
        effectPreview: 'Expand details',
        tokenEstimate: 200,
      },
    ],
    recoveryActions: [],
    notifications: [],
    tokenBudget: { max: 4000, used: 200, truncated: false },
    updatedAt: '2026-07-04T10:00:00.000Z',
    ...overrides,
  };
}

function slot(value: ZimoosOSFrame): ZimoosFrameSlotValue {
  return {
    frame: value,
    sourceTool: 'mteam-primary__zimoos_x2e_current',
    toolCallId: 'call_current',
    receivedAt: '2026-07-04T10:00:01.000Z',
  };
}

function renderRequestOnlyZimoos(value: ZimoosFrameSlotValue): string {
  return [
    '<zimoos source="zimoos.currentFrame" request_only="true">',
    `sourceTool: ${value.sourceTool}`,
    `toolCallId: ${value.toolCallId}`,
    `frameCursor: ${value.frame.frameCursor}`,
    `title: ${value.frame.title ?? '(untitled)'}`,
    'Visible content:',
    ...(value.frame.visibleContent ?? []).map((item) =>
      `- ${item.kind ?? 'item'}:${item.itemId ?? ''} | ${item.title ?? ''}: ${item.content ?? ''}`
    ),
    'Shortcuts:',
    ...(value.frame.shortcuts ?? []).map((shortcut) =>
      `- ${shortcut.cmd}${shortcut.label ? ` | ${shortcut.label}` : ''}`
    ),
    '</zimoos>',
  ].join('\n');
}

function requestOnlyOptions(value: ZimoosFrameSlotValue): any {
  const attachment = renderRequestOnlyZimoos(value);
  return {
    maxTokens: 100000,
    latestMessageAttachments: [attachment],
  };
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return JSON.stringify(content);
  return '';
}

function messagesText(messages: any[]): string {
  return messages.map(messageText).join('\n');
}

function assertNoZimoosState(messages: any[], label: string): void {
  for (let i = 0; i < messages.length; i++) {
    assert.doesNotMatch(
      messageText(messages[i]),
      ZIMOOS_STATE_RE,
      `${label} message[${i}] must not contain current ZimoOS state`
    );
  }
}

function assertNoSystemZimoosState(messages: any[]): void {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== 'system') continue;
    assert.doesNotMatch(
      messageText(messages[i]),
      /<zimoos\b|\[ZimoOS Current Frame\]/,
      `role=system request message[${i}] must not contain ZimoOS current state`
    );
  }
}

function assertOnlyLatestMessageHasZimoos(messages: any[]): string {
  const carrierIndexes = messages
    .map((message, index) => ({ index, text: messageText(message) }))
    .filter(({ text }) => /<zimoos\b/.test(text))
    .map(({ index }) => index);

  assert.deepEqual(
    carrierIndexes,
    [messages.length - 1],
    'only the latest request message may contain <zimoos>'
  );
  assert.equal(
    messages[messages.length - 1]?.role,
    'user',
    'request-only ZimoOS carrier must be the latest user request message'
  );
  assertNoZimoosState(messages.slice(0, -1), 'historical request prefix');
  assertNoSystemZimoosState(messages);
  assert.doesNotMatch(
    messagesText(messages),
    /["']?protocol["']?\s*:\s*["']zimoos\/os-frame["']|zimoos\/os-frame/,
    'provider request must not contain raw OSFrame protocol JSON'
  );
  return messageText(messages[messages.length - 1]);
}

function makeStore(): MessageStore {
  const store = new MessageStore();
  store.init('stable system prompt');
  store.appendUser('inspect zimoos');
  store.appendAssistant('', [
    {
      id: 'call_current',
      type: 'function',
      function: {
        name: 'mteam-primary__zimoos_x2e_current',
        arguments: '{}',
      },
    },
  ]);
  store.appendToolResult(
    'call_current',
    [
      'Action: zimoos.current {}',
      'Summary: inspected the current virtual desktop.',
      'Frame audit: updated current frame slot.',
    ].join('\n')
  );
  store.appendAssistant('Summary: current surface inspected.');
  return store;
}

test('request context: ZimoOS frame is latest request-only carrier, never system or history', () => {
  const store = makeStore();
  const snapshot = store.snapshot();
  const pending = store.getPendingForPersist();

  assertNoZimoosState(snapshot, 'MessageStore snapshot');
  assertNoZimoosState(pending, 'session-persist pending messages');

  const currentFrame = frame({
    frameId: 'frame-current',
    frameCursor: 'cursor-current',
    title: 'Current Frame Title',
    visibleContent: [
      {
        itemId: 'current',
        kind: 'panel',
        title: 'Current Frame Visible',
        content: 'Current visible content',
        priority: 1,
      },
    ],
  });
  const result = new RequestContextBuilder().build(
    snapshot,
    requestOnlyOptions(slot(currentFrame))
  );

  const carrier = assertOnlyLatestMessageHasZimoos(result.messages);
  assert.match(carrier, /frameCursor:\s*cursor-current/);
  assert.match(carrier, /Current Frame Title/);
  assert.match(carrier, /Current Frame Visible/);
  assert.doesNotMatch(messagesText(result.messages.slice(0, -1)), /cursor-current|Current Frame Title|Current Frame Visible/);
});

test('request context: frame A to B changes only the latest request-only carrier', () => {
  const store = makeStore();
  const builder = new RequestContextBuilder();
  const frameA = frame({
    frameId: 'frame-a',
    frameCursor: 'cursor-a',
    title: 'Frame A Title',
    visibleContent: [
      {
        itemId: 'a',
        kind: 'panel',
        title: 'Frame A Visible',
        content: 'A content',
        priority: 1,
      },
    ],
  });
  const frameB = frame({
    frameId: 'frame-b',
    frameCursor: 'cursor-b',
    title: 'Frame B Title',
    visibleContent: [
      {
        itemId: 'b',
        kind: 'panel',
        title: 'Frame B Visible',
        content: 'B content',
        priority: 1,
      },
    ],
  });

  const requestA = builder.build(
    store.snapshot(),
    requestOnlyOptions(slot(frameA))
  ).messages;
  const requestB = builder.build(
    store.snapshot(),
    requestOnlyOptions(slot(frameB))
  ).messages;

  assert.equal(requestA.length, requestB.length);
  assert.deepEqual(
    requestA.slice(0, -1) as ChatCompletionMessageParam[],
    requestB.slice(0, -1) as ChatCompletionMessageParam[],
    'frame changes must leave the JSON prefix before the latest carrier identical'
  );
  assert.notDeepEqual(
    requestA[requestA.length - 1],
    requestB[requestB.length - 1],
    'frame changes must affect only the latest request-only carrier'
  );

  const carrierA = assertOnlyLatestMessageHasZimoos(requestA);
  const carrierB = assertOnlyLatestMessageHasZimoos(requestB);
  assert.match(carrierA, /cursor-a/);
  assert.match(carrierA, /Frame A Title/);
  assert.match(carrierB, /cursor-b/);
  assert.match(carrierB, /Frame B Title/);
  assert.doesNotMatch(carrierB, /cursor-a|Frame A Title|Frame A Visible/);
});

function dataImage(bytes: number, fill = 7): string {
  return `data:image/png;base64,${Buffer.alloc(bytes, fill).toString('base64')}`;
}

function toolGroup(index: number, content: any): ChatCompletionMessageParam[] {
  const id = `call_${index}`;
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id,
        type: 'function',
        function: { name: 'capture', arguments: '{}' },
      }],
    } as any,
    {
      role: 'tool',
      tool_call_id: id,
      content,
    } as any,
  ];
}

function assertToolPairs(messages: ChatCompletionMessageParam[]): void {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const message of messages as any[]) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        assert.equal(typeof call.id, 'string');
        assert.ok(call.id.length > 0);
        calls.set(call.id, (calls.get(call.id) ?? 0) + 1);
      }
    }
    if (message.role === 'tool') {
      assert.equal(typeof message.tool_call_id, 'string');
      assert.ok(message.tool_call_id.length > 0);
      results.set(
        message.tool_call_id,
        (results.get(message.tool_call_id) ?? 0) + 1
      );
    }
  }
  for (const [id, count] of calls) {
    assert.equal(count, 1, `tool_call ${id} must occur exactly once`);
    assert.equal(results.get(id), 1, `tool result ${id} must occur exactly once`);
  }
  for (const [id, count] of results) {
    assert.equal(count, 1, `tool result ${id} must occur exactly once`);
    assert.equal(calls.get(id), 1, `tool_call ${id} must occur exactly once`);
  }
}

test('request context: keeps root task and recent paired tool groups while evicting old middle groups', () => {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'stable system' },
    { role: 'user', content: 'root task must survive' },
  ];
  for (let i = 0; i < 102; i++) {
    messages.push(...toolGroup(
      i,
      i === 97
        ? [{ type: 'image_url', image_url: { url: dataImage(20_000, 9) } }]
        : `tool-${i}:` + 'x'.repeat(1800)
    ));
  }
  messages.splice(messages.length - 4, 0, {
    role: 'user',
    content: '[MA internal continuation request] continue without losing root task',
  });

  const result = new RequestContextBuilder().build(messages, {
    maxTokens: 100000,
    maxBytes: 18_000,
    recentGroups: 5,
    protectedMessageIndexes: [1],
  });

  assert.ok(result.omittedGroups > 0, 'middle tool groups must be windowable');
  assert.equal(result.historicalImagesSummarized, 1);
  assert.match(JSON.stringify(result.messages), /historical image omitted from request/);
  assert.ok(result.messages.some((message: any) =>
    message.role === 'user' && message.content === 'root task must survive'
  ));
  for (const id of ['call_98', 'call_99', 'call_100', 'call_101']) {
    assert.ok(result.messages.some((message: any) =>
      message.role === 'assistant' && message.tool_calls?.some((call: any) => call.id === id)
    ), `recent tool call ${id} must survive`);
    assert.ok(result.messages.some((message: any) =>
      message.role === 'tool' && message.tool_call_id === id
    ), `recent tool result ${id} must survive`);
  }
  assertToolPairs(result.messages);
  assert.ok(result.requestBytes <= result.maxBytes);
});

test('request context: historical images become auditable summaries while latest user image stays valid', () => {
  const historical = dataImage(24_000, 1);
  const latest = dataImage(12_000, 2);
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'stable system' },
    { role: 'user', content: [{ type: 'text', text: 'old' }, { type: 'image_url', image_url: { url: historical } }] } as any,
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: [{ type: 'text', text: 'latest' }, { type: 'image_url', image_url: { url: latest } }] } as any,
  ];

  const result = new RequestContextBuilder().build(messages, {
    maxTokens: 100000,
    maxBytes: 80_000,
  });
  const serialized = JSON.stringify(result.messages);

  assert.equal(result.historicalImagesSummarized, 1);
  assert.match(serialized, /historical image omitted from request/);
  assert.match(serialized, /media_type=image\/png/);
  assert.match(serialized, /sha256=/);
  assert.doesNotMatch(serialized, new RegExp(historical.slice(0, 120)));
  assert.match(serialized, new RegExp(latest.slice(0, 120)));
  assert.ok(result.requestBytes <= result.maxBytes);
});

test('request context: byte pressure degrades excess current tool images without breaking pairing', () => {
  const first = dataImage(45_000, 3);
  const second = dataImage(45_000, 4);
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'stable system' },
    { role: 'user', content: 'inspect both screenshots' },
    ...toolGroup(1, [
      { type: 'image_url', image_url: { url: first } },
      { type: 'image_url', image_url: { url: second } },
    ]),
  ];

  const result = new RequestContextBuilder().build(messages, {
    maxTokens: 100000,
    maxBytes: 80_000,
    recentGroups: 1,
  });
  const serialized = JSON.stringify(result.messages);

  assert.equal(result.currentImagesSummarized, 1);
  assert.match(serialized, /current-turn image omitted because request byte budget was exceeded/);
  assert.match(serialized, /model did not receive pixels/);
  assert.equal((serialized.match(/"type":"image_url"/g) ?? []).length, 1);
  assertToolPairs(result.messages);
  assert.ok(result.requestBytes <= result.maxBytes);
});

test('request context: oversized latest user image fails before provider with recovery guidance', () => {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'stable system' },
    { role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image_url', image_url: { url: dataImage(90_000) } }] } as any,
  ];

  assert.throws(
    () => new RequestContextBuilder().build(messages, {
      maxTokens: 100000,
      maxBytes: 40_000,
      recentGroups: 0,
    }),
    /retry with fewer or smaller input images|compress images/i
  );
});

test('request context: Agora capability does not apply DeepSeek 240 KiB window', () => {
  const capabilities = resolveModelCapabilities({
    provider: 'agora',
    baseURL: 'mcp-stdio://agora',
    model: 'qwen3.6-35b-a3b-q4',
    apiKey: 'agora-mcp',
  });
  const result = new RequestContextBuilder().build([
    { role: 'system', content: 'stable system' },
    { role: 'user', content: 'a'.repeat(300_000) },
  ], {
    maxTokens: 200_000,
    maxBytes: capabilities.requestBodyByteLimit,
  });

  assert.ok(result.requestBytes > DEEPSEEK_REQUEST_BODY_BYTE_LIMIT);
  assert.equal(result.omittedGroups, 0);
  assert.equal(result.windowed, false);
});

test('request context: explicitly protected root user image survives an internal continuation when budget is sufficient', () => {
  const rootImage = dataImage(12_000, 5);
  const result = new RequestContextBuilder().build([
    { role: 'system', content: 'stable system' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'root task with visual reference' },
        { type: 'image_url', image_url: { url: rootImage } },
      ],
    } as any,
    { role: 'assistant', content: 'working' },
    { role: 'user', content: '[MA internal continuation request] continue' },
  ], {
    maxTokens: 100_000,
    maxBytes: 80_000,
    recentGroups: 1,
    protectedMessageIndexes: [1],
  });
  const serialized = JSON.stringify(result.messages);

  assert.match(serialized, new RegExp(rootImage.slice(0, 120)));
  assert.doesNotMatch(serialized, /historical image omitted|current-turn image omitted/);
  assert.equal(result.historicalImagesSummarized, 0);
  assert.equal(result.currentImagesSummarized, 0);
});

test('request context: protected root user image over byte budget fails instead of being summarized', () => {
  assert.throws(() => new RequestContextBuilder().build([
    { role: 'system', content: 'stable system' },
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: dataImage(60_000, 6) } }],
    } as any,
    { role: 'assistant', content: 'working' },
    { role: 'user', content: '[MA internal continuation request] continue' },
  ], {
    maxTokens: 100_000,
    maxBytes: 20_000,
    recentGroups: 1,
    protectedMessageIndexes: [1],
  }), /too large.*after safe image degradation|retry with fewer or smaller input images/i);
});

test('request context: duplicate tool_call ids are rejected by occurrence count', () => {
  const duplicateCalls: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'stable system' },
    { role: 'user', content: 'run tools' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_dup', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'call_dup', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    } as any,
    { role: 'tool', tool_call_id: 'call_dup', content: 'one' } as any,
    { role: 'tool', tool_call_id: 'call_dup', content: 'two' } as any,
  ];

  assert.throws(
    () => new RequestContextBuilder().build(duplicateCalls, {
      maxTokens: 100_000,
      maxBytes: 100_000,
    }),
    /duplicate calls: call_dup/
  );
  assert.throws(() => assertToolPairs(duplicateCalls), /exactly once/);
});

test('request context: duplicate tool results are rejected by occurrence count', () => {
  const duplicateResults: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'stable system' },
    { role: 'user', content: 'run tool' },
    ...toolGroup(7, 'first'),
    { role: 'tool', tool_call_id: 'call_7', content: 'duplicate' } as any,
  ];

  assert.throws(
    () => new RequestContextBuilder().build(duplicateResults, {
      maxTokens: 100_000,
      maxBytes: 100_000,
    }),
    /duplicate results: call_7/
  );
  assert.throws(() => assertToolPairs(duplicateResults), /exactly once/);
});

test('image tool results: valid data URLs are atomic and malformed truncated URLs are never visual input', () => {
  const valid = dataImage(8_000);
  assert.equal(compactToolResult(valid, 100), valid, 'valid image must not be string-truncated');

  const store = new MessageStore();
  store.init('system');
  store.appendUser('capture');
  store.appendAssistant('', [{
    id: 'call_bad_image',
    type: 'function',
    function: { name: 'capture', arguments: '{}' },
  }]);
  store.appendToolResult(
    'call_bad_image',
    'data:image/png;base64,AAAA\n\n[...truncated 9000 chars...]\n\nBBBB'
  );

  const tool = store.snapshot().find((message: any) => message.role === 'tool') as any;
  assert.equal(typeof tool.content, 'string');
  assert.match(tool.content, /invalid image data URL omitted/);
  assert.doesNotMatch(JSON.stringify(tool), /"type":"image_url"/);
});

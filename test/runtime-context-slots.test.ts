import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeContextSlotStore,
  ZIMOOS_CURRENT_FRAME_SLOT_ID,
  createZimoosRuntimeSlotUpdate,
  parseZimoosOSFrame,
  renderZimoosRequestOnlyAttachment,
} from '../src/agent/runtime-context-slots.js';

function frame(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 'zimoos/os-frame',
    version: '0.1',
    frameId: 'frame-1',
    frameCursor: 'cursor-1',
    osInstanceId: 'os-1',
    agentId: 'agent-1',
    status: 'idle',
    title: 'Home',
    summary: 'Current zimoos home frame',
    breadcrumb: [{ label: 'Home' }],
    visibleContent: [
      { itemId: 'item-1', kind: 'text', title: 'Welcome', content: 'Hello world', priority: 1 },
    ],
    shortcuts: [
      { id: 's1', cmd: 'open app:notes', label: 'Open Notes', effectPreview: 'Opens Notes', riskLevel: 'safe', requiresConfirmation: false },
    ],
    handles: [
      { id: 'h1', label: 'Details', effectPreview: 'Expand details', tokenEstimate: 300 },
    ],
    recoveryActions: [],
    notifications: [],
    tokenBudget: { max: 4000, used: 300, truncated: false },
    updatedAt: '2026-07-02T10:00:00.000Z',
    ...overrides,
  };
}

test('parseZimoosOSFrame: accepts protocol frame independent of tool name', () => {
  const parsed = parseZimoosOSFrame(JSON.stringify(frame({ frameCursor: 'cursor-protocol' })));
  assert.ok(parsed);
  assert.equal(parsed.frameCursor, 'cursor-protocol');
});

test('parseZimoosOSFrame: rejects ordinary MCP JSON and malformed payloads', () => {
  assert.equal(parseZimoosOSFrame(JSON.stringify({ ok: true, protocol: 'other' })), null);
  assert.equal(parseZimoosOSFrame(JSON.stringify({ protocol: 'zimoos/os-frame', version: '0.1' })), null);
  assert.equal(parseZimoosOSFrame('{bad-json'), null);
});

test('renderZimoosRequestOnlyAttachment: exposes visibleContentCount explicitly', () => {
  const update = createZimoosRuntimeSlotUpdate({
    rawResult: JSON.stringify(frame({
      visibleContent: [
        { itemId: 'item-1', kind: 'text', title: 'One', content: 'First', priority: 1 },
        { itemId: 'item-2', kind: 'text', title: 'Two', content: 'Second', priority: 2 },
      ],
    })),
    isError: false,
    sourceTool: 'mteam-primary__zimoos.current',
    toolCallId: 'call-visible-count',
  });
  assert.ok(update);

  const rendered = renderZimoosRequestOnlyAttachment(update.value);
  assert.match(rendered, /visible_content_count="2"/);
});

test('RuntimeContextSlotStore: consecutive OSFrames keep only latest frame', () => {
  const store = new RuntimeContextSlotStore();
  for (let i = 1; i <= 3; i++) {
    const update = createZimoosRuntimeSlotUpdate({
      rawResult: JSON.stringify(frame({
        frameId: `frame-${i}`,
        frameCursor: `cursor-${i}`,
        title: `Title ${i}`,
      })),
      isError: false,
      sourceTool: `server-${i}__renamed.tool`,
      toolCallId: `call-${i}`,
      receivedAt: `2026-07-02T10:00:0${i}.000Z`,
    });
    assert.ok(update);
    store.set(update);
  }

  const value = store.get(ZIMOOS_CURRENT_FRAME_SLOT_ID);
  assert.ok(value);
  assert.equal(value.frame.frameId, 'frame-3');
  assert.equal(value.frame.frameCursor, 'cursor-3');

  const rendered = store.render();
  assert.match(rendered, /<zimoos\b/);
  assert.match(rendered, /source="zimoos\.currentFrame"/);
  assert.match(rendered, /request_only="true"/);
  assert.doesNotMatch(rendered, /\[ZimoOS Current Frame\]/);
  assert.match(rendered, /cursor-3/);
  assert.match(rendered, /Title 3/);
  assert.doesNotMatch(rendered, /cursor-1/);
  assert.doesNotMatch(rendered, /Title 1/);
});

test('createZimoosRuntimeSlotUpdate: error or malformed result does not update slot', () => {
  const store = new RuntimeContextSlotStore();
  const first = createZimoosRuntimeSlotUpdate({
    rawResult: JSON.stringify(frame({ frameCursor: 'cursor-ok' })),
    isError: false,
    sourceTool: 'mteam-primary__zimoos.current',
    toolCallId: 'call-ok',
  });
  assert.ok(first);
  store.set(first);

  const errorUpdate = createZimoosRuntimeSlotUpdate({
    rawResult: JSON.stringify(frame({ frameCursor: 'cursor-error' })),
    isError: true,
    sourceTool: 'mteam-primary__zimoos.act',
    toolCallId: 'call-error',
  });
  assert.equal(errorUpdate, null);

  const malformedUpdate = createZimoosRuntimeSlotUpdate({
    rawResult: JSON.stringify({ protocol: 'zimoos/os-frame', version: '0.1' }),
    isError: false,
    sourceTool: 'mteam-primary__zimoos.current',
    toolCallId: 'call-bad',
  });
  assert.equal(malformedUpdate, null);
  assert.equal(store.get(ZIMOOS_CURRENT_FRAME_SLOT_ID)?.frame.frameCursor, 'cursor-ok');
});

test('render: bounded slot summary does not leak full JSON payload', () => {
  const store = new RuntimeContextSlotStore();
  const update = createZimoosRuntimeSlotUpdate({
    rawResult: JSON.stringify(frame({
      frameCursor: 'cursor-bounded',
      visibleContent: Array.from({ length: 30 }, (_, i) => ({
        itemId: `item-${i}`,
        kind: 'row',
        title: `Row ${i}`,
        content: `Long row content ${i} `.repeat(50),
        priority: i,
      })),
      shortcuts: Array.from({ length: 20 }, (_, i) => ({
        id: `shortcut-${i}`,
        cmd: `cmd-${i}`,
        label: `Shortcut ${i}`,
        effectPreview: `Effect ${i}`,
        riskLevel: 'safe',
        requiresConfirmation: false,
      })),
    })),
    isError: false,
    sourceTool: 'renamed__zimoos.search',
    toolCallId: 'call-bounded',
  });
  assert.ok(update);
  store.set(update);

  const rendered = store.render();
  assert.ok(rendered.length < 5000, `rendered slot too large: ${rendered.length}`);
  assert.match(rendered, /<zimoos\b/);
  assert.match(rendered, /request_only="true"/);
  assert.doesNotMatch(rendered, /\[ZimoOS Current Frame\]/);
  assert.match(rendered, /cursor-bounded/);
  assert.match(rendered, /more visible items omitted/);
  assert.match(rendered, /more shortcuts omitted/);
  assert.doesNotMatch(rendered, /"visibleContent"/);
  assert.doesNotMatch(rendered, /\{"protocol"/);
});

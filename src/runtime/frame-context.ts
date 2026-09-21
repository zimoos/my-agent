import type { ControlledExtension } from './extensions.js';
import type { McpCallResult } from '../mcp/types.js';
import { isZimoosOSFrame, parseZimoosOSFrame, type ZimoosOSFrame } from '../agent/runtime-context-slots.js';
import type { Invocation, ToolReceipt } from './contracts.js';
import type { MaBootstrapV2 } from './public-types.js';
import { cloneRuntimeJson, ownData } from './data.js';
import { projectMcpToolResult } from './mcp-tool-projection.js';
import { ToolPreflightError } from './tool-bridge.js';

/** A request projection of the Host-owned OS; this stores no application business state. */
export function createFrameContext(binding: NonNullable<MaBootstrapV2['virtualUi']>) {
  const identity = cloneRuntimeJson(binding);
  let latest: ZimoosOSFrame | undefined;
  const pending = new Map<string, ZimoosOSFrame>();
  const allowed = new Set(Object.values(identity.tools));
  const belongs = (invocation: Invocation) => invocation.source.serverId === identity.serverId
    && allowed.has(invocation.source.toolName);
  return {
    invalidate() { latest = undefined; },
    beforeAction() {
      if (!latest) throw new ToolPreflightError('Observe the current ZimoOS frame with zimoos.current before acting.');
    },
    project(invocation: Invocation, raw: McpCallResult) {
      const projected = projectMcpToolResult(raw);
      if (!belongs(invocation)) return projected;
      const structured = cloneRuntimeJson(raw.structuredContent ?? {});
      const candidate = isZimoosOSFrame(structured) ? structured
        : isZimoosOSFrame(ownData(structured, 'frame')) ? ownData(structured, 'frame') as ZimoosOSFrame
        : parseZimoosOSFrame(raw.content);
      if (!candidate || (candidate.osInstanceId && candidate.osInstanceId !== identity.osInstanceId)
        || (candidate.agentId && candidate.agentId !== identity.agentId)) {
        latest = undefined;
        throw new Error('MA_VUI_FRAME_INVALID');
      }
      const frame = cloneRuntimeJson(candidate);
      pending.set(invocation.executionId, frame);
      // All callable handles, commands and input schemas remain intact in the request-only frame.
      // History keeps the action/receipt identity plus actual images, never an obsolete frame body.
      return { ...projected,
        content: [{ type: 'text' as const, text: `ZimoOS ${invocation.source.toolName}: frameCursor=${frame.frameCursor}; current UI state is available in the request-only frame.` },
          ...projected.content.filter(block => block.type === 'image')],
        details: {},
      };
    },
    confirm(invocation: Invocation, receipt: ToolReceipt) {
      const frame = pending.get(invocation.executionId);
      pending.delete(invocation.executionId);
      if (!frame) return;
      if (receipt.status === 'unknown') { latest = undefined; return; }
      latest = frame;
    },
    extension: ((extension) => {
      extension.on('context', event => {
        if (!latest) return;
        return { messages: [...event.messages, { role: 'user' as const, timestamp: Date.now(),
          content: [{ type: 'text' as const,
            text: `MA request-only current ZimoOS frame (${identity.osInstanceId}):\n${JSON.stringify(latest)}` }],
        }] };
      });
      extension.on('session_before_compact', () => { latest = undefined; });
      extension.on('session_tree', () => { latest = undefined; });
      extension.on('session_start', () => { latest = undefined; });
    }) satisfies ControlledExtension,
  };
}

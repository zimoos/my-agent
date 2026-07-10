export const ZIMOOS_CURRENT_FRAME_SLOT_ID = 'zimoos.currentFrame' as const;

type ZimoosRiskLevel = 'safe' | 'low' | 'medium' | 'high' | string;

export interface ZimoosShortcut {
  id?: string;
  cmd: string;
  label?: string;
  effectPreview?: string;
  riskLevel?: ZimoosRiskLevel;
  requiresConfirmation?: boolean;
}

export interface ZimoosDisplayItem {
  itemId?: string;
  kind?: string;
  title?: string;
  content?: string;
  priority?: number;
}

export interface ZimoosHandle {
  id: string;
  label?: string;
  effectPreview?: string;
  tokenEstimate?: number;
}

export interface ZimoosBreadcrumbItem {
  label: string;
  appInstanceId?: string;
}

export interface ZimoosNotification {
  id?: string;
  appInstanceId?: string;
  appId?: string;
  summary: string;
  priority?: string;
  status?: string;
}

export interface ZimoosOSFrame {
  protocol: 'zimoos/os-frame';
  version: string;
  frameId?: string;
  frameCursor: string;
  osInstanceId?: string;
  agentId?: string;
  currentAppInstanceId?: string;
  status?: string;
  title?: string;
  summary?: string;
  breadcrumb?: ZimoosBreadcrumbItem[];
  visibleContent: ZimoosDisplayItem[];
  shortcuts: ZimoosShortcut[];
  handles: ZimoosHandle[];
  recoveryActions?: ZimoosShortcut[];
  notifications?: ZimoosNotification[];
  tokenBudget?: {
    max?: number;
    used?: number;
    truncated?: boolean;
  };
  updatedAt?: string;
}

export interface ZimoosFrameSlotValue {
  frame: ZimoosOSFrame;
  sourceTool: string;
  toolCallId: string;
  receivedAt: string;
}

export type RuntimeContextSlotUpdate = {
  slotId: typeof ZIMOOS_CURRENT_FRAME_SLOT_ID;
  value: ZimoosFrameSlotValue;
  auditText: string;
};

const PENDING_SUMMARY = 'pending LLM correction';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && (value[key] as string).trim().length > 0;
}

function hasArray(value: Record<string, unknown>, key: string): boolean {
  return Array.isArray(value[key]);
}

export function isZimoosOSFrame(value: unknown): value is ZimoosOSFrame {
  if (!isRecord(value)) return false;
  return (
    value.protocol === 'zimoos/os-frame' &&
    hasString(value, 'version') &&
    hasString(value, 'frameCursor') &&
    hasArray(value, 'visibleContent') &&
    hasArray(value, 'shortcuts') &&
    hasArray(value, 'handles')
  );
}

export function parseZimoosOSFrame(raw: string): ZimoosOSFrame | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return isZimoosOSFrame(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isZimoosProtocolPayload(raw: string): boolean {
  if (!raw || typeof raw !== 'string') return false;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) && parsed.protocol === 'zimoos/os-frame';
  } catch {
    return false;
  }
}

function oneLine(value: unknown, max = 180): string {
  const text = typeof value === 'string' ? value : '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function stableSerialize(value: unknown, max = 500): string {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (!input || typeof input !== 'object') return input;
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map(normalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      out[key] = normalize((input as Record<string, unknown>)[key]);
    }
    return out;
  };
  try {
    const text = JSON.stringify(normalize(value ?? {}));
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
  } catch {
    return '{}';
  }
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;');
}

function sanitizeOperationSummary(summary: string): string {
  const withoutRequestOnlyState = summary
    .replace(/<zimoos\b[\s\S]*?<\/zimoos>/gi, '[request-only ZimoOS state omitted]')
    .replace(/\[ZimoOS Current Frame\]/g, 'ZimoOS current frame');
  const normalized = withoutRequestOnlyState.replace(/\s+/g, ' ').trim();
  return normalized
    ? oneLine(normalized, 700)
    : 'No assistant summary was produced for this ZimoOS operation.';
}

function limitItems<T>(items: T[] | undefined, max: number): { shown: T[]; omitted: number } {
  const arr = Array.isArray(items) ? items : [];
  return {
    shown: arr.slice(0, max),
    omitted: Math.max(0, arr.length - max),
  };
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function createZimoosToolAuditText(
  frame: ZimoosOSFrame,
  sourceTool: string,
  actionArgs?: Record<string, unknown>
): string {
  const visible = Array.isArray(frame.visibleContent) ? frame.visibleContent.length : 0;
  const shortcuts = Array.isArray(frame.shortcuts) ? frame.shortcuts.length : 0;
  const handles = Array.isArray(frame.handles) ? frame.handles.length : 0;
  const status = oneLine(frame.status, 40) || 'unknown';
  const title = oneLine(frame.title, 120) || 'untitled';
  const action = `${sourceTool} ${stableSerialize(actionArgs ?? {})}`;
  return [
    '[ZimoOS Operation]',
    `Action: ${action}`,
    `Summary: ${PENDING_SUMMARY}.`,
    `Frame audit: Updated live slot ${ZIMOOS_CURRENT_FRAME_SLOT_ID}; audit only: frameCursor=${frame.frameCursor}, title=${title}, status=${status}, ${countLabel(visible, 'visible item')}, ${countLabel(shortcuts, 'action')}, ${countLabel(handles, 'handle')}.`,
    'Current UI state is request-only and is not duplicated in tool history.',
  ].join(' ');
}

export function createInvalidZimoosFrameAuditText(
  sourceTool: string,
  actionArgs?: Record<string, unknown>
): string {
  const action = `${sourceTool} ${stableSerialize(actionArgs ?? {})}`;
  return [
    '[ZimoOS Operation]',
    `Action: ${action}`,
    `Summary: ${PENDING_SUMMARY}.`,
    'Frame audit: rejected malformed ZimoOS frame payload; raw payload omitted; live slot was not updated.',
  ].join(' ');
}

export function sanitizeZimoosToolResultForHistory(params: {
  rawResult: string;
  sourceTool: string;
  actionArgs?: Record<string, unknown>;
}): string | null {
  const frame = parseZimoosOSFrame(params.rawResult);
  if (frame) {
    return createZimoosToolAuditText(
      frame,
      params.sourceTool,
      params.actionArgs
    );
  }
  return isZimoosProtocolPayload(params.rawResult)
    ? createInvalidZimoosFrameAuditText(params.sourceTool, params.actionArgs)
    : null;
}

export function completeZimoosToolAuditSummary(
  auditText: string,
  summary: string
): string | null {
  if (!auditText.includes(`[ZimoOS Operation]`) || !auditText.includes(`Summary: ${PENDING_SUMMARY}.`)) {
    return null;
  }
  return auditText.replace(
    `Summary: ${PENDING_SUMMARY}.`,
    `Summary: ${sanitizeOperationSummary(summary)}.`
  );
}

export function createZimoosRuntimeSlotUpdate(params: {
  rawResult: string;
  isError: boolean;
  sourceTool: string;
  toolCallId: string;
  actionArgs?: Record<string, unknown>;
  receivedAt?: string;
}): RuntimeContextSlotUpdate | null {
  if (params.isError) return null;
  const frame = parseZimoosOSFrame(params.rawResult);
  if (!frame) return null;
  const value: ZimoosFrameSlotValue = {
    frame,
    sourceTool: params.sourceTool,
    toolCallId: params.toolCallId,
    receivedAt: params.receivedAt ?? new Date().toISOString(),
  };
  return {
    slotId: ZIMOOS_CURRENT_FRAME_SLOT_ID,
    value,
    auditText: createZimoosToolAuditText(frame, params.sourceTool, params.actionArgs),
  };
}

function renderBreadcrumb(frame: ZimoosOSFrame): string {
  const labels = (frame.breadcrumb ?? [])
    .map((item) => oneLine(item?.label, 60))
    .filter(Boolean);
  return labels.length > 0 ? labels.join(' > ') : '';
}

function renderVisibleContent(frame: ZimoosOSFrame): string[] {
  const { shown, omitted } = limitItems(frame.visibleContent, 8);
  const lines = shown.map((item) => {
    const label = [
      oneLine(item.kind, 30),
      oneLine(item.itemId, 40),
    ].filter(Boolean).join(':') || 'item';
    const title = oneLine(item.title, 100);
    const content = oneLine(item.content, 260);
    return `- ${label}${title ? ` | ${title}` : ''}${content ? `: ${content}` : ''}`;
  });
  if (omitted > 0) lines.push(`- ... ${omitted} more visible items omitted`);
  return lines;
}

function renderShortcuts(title: string, shortcuts: ZimoosShortcut[] | undefined): string[] {
  const { shown, omitted } = limitItems(shortcuts, 12);
  if (shown.length === 0) return [];
  const lines = [`${title}:`];
  for (const shortcut of shown) {
    const cmd = oneLine(shortcut.cmd, 120);
    const label = oneLine(shortcut.label, 90);
    const risk = oneLine(shortcut.riskLevel, 20);
    const confirm = shortcut.requiresConfirmation ? ', confirm' : '';
    const effect = oneLine(shortcut.effectPreview, 140);
    lines.push(`- ${cmd}${label ? ` | ${label}` : ''}${risk ? ` (${risk}${confirm})` : confirm ? ` (${confirm.slice(2)})` : ''}${effect ? `: ${effect}` : ''}`);
  }
  if (omitted > 0) lines.push(`- ... ${omitted} more shortcuts omitted`);
  return lines;
}

function renderHandles(frame: ZimoosOSFrame): string[] {
  const { shown, omitted } = limitItems(frame.handles, 10);
  if (shown.length === 0) return [];
  const lines = ['Handles:'];
  for (const handle of shown) {
    const id = oneLine(handle.id, 80);
    const label = oneLine(handle.label, 100);
    const effect = oneLine(handle.effectPreview, 140);
    const tokens = typeof handle.tokenEstimate === 'number'
      ? ` (~${handle.tokenEstimate} tokens)`
      : '';
    lines.push(`- ${id}${label ? ` | ${label}` : ''}${tokens}${effect ? `: ${effect}` : ''}`);
  }
  if (omitted > 0) lines.push(`- ... ${omitted} more handles omitted`);
  return lines;
}

function renderNotifications(frame: ZimoosOSFrame): string[] {
  const { shown, omitted } = limitItems(frame.notifications, 8);
  if (shown.length === 0) return [];
  const lines = ['Notifications:'];
  for (const notification of shown) {
    const summary = oneLine(notification.summary, 180);
    const status = oneLine(notification.status, 30);
    const priority = oneLine(notification.priority, 30);
    const meta = [status, priority].filter(Boolean).join(', ');
    lines.push(`- ${summary}${meta ? ` (${meta})` : ''}`);
  }
  if (omitted > 0) lines.push(`- ... ${omitted} more notifications omitted`);
  return lines;
}

function renderZimoosFrameSlotLines(
  value: ZimoosFrameSlotValue,
  options: { heading?: string; shortcutTitle: string }
): string[] {
  const frame = value.frame;
  const lines = [
    ...(options.heading ? [options.heading] : []),
    `sourceTool: ${value.sourceTool}`,
    `toolCallId: ${value.toolCallId}`,
    `receivedAt: ${value.receivedAt}`,
    `frameId: ${oneLine(frame.frameId, 120) || '(unknown)'}`,
    `frameCursor: ${frame.frameCursor}`,
    `updatedAt: ${oneLine(frame.updatedAt, 80) || '(unknown)'}`,
    `status: ${oneLine(frame.status, 40) || '(unknown)'}`,
    `title: ${oneLine(frame.title, 160) || '(untitled)'}`,
  ];

  const summary = oneLine(frame.summary, 300);
  if (summary) lines.push(`summary: ${summary}`);
  const breadcrumb = renderBreadcrumb(frame);
  if (breadcrumb) lines.push(`breadcrumb: ${breadcrumb}`);
  if (frame.currentAppInstanceId) {
    lines.push(`currentAppInstanceId: ${oneLine(frame.currentAppInstanceId, 120)}`);
  }
  if (frame.tokenBudget) {
    const used = typeof frame.tokenBudget.used === 'number' ? frame.tokenBudget.used : '?';
    const max = typeof frame.tokenBudget.max === 'number' ? frame.tokenBudget.max : '?';
    const truncated = frame.tokenBudget.truncated ? ', truncated' : '';
    lines.push(`tokenBudget: ${used}/${max}${truncated}`);
  }

  const visible = renderVisibleContent(frame);
  if (visible.length > 0) {
    lines.push('Visible content:', ...visible);
  }
  lines.push(...renderShortcuts(options.shortcutTitle, frame.shortcuts));
  lines.push(...renderHandles(frame));
  lines.push(...renderShortcuts('Recovery actions', frame.recoveryActions));
  lines.push(...renderNotifications(frame));
  return lines;
}

export function renderZimoosFrameSlot(value: ZimoosFrameSlotValue): string {
  return renderZimoosFrameSlotLines(value, {
    heading: '[ZimoOS Current Frame]',
    shortcutTitle: 'Shortcuts',
  }).join('\n');
}

export function renderZimoosRequestOnlyAttachment(value: ZimoosFrameSlotValue): string {
  const frame = value.frame;
  const body = renderZimoosFrameSlotLines(value, {
    shortcutTitle: 'Actions',
  }).join('\n');
  return [
    `<zimoos source="${escapeXmlAttr(ZIMOOS_CURRENT_FRAME_SLOT_ID)}" request_only="true" frame_cursor="${escapeXmlAttr(frame.frameCursor)}" updated_at="${escapeXmlAttr(oneLine(frame.updatedAt, 80) || '')}" visible_content_count="${escapeXmlAttr(String(frame.visibleContent.length))}">`,
    escapeXmlText(body),
    '</zimoos>',
  ].join('\n');
}

export class RuntimeContextSlotStore {
  private zimoosCurrentFrame: ZimoosFrameSlotValue | null = null;

  set(update: RuntimeContextSlotUpdate): void {
    if (update.slotId !== ZIMOOS_CURRENT_FRAME_SLOT_ID) return;
    this.zimoosCurrentFrame = update.value;
  }

  get(slotId: typeof ZIMOOS_CURRENT_FRAME_SLOT_ID): ZimoosFrameSlotValue | null {
    if (slotId !== ZIMOOS_CURRENT_FRAME_SLOT_ID) return null;
    return this.zimoosCurrentFrame;
  }

  clear(): void {
    this.zimoosCurrentFrame = null;
  }

  render(): string {
    return this.zimoosCurrentFrame
      ? renderZimoosRequestOnlyAttachment(this.zimoosCurrentFrame)
      : '';
  }

  renderRequestOnlyAttachment(): string {
    return this.zimoosCurrentFrame
      ? renderZimoosRequestOnlyAttachment(this.zimoosCurrentFrame)
      : '';
  }
}

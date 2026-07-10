import test, { type TestContext } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  e2eConfigSkipReason,
  resolveE2EConfigPath,
  tmpFile,
} from './helpers/real-env.js';
import { hasLlmError, runMaPrompt } from './helpers/cli-runner.js';

const DEFAULT_HUB_URL = 'http://127.0.0.1:58590';
const DEFAULT_BACKEND_DIR = '/Users/zhuqingyu/dev/mteam/packages/backend';

interface ProbeResult {
  ok: boolean;
  reason?: string;
}

interface ZimoosAttachmentSnapshot {
  title: string;
  frameCursor: string;
  visibleContentCount: number;
}

function requireConfig(t: TestContext): string | null {
  const configPath = resolveE2EConfigPath();
  if (!configPath) {
    t.skip(e2eConfigSkipReason());
    return null;
  }
  return configPath;
}

function resolveBackendDir(): string | null {
  const candidate = process.env.MTEAM_BACKEND_DIR || DEFAULT_BACKEND_DIR;
  const resolved = path.resolve(candidate);
  return fs.existsSync(path.join(resolved, 'src/mcp-primary/index.ts'))
    ? resolved
    : null;
}

function hasBun(): boolean {
  const result = spawnSync('bun', ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 5000
): Promise<{ ok: boolean; status: number; json?: any; text: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function isOsFrame(value: any): boolean {
  return (
    value &&
    value.protocol === 'zimoos/os-frame' &&
    typeof value.frameCursor === 'string' &&
    Array.isArray(value.visibleContent) &&
    Array.isArray(value.shortcuts) &&
    Array.isArray(value.handles)
  );
}

function messageContentText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      return JSON.stringify(part);
    }).join('\n');
  }
  return '';
}

function parseDebugRequests(log: string): any[][] {
  const out: any[][] = [];
  const re = /API REQUEST messages \(\d+\):\n([\s\S]*?)(?=\n\n\[|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(log)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) out.push(parsed);
    } catch {
      /* ignore non-request debug fragments */
    }
  }
  return out;
}

function assertDebugLatestMessageZimoosOnly(messages: any[]): void {
  assert.ok(messages.length > 0, 'debug request messages must not be empty');
  const zimoosIndexes = messages
    .map((m, index) => ({ index, text: messageContentText(m) }))
    .filter(({ text }) => /<zimoos\b/.test(text))
    .map(({ index }) => index);

  assert.deepEqual(
    zimoosIndexes,
    [messages.length - 1],
    'debug request must show <zimoos> only on the latest request message'
  );
  assert.equal(
    messages[messages.length - 1]?.role,
    'user',
    'latest debug request-only ZimoOS carrier must be role=user'
  );
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== 'system') continue;
    assert.doesNotMatch(
      messageContentText(messages[i]),
      /<zimoos\b|\[ZimoOS Current Frame\]/,
      `debug role=system message[${i}] must not contain ZimoOS current state`
    );
  }
  for (let i = 0; i < messages.length - 1; i++) {
    assert.doesNotMatch(
      messageContentText(messages[i]),
      /<zimoos\b|\[ZimoOS Current Frame\]/,
      `debug historical message[${i}] must not contain ZimoOS current state`
    );
  }
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function readRequiredZimoosAttribute(attributes: string, name: string): string {
  const match = attributes.match(new RegExp(`\\b${name}="([^"]*)"`));
  assert.ok(match, `latest ZimoOS attachment must include ${name}`);
  return decodeXmlText(match[1]);
}

function readLatestZimoosAttachment(messages: any[]): ZimoosAttachmentSnapshot {
  const carrier = messages[messages.length - 1];
  const attachments = [...messageContentText(carrier).matchAll(/<zimoos\b([^>]*)>([\s\S]*?)<\/zimoos>/g)];
  assert.ok(attachments.length > 0, 'latest debug request must contain a ZimoOS attachment');

  const [, attributes, encodedBody] = attachments[attachments.length - 1];
  const title = decodeXmlText(encodedBody).match(/^title:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(title, 'latest ZimoOS attachment must include its rendered title');

  const frameCursor = readRequiredZimoosAttribute(attributes, 'frame_cursor');
  const visibleContentCountText = readRequiredZimoosAttribute(attributes, 'visible_content_count');
  assert.match(visibleContentCountText, /^\d+$/, 'visible_content_count must be a non-negative integer');
  return {
    title,
    frameCursor,
    visibleContentCount: Number(visibleContentCountText),
  };
}

async function probeZimoos(hubUrl: string, instanceId: string): Promise<ProbeResult> {
  const panel = await postJson(`${hubUrl}/api/panel/zimoos/current`, {
    teamId: 'local',
    agentId: 'ma-e2e',
    instanceId,
  }).catch((err) => ({
    ok: false,
    status: 0,
    text: (err as Error).message,
  }));
  if (panel.ok && isOsFrame((panel as any).json)) {
    return { ok: true };
  }

  const direct = await postJson(`${hubUrl}/api/zimoos/current`, { instanceId }).catch((err) => ({
    ok: false,
    status: 0,
    text: (err as Error).message,
  }));
  if (direct.ok && isOsFrame((direct as any).json)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `mteam ZimoOS backend not ready at ${hubUrl}; panel=${panel.status}:${panel.text.slice(0, 160)} direct=${direct.status}:${direct.text.slice(0, 160)}`,
  };
}

function writeTempZimoosConfig(params: {
  baseConfigPath: string;
  backendDir: string;
  hubUrl: string;
  instanceId: string;
}): string {
  const config = JSON.parse(fs.readFileSync(params.baseConfigPath, 'utf-8'));
  config.mcpServers = {
    ...(config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}),
    'mteam-primary': {
      command: 'bun',
      args: ['run', 'src/mcp-primary/index.ts'],
      cwd: params.backendDir,
      env: {
        ROLE_INSTANCE_ID: params.instanceId,
        V2_SERVER_URL: params.hubUrl,
      },
    },
  };
  const file = tmpFile('ma-zimoos-e2e-config', '.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return file;
}

test('real ZimoOS MCP e2e: current frame updates live slot and request context', { timeout: 480000 }, async (t) => {
  const baseConfigPath = requireConfig(t);
  if (!baseConfigPath) return;

  const backendDir = resolveBackendDir();
  if (!backendDir) {
    t.skip(`requires mteam backend dir; set MTEAM_BACKEND_DIR or keep ${DEFAULT_BACKEND_DIR}`);
    return;
  }
  if (!hasBun()) {
    t.skip('requires bun to launch mteam-primary stdio MCP');
    return;
  }

  const hubUrl = process.env.MTEAM_HUB_URL || DEFAULT_HUB_URL;
  const instanceId = `ma-zimoos-e2e-${Date.now()}`;
  const probe = await probeZimoos(hubUrl, instanceId);
  if (!probe.ok) {
    t.skip(probe.reason ?? `requires mteam backend at ${hubUrl}`);
    return;
  }

  const configPath = writeTempZimoosConfig({
    baseConfigPath,
    backendDir,
    hubUrl,
    instanceId,
  });
  const debugLog = tmpFile('ma-zimoos-e2e-debug', '.log');
  try {
    const result = await runMaPrompt({
      configPath,
      timeoutMs: 360000,
      env: { MA_DEBUG: debugLog },
      prompt: [
        '请先调用 zimoos.current 获取当前 ZimoOS OSFrame。',
        '然后只用中文回答 title、frameCursor、visibleContent 数量。',
        '不要猜测，不要省略 frameCursor。',
      ].join(''),
    });
    const combined = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.timedOut, false, `ZimoOS e2e timed out. Tail: ${combined.slice(-1200)}`);
    assert.equal(result.exitCode, 0, `ZimoOS e2e exited ${result.exitCode}. Tail: ${combined.slice(-1200)}`);
    assert.ok(!hasLlmError(combined), `unexpected ZimoOS e2e error. Tail: ${combined.slice(-1200)}`);
    assert.match(
      result.stderr,
      /\[tool\]\s+mteam-primary__zimoos_x2e_current/,
      `expected encoded zimoos.current tool call. Tail: ${combined.slice(-1200)}`
    );
    assert.match(result.stdout, /===FINAL_ANSWER===/);

    const log = fs.readFileSync(debugLog, 'utf-8');
    assert.match(log, /runtime slot updated: zimoos\.currentFrame/);
    assert.ok(
      !log.includes('"protocol": "zimoos/os-frame"'),
      'debug request history should not contain raw full OSFrame JSON'
    );
    assert.ok(
      !log.includes('[ZimoOS Current Frame]'),
      'debug request history must not contain the legacy ZimoOS Current Frame system block'
    );

    const debugRequests = parseDebugRequests(log);
    assert.ok(
      debugRequests.length > 0,
      'MA_DEBUG did not expose structured API REQUEST messages; cannot prove latest-message request-only ZimoOS behavior'
    );
    const zimoosRequests = debugRequests.filter((messages) =>
      messages.some((m) => /<zimoos\b|\[ZimoOS Current Frame\]/.test(messageContentText(m)))
    );
    assert.ok(
      zimoosRequests.length > 0,
      'MA_DEBUG request log did not expose a ZimoOS carrier; if content is truncated before the carrier, logging must include full request message roles/content for this e2e proof'
    );
    const latestZimoosRequest = zimoosRequests[zimoosRequests.length - 1];
    assertDebugLatestMessageZimoosOnly(latestZimoosRequest);
    const snapshot = readLatestZimoosAttachment(latestZimoosRequest);
    assert.ok(
      result.stdout.includes(snapshot.title),
      `final answer should include title from its latest ZimoOS request attachment: ${snapshot.title}. Tail: ${combined.slice(-1200)}`
    );
    assert.ok(
      result.stdout.includes(snapshot.frameCursor),
      `final answer should include frameCursor from its latest ZimoOS request attachment: ${snapshot.frameCursor}. Tail: ${combined.slice(-1200)}`
    );
    assert.ok(
      result.stdout.includes(String(snapshot.visibleContentCount)),
      `final answer should include visibleContent count from its latest ZimoOS request attachment: ${snapshot.visibleContentCount}. Tail: ${combined.slice(-1200)}`
    );
  } finally {
    try { fs.unlinkSync(configPath); } catch {}
    try { fs.unlinkSync(debugLog); } catch {}
  }
});

import type { ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';
import { ensureToolCallId } from './normalize.js';

// ── types ────────────────────────────────────────────────────────────

export interface RepairReport {
  scavenged: number;
  truncationsFixed: number;
  truncationsUnrecoverable: number;
  stormsBroken: number;
  notes: string[];
}

// ── helpers ──────────────────────────────────────────────────────────

function tryExtractToolCallJson(text: string): Record<string, any> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = text.lastIndexOf('}');
  if (end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function looksLikeToolCall(obj: Record<string, any>): boolean {
  // Must have a name-like field
  const name =
    obj.name || obj.function || obj.tool || obj.tool_name || obj.function_name;
  if (typeof name !== 'string' || !name.trim()) return false;
  // Must have args-like field or have other fields besides name
  const args =
    obj.arguments || obj.args || obj.parameters || obj.params || obj.input;
  return args !== undefined || Object.keys(obj).length >= 2;
}

function objToToolCall(
  obj: Record<string, any>
): ChatCompletionMessageToolCall | null {
  const name =
    obj.name || obj.function || obj.tool || obj.tool_name || obj.function_name;
  if (typeof name !== 'string' || !name.trim()) return null;

  const args =
    obj.arguments ?? obj.args ?? obj.parameters ?? obj.params ?? obj.input;

  let argsStr: string;
  if (args === undefined || args === null) {
    argsStr = '{}';
  } else if (typeof args === 'string') {
    argsStr = args;
  } else {
    try {
      argsStr = JSON.stringify(args);
    } catch {
      argsStr = '{}';
    }
  }

  return {
    id: ensureToolCallId(undefined),
    type: 'function',
    function: { name, arguments: argsStr },
  };
}

function callSignature(tc: ChatCompletionMessageToolCall): string {
  return `${tc.function.name}:${tc.function.arguments}`;
}

function parseArgs(raw: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    words.push(match[1] ?? match[2] ?? match[3]);
  }
  return words;
}

function leadingSimpleCommand(command: string): string {
  const match = command.match(/^(.*?)(?:\s+(?:\d?>|[;&|<>])|[;&|<>]|`|\$)/);
  return (match ? match[1] : command).trim();
}

function commandText(args: Record<string, any>): string {
  if (typeof args.command === 'string') return args.command.trim();
  if (typeof args.cmd === 'string') return args.cmd.trim();
  return '';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function userExplicitlyRequestedShellCommand(cmd: string, userText: string): boolean {
  if (!cmd || !userText) return false;
  const escaped = escapeRegex(cmd);
  const quotedCmd = `(?:["'\\\`“”])?\\b${escaped}\\b(?:["'\\\`“”])?`;
  return (
    new RegExp(`${quotedCmd}\\s*(?:命令|command)`, 'i').test(userText) ||
    new RegExp(`(?:shell|终端|命令行)\\s*(?:命令)?\\s*${quotedCmd}`, 'i').test(userText) ||
    new RegExp(`(?:用|使用|执行|运行)\\s*(?:shell|终端|命令行)?\\s*(?:命令)?\\s*${quotedCmd}`, 'i').test(userText)
  );
}

function userMentionedExactCommand(command: string, userText: string): boolean {
  if (!command || !userText) return false;
  const normalize = (s: string): string =>
    s.replace(/[`"'“”‘’]/g, '').replace(/\s+/g, ' ').trim();
  return normalize(userText).includes(normalize(command));
}

function rewriteExecToDedicatedTool(
  tc: ChatCompletionMessageToolCall,
  allowedToolNames: Set<string>,
  userText = '',
): ChatCompletionMessageToolCall | null {
  if (tc.function.name !== 'exec__execute_command' && tc.function.name !== 'exec-mcp__execute_command') {
    return null;
  }
  const args = parseArgs(tc.function.arguments);
  if (!args) return null;
  const command = commandText(args);
  if (!command) return null;
  const simpleCommand = leadingSimpleCommand(command);
  if (!simpleCommand) return null;
  const words = shellWords(simpleCommand);
  if (words.length === 0) return null;

  const cmd = words[0];
  if (
    userMentionedExactCommand(command, userText) ||
    userExplicitlyRequestedShellCommand(cmd, userText)
  ) {
    return null;
  }

  if (cmd === 'ls' && allowedToolNames.has('fs__list_directory')) {
    const flags = words.slice(1).filter((w) => w.startsWith('-'));
    const paths = words.slice(1).filter((w) => !w.startsWith('-'));
    return {
      ...tc,
      function: {
        name: 'fs__list_directory',
        arguments: JSON.stringify({
          path: paths[0] ?? '.',
          ...(flags.some((f) => f.includes('R')) ? { recursive: true } : {}),
        }),
      },
    };
  }

  if (cmd === 'cat' && words.length >= 2 && allowedToolNames.has('fs__read_file')) {
    return {
      ...tc,
      function: {
        name: 'fs__read_file',
        arguments: JSON.stringify({ path: words[1] }),
      },
    };
  }

  if ((cmd === 'grep' || cmd === 'rg') && allowedToolNames.has('grep__grep')) {
    const rest = words.slice(1);
    const nonFlags = rest.filter((w) => !w.startsWith('-') && w !== '--');
    if (nonFlags.length >= 1) {
      return {
        ...tc,
        function: {
          name: 'grep__grep',
          arguments: JSON.stringify({
            pattern: nonFlags[0],
            path: nonFlags[1] ?? '.',
            recursive: true,
          }),
        },
      };
    }
  }

  return null;
}

function rewriteKnownToolAlias(
  tc: ChatCompletionMessageToolCall,
  allowedToolNames: Set<string>,
): ChatCompletionMessageToolCall | null {
  if (tc.function.name === 'fs__file_edit' && allowedToolNames.has('fs-edit__file_edit')) {
    return {
      ...tc,
      function: {
        ...tc.function,
        name: 'fs-edit__file_edit',
      },
    };
  }
  return null;
}

function rewriteToolCall(
  tc: ChatCompletionMessageToolCall,
  allowedToolNames: Set<string>,
  userText = '',
): ChatCompletionMessageToolCall {
  return rewriteKnownToolAlias(tc, allowedToolNames) ??
    rewriteExecToDedicatedTool(tc, allowedToolNames, userText) ??
    tc;
}

// ── stage 1: scavenge ────────────────────────────────────────────────

/**
 * Extract tool calls embedded in text (content / reasoning_content).
 * Some local models emit tool calls as JSON in text rather than through
 * the structured tool_calls channel.
 */
export function scavengeToolCalls(
  text: string,
  allowedToolNames: Set<string>
): ChatCompletionMessageToolCall[] {
  if (!text || text.trim().length === 0) return [];

  const found: ChatCompletionMessageToolCall[] = [];
  const seen = new Set<string>();

  // Scan through the text for JSON objects
  const re = /\{(?:[^{}]|(?:\{[^{}]*\}))*\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const candidate = match[0];
    const obj = tryExtractToolCallJson(candidate);
    if (!obj || !looksLikeToolCall(obj)) continue;

    const tc = objToToolCall(obj);
    if (!tc) continue;

    // Only accept calls to known tools
    if (!allowedToolNames.has(tc.function.name)) continue;

    const sig = callSignature(tc);
    if (seen.has(sig)) continue;
    seen.add(sig);

    found.push(tc);
  }

  return found;
}

// ── stage 2: truncation repair ───────────────────────────────────────

export interface TruncationResult {
  repaired: string;
  fallback: boolean;
}

/**
 * Attempt to repair truncated JSON by closing unclosed braces and brackets.
 * Returns { repaired, fallback: false } on success, or
 * { repaired: original, fallback: true } when unrecoverable.
 */
export function repairTruncatedJson(raw: string): TruncationResult {
  const trimmed = raw.trim();
  if (!trimmed) return { repaired: '{}', fallback: false };

  // Fast path: already valid
  try {
    JSON.parse(trimmed);
    return { repaired: trimmed, fallback: false };
  } catch {
    // continue to repair
  }

  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"' && !escape) {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}') {
      if (stack[stack.length - 1] === '{') stack.pop();
      else return { repaired: trimmed, fallback: true };
    } else if (ch === ']') {
      if (stack[stack.length - 1] === '[') stack.pop();
      else return { repaired: trimmed, fallback: true };
    }
  }

  // Nothing to close — mark as unrecoverable
  if (stack.length === 0) return { repaired: trimmed, fallback: true };

  // Close unclosed string
  let result = trimmed;
  if (inString) result += '"';

  // Close remaining brackets/braces
  const closers: Record<string, string> = { '{': '}', '[': ']' };
  while (stack.length > 0) {
    const opener = stack.pop()!;
    result += closers[opener];
  }

  // Verify the repair produces valid JSON
  try {
    JSON.parse(result);
    return { repaired: result, fallback: false };
  } catch {
    return { repaired: trimmed, fallback: true };
  }
}

// ── stage 3: storm breaker ───────────────────────────────────────────

/**
 * Sliding-window detector for repeated identical tool calls within a turn.
 * After `threshold` identical (name, args) calls within `window` recent
 * calls, subsequent calls are suppressed.
 */
export class StormBreaker {
  private window: { name: string; args: string }[] = [];

  constructor(
    private windowSize = 6,
    private threshold = 3,
    private isMutating?: (name: string) => boolean,
    private isStormExempt?: (name: string) => boolean
  ) {}

  inspect(tc: ChatCompletionMessageToolCall): {
    suppress: boolean;
    reason?: string;
  } {
    const name = tc.function.name;
    const args = tc.function.arguments;

    // Never suppress mutating calls
    if (this.isMutating?.(name)) return { suppress: false };

    // Some tools are exempt from storm detection
    if (this.isStormExempt?.(name)) return { suppress: false };

    const count = this.window.filter(
      (w) => w.name === name && w.args === args
    ).length;

    this.window.push({ name, args });
    if (this.window.length > this.windowSize) {
      this.window = this.window.slice(-this.windowSize);
    }

    if (count >= this.threshold) {
      return {
        suppress: true,
        reason: `重复调用已被拦截：${name} 已使用相同参数调用 ${count} 次`,
      };
    }

    return { suppress: false };
  }

  /** Reset per turn — fresh intent shouldn't inherit old repetition state. */
  resetStorm(): void {
    this.window = [];
  }
}

// ── pipeline ─────────────────────────────────────────────────────────

export interface RepairOpts {
  allowedToolNames: Set<string>;
  maxScavenge?: number;
  isMutating?: (name: string) => boolean;
  isStormExempt?: (name: string) => boolean;
}

export class ToolCallRepair {
  private storm: StormBreaker;
  private allowedToolNames: Set<string>;
  private maxScavenge: number;

  constructor(opts: RepairOpts, stormWindowSize = 6, stormThreshold = 3) {
    this.allowedToolNames = opts.allowedToolNames;
    this.maxScavenge = opts.maxScavenge ?? 4;
    this.storm = new StormBreaker(
      stormWindowSize,
      stormThreshold,
      opts.isMutating,
      opts.isStormExempt
    );
  }

  /**
   * Run the full repair pipeline on a set of tool calls.
   *
   * @param calls - tool calls from the model's structured output
   * @param content - text content (may contain scavengeable calls)
   * @param reasoningContent - thinking tokens (may contain scavengeable calls)
   */
  process(
    calls: ChatCompletionMessageToolCall[],
    content?: string,
    reasoningContent?: string,
    opts: { userText?: string } = {},
  ): { calls: ChatCompletionMessageToolCall[]; report: RepairReport } {
    const report: RepairReport = {
      scavenged: 0,
      truncationsFixed: 0,
      truncationsUnrecoverable: 0,
      stormsBroken: 0,
      notes: [],
    };

    // Stage 1: Scavenge — extract calls from text content
    const textSources = [reasoningContent, content]
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
    let merged = [...calls];
    for (const text of textSources) {
      const scavenged = scavengeToolCalls(text, this.allowedToolNames);
      let added = 0;
      for (const tc of scavenged) {
        if (merged.length >= this.maxScavenge) break;
        const exists = merged.some(
          (m) => m.function.name === tc.function.name &&
               m.function.arguments === tc.function.arguments
        );
        if (!exists) {
          merged.push(tc);
          added += 1;
        }
      }
      report.scavenged += added;
      if (added > 0) {
        report.notes.push(
          `从文本中提取了 ${added} 个工具调用`
        );
      }
    }

    // Stage 2: Truncation repair
    for (const tc of merged) {
      const raw = tc.function.arguments;
      if (!raw || raw === '{}') continue;
      const r = repairTruncatedJson(raw);
      if (r.fallback) {
        report.truncationsUnrecoverable += 1;
        report.notes.push(
          `[${tc.function.name}] 参数 JSON 截断无法修复`
        );
      } else if (r.repaired !== raw) {
        tc.function.arguments = r.repaired;
        report.truncationsFixed += 1;
        report.notes.push(
          `[${tc.function.name}] 已修复截断的 JSON 参数`
        );
      }
    }

    merged = merged.map((tc) => {
      const rewritten = rewriteToolCall(tc, this.allowedToolNames, opts.userText ?? '');
      if (rewritten !== tc) {
        report.notes.push(
          `工具调用已改用专用工具：${tc.function.name} → ${rewritten.function.name}`
        );
      }
      return rewritten;
    });

    // Stage 3: Storm breaker
    const survivors: ChatCompletionMessageToolCall[] = [];
    for (const tc of merged) {
      const verdict = this.storm.inspect(tc);
      if (verdict.suppress) {
        report.stormsBroken += 1;
        report.notes.push(verdict.reason!);
      } else {
        survivors.push(tc);
      }
    }

    return { calls: survivors, report };
  }

  /** Reset storm tracker for a new turn. */
  resetStorm(): void {
    this.storm.resetStorm();
  }
}

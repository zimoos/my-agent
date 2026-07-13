import type { FileReadCoverage } from './file-read-ledger.js';

export type CompletionObligationKind = 'test' | 'browser' | 'file_read_coverage';

export interface CompletionToolEvidence {
  toolName: string;
  args: Record<string, unknown>;
  succeeded: boolean;
  verifiedAction: boolean;
}

export interface CompletionAuditDecision {
  status: 'complete' | 'retry' | 'failed';
  missing: CompletionObligationKind[];
  message?: string;
}

const MAX_COMPLETION_RETRIES = 2;

const OBLIGATION_LABELS: Record<CompletionObligationKind, string> = {
  test: '运行测试并取得成功结果',
  browser: '使用真实浏览器自动化完成验证',
  file_read_coverage: '用 read_file receipt 证明目标文件已连续完整读取',
};

function asksToRunTests(prompt: string): boolean {
  return [
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\b|:)/i,
    /\b(?:run|execute)\s+(?:(?:the|all|full|complete|relevant|unit|integration|e2e)\s+)*(?:tests?|test\s+suite)\b/i,
    /\btest\s+(?:it|this|the\s+(?:app|application|game|feature|project|change|fix))\b/i,
    /(?:请|需要|必须|务必|然后|最后|同时|并且|还要)?\s*(?:运行|执行|跑|做)(?:一下|下)?(?:完整|全部|全量|相关|单元|集成|端到端|e2e)?\s*测试/i,
    /(?:请|需要|必须|务必|然后|最后|同时|并且|还要)\s*(?:进行)?\s*测试/i,
  ].some((pattern) => pattern.test(prompt));
}

function asksForBrowserVerification(prompt: string): boolean {
  if (/\b(?:playwright|puppeteer)\b/i.test(prompt)) return true;
  return [
    /(?:真实|实际)(?:的)?\s*浏览器.{0,24}(?:验证|测试|检查)/i,
    /(?:用|使用|通过)\s*(?:真实|实际)?(?:的)?\s*浏览器.{0,24}(?:验证|测试|检查)/i,
    /浏览器.{0,24}(?:真实|实际)?(?:交互)?(?:验证|测试|检查)/i,
    /\b(?:real|actual)\s+browser.{0,40}\b(?:verify|verification|test|check)/i,
    /\b(?:use|using|with)\s+(?:a\s+)?(?:real\s+)?browser.{0,40}\b(?:verify|verification|test|check)/i,
    /\bbrowser\s+(?:automation\s+)?(?:verification|test|check)\b/i,
  ].some((pattern) => pattern.test(prompt));
}

function asksForCompleteFileReading(prompt: string): boolean {
  if (
    extractExplicitFileHints(prompt).length > 0 &&
    /(?:完整|全部|全量|逐行)\s*(?:阅读|读取|查看|审阅|检查)|\b(?:fully|completely)\s+(?:read|review|inspect)\b/i.test(prompt)
  ) return true;
  return [
    /(?:完整|全部|全量|逐行).{0,24}(?:阅读|读取|查看|审阅|检查).{0,24}(?:文件|源码|代码|项目)/i,
    /(?:阅读|读取|查看|审阅|检查).{0,24}(?:完整|全部|全量).{0,24}(?:文件|源码|代码|项目)/i,
    /\b(?:fully|completely)\s+(?:read|review|inspect)\b.{0,40}\b(?:file|source|code|project)/i,
    /\b(?:read|review|inspect)\s+(?:all|every|the\s+entire)\b.{0,40}\b(?:file|source|code|project)/i,
  ].some((pattern) => pattern.test(prompt));
}

function claimsCompleteFileReading(text: string): boolean {
  return [
    /(?:已经|已|我已).{0,8}(?:完整|全部|全量).{0,16}(?:阅读|读取|查看|审阅|检查)/i,
    /(?:完整|全部|全量).{0,12}(?:看过|读过|审阅完|检查完)/i,
    /\b(?:fully|completely)\s+(?:read|reviewed|inspected)\b/i,
    /\b(?:read|reviewed|inspected)\s+(?:all|every|the\s+entire)\b/i,
  ].some((pattern) => pattern.test(text));
}

export function extractExplicitFileHints(prompt: string): string[] {
  const withoutUrls = prompt.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  const candidates = withoutUrls.match(/[A-Za-z0-9_@./\\:+-]{1,512}/g) ?? [];
  const matches = candidates
    .map((value) => value.replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((value) => /^(?:[A-Za-z]:\/|\/)?(?:[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@+-]+\.[A-Za-z][A-Za-z0-9]{0,11}$/.test(value));
  return [...new Set(matches)];
}

function coverageMatchesHint(path: string, hint: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedHint = hint.replace(/\\/g, '/').replace(/^\.\//, '');
  if (hint.startsWith('/')) return normalizedPath === normalizedHint;
  return normalizedPath === normalizedHint || normalizedPath.endsWith(`/${normalizedHint}`);
}

export function extractCompletionObligations(
  rootPrompt: string
): CompletionObligationKind[] {
  const obligations: CompletionObligationKind[] = [];
  if (asksToRunTests(rootPrompt)) obligations.push('test');
  if (asksForBrowserVerification(rootPrompt)) obligations.push('browser');
  if (asksForCompleteFileReading(rootPrompt)) obligations.push('file_read_coverage');
  return obligations;
}

function commandFromArgs(args: Record<string, unknown>): string {
  const value = typeof args.cmd === 'string'
    ? args.cmd
    : typeof args.command === 'string'
      ? args.command
      : '';
  return value.trim();
}

function isExecuteCommand(toolName: string): boolean {
  return /(?:^|__)execute_command$/i.test(toolName);
}

export function isSemanticTestCommand(command: string): boolean {
  return [
    /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\b|:)/i,
    /\b(?:npx\s+|pnpm\s+exec\s+|yarn\s+dlx\s+|bunx\s+)?(?:vitest|jest|mocha|ava|tap)\b/i,
    /\bnode\s+--test\b/i,
    /\b(?:pytest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|ctest|rspec)\b/i,
    /\b(?:make|just)\s+(?:test|check)\b/i,
    /\bplaywright\s+test\b/i,
    /\b(?:node|tsx|ts-node|python\d*|bash|sh)\s+[^\n;&|]*(?<![a-z0-9])(?:test|spec)(?:[-_.\/][^\s;&|]+)*\.(?:[cm]?[jt]s|tsx?|py|sh)\b/i,
  ].some((pattern) => pattern.test(command));
}

export function isBrowserVerificationCommand(command: string): boolean {
  return [
    /\b(?:npx\s+|pnpm\s+exec\s+|yarn\s+dlx\s+|bunx\s+)?playwright\s+test\b/i,
    /\b(?:node|tsx|ts-node|python\d*|bash|sh)\s+[^\n;&|]*(?:playwright|puppeteer|browser)[-_.\/](?:[^\s;&|]*[-_.\/])*(?:test|verify|verification|e2e)[^\s;&|]*/i,
    /\b(?:node|tsx|ts-node|python\d*|bash|sh)\s+[^\n;&|]*(?:test|verify|verification|e2e)[-_.\/](?:[^\s;&|]*[-_.\/])*(?:browser|playwright|puppeteer)[^\s;&|]*/i,
    /(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|verify|verification|e2e)[:_-](?:browser|playwright|puppeteer)\b/i,
    /\b(?:puppeteer|playwright)\b[^\n;&|]*\b(?:test|verify|verification|e2e|goto|launch)\b/i,
  ].some((pattern) => pattern.test(command));
}

function isBrowserAutomationTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  if (/(?:web_fetch|web_search|http|fetch|search|download)/.test(lower)) {
    return false;
  }
  if (!/(?:^|__|_)(?:browser|playwright|puppeteer|chrome)(?:__|_|$)/.test(lower)) {
    return false;
  }
  return /(?:navigate|goto|open|click|type|fill|press|hover|select|evaluate|inspect|screenshot|wait)/.test(lower);
}

export class CompletionObligationAudit {
  private readonly required: Set<CompletionObligationKind>;
  private readonly explicitFileHints: string[];
  private readonly completed = new Set<CompletionObligationKind>();
  private retryCount = 0;
  private fileReadCoverage: FileReadCoverage = {
    files: [],
    trackedFiles: 0,
    completeFiles: 0,
    allComplete: false,
  };

  constructor(rootPrompt: string) {
    this.required = new Set(extractCompletionObligations(rootPrompt));
    this.explicitFileHints = extractExplicitFileHints(rootPrompt);
  }

  recordToolEvidence(evidence: CompletionToolEvidence): void {
    if (!evidence.succeeded) return;

    if (isBrowserAutomationTool(evidence.toolName)) {
      this.completed.add('browser');
    }

    if (!isExecuteCommand(evidence.toolName) || !evidence.verifiedAction) return;
    const command = commandFromArgs(evidence.args);
    if (isSemanticTestCommand(command)) this.completed.add('test');
    if (isBrowserVerificationCommand(command)) this.completed.add('browser');
  }

  setFileReadCoverage(coverage: FileReadCoverage): void {
    this.fileReadCoverage = coverage;
    const allExplicitFilesComplete = this.explicitFileHints.every((hint) =>
      coverage.files.some((file) => file.complete && coverageMatchesHint(file.path, hint)),
    );
    const targetCoverageComplete = this.explicitFileHints.length > 0
      ? allExplicitFilesComplete
      : coverage.allComplete;
    if (targetCoverageComplete) this.completed.add('file_read_coverage');
    else this.completed.delete('file_read_coverage');
  }

  missing(candidateText = ''): CompletionObligationKind[] {
    const required = new Set(this.required);
    if (claimsCompleteFileReading(candidateText)) required.add('file_read_coverage');
    return [...required].filter((kind) => !this.completed.has(kind));
  }

  inspectFinalAttempt(candidateText = ''): CompletionAuditDecision {
    const missing = this.missing(candidateText);
    if (missing.length === 0) return { status: 'complete', missing };

    if (this.retryCount < MAX_COMPLETION_RETRIES) {
      this.retryCount++;
      return {
        status: 'retry',
        missing,
        message: this.buildRetryMessage(missing),
      };
    }

    return {
      status: 'failed',
      missing,
      message: this.buildFailureMessage(missing),
    };
  }

  private buildRetryMessage(missing: CompletionObligationKind[]): string {
    const details = missing.map((kind) => OBLIGATION_LABELS[kind]).join('；');
    const absentHints = this.explicitFileHints.filter((hint) =>
      !this.fileReadCoverage.files.some((file) => file.complete && coverageMatchesHint(file.path, hint)),
    );
    const partialFiles = this.fileReadCoverage.files
      .filter((file) => !file.complete)
      .map((file) => `${file.path} next_cursor=${file.nextCursor}`);
    const unread = missing.includes('file_read_coverage')
      ? this.fileReadCoverage.files.length === 0
        ? `当前没有任何可信 read_file page receipt。${absentHints.length > 0 ? ` 用户点名但尚未证明：${absentHints.join('；')}` : ''}`
        : `未覆盖：${[...absentHints.map((hint) => `${hint} 尚无完整回执`), ...partialFiles].join('；')}`
      : '';
    return [
      `[MA completion audit] 不能完成任务：仍缺少 ${details}。`,
      unread,
      '请现在直接调用工具补齐验证。测试必须由成功的测试命令证明；浏览器验证必须由真实浏览器自动化证明；完整读取必须由同一文件 hash 上从 1:0 连续到 EOF 的 read_file receipt 证明。',
      'exec cat/sed/head/tail、web_fetch/HTTP 200、只写验证脚本、以及文字自述都不算对应完成证据。',
    ].filter(Boolean).join('\n');
  }

  private buildFailureMessage(missing: CompletionObligationKind[]): string {
    const details = missing.map((kind) => OBLIGATION_LABELS[kind]).join('；');
    return [
      `completion_obligation_failed: 在 ${MAX_COMPLETION_RETRIES} 次补救后仍缺少：${details}。`,
      '任务未完成。请检查对应工具是否可用，并重新运行测试或真实浏览器验证；系统不会把文字自述视为成功。',
    ].join(' ');
  }
}

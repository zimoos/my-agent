export type CompletionObligationKind = 'test' | 'browser';

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

export function extractCompletionObligations(
  rootPrompt: string
): CompletionObligationKind[] {
  const obligations: CompletionObligationKind[] = [];
  if (asksToRunTests(rootPrompt)) obligations.push('test');
  if (asksForBrowserVerification(rootPrompt)) obligations.push('browser');
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
  private readonly completed = new Set<CompletionObligationKind>();
  private retryCount = 0;

  constructor(rootPrompt: string) {
    this.required = new Set(extractCompletionObligations(rootPrompt));
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

  missing(): CompletionObligationKind[] {
    return [...this.required].filter((kind) => !this.completed.has(kind));
  }

  inspectFinalAttempt(): CompletionAuditDecision {
    const missing = this.missing();
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
    return [
      `[MA completion audit] 不能完成任务：仍缺少 ${details}。`,
      '请现在直接调用工具补齐验证。测试必须由成功的测试命令证明；浏览器验证必须由真实浏览器自动化或明确的 Playwright/Puppeteer/browser verification 命令证明。',
      'web_fetch/HTTP 200、只写验证脚本、以及文字自述都不算完成证据。',
    ].join('\n');
  }

  private buildFailureMessage(missing: CompletionObligationKind[]): string {
    const details = missing.map((kind) => OBLIGATION_LABELS[kind]).join('；');
    return [
      `completion_obligation_failed: 在 ${MAX_COMPLETION_RETRIES} 次补救后仍缺少：${details}。`,
      '任务未完成。请检查对应工具是否可用，并重新运行测试或真实浏览器验证；系统不会把文字自述视为成功。',
    ].join(' ');
  }
}

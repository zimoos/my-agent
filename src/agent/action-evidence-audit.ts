import { commandVerification, isNegativeSearch, type CommandVerification } from './command-verification.js';
import type { ToolExecutionResult } from './tool-executor.js';

export interface MissingActionEvidence {
  tool: string;
  toolCallId: string;
  operation: string;
  status: 'missing' | 'failed';
}

interface PendingEvidence {
  missing: MissingActionEvidence;
  verification?: CommandVerification;
  command: string;
  scopeUnknown?: boolean;
}

function scopeHasStopped(receipt: Record<string, unknown> | undefined): boolean {
  const cleanup = receipt?.cleanup;
  return !!cleanup && typeof cleanup === 'object' && !Array.isArray(cleanup)
    && (cleanup as Record<string, unknown>).scope === 'verified';
}

/** Historical attempts remain in the tool transcript. This ledger represents
 * unresolved actions, including a validation scope until a newer equivalent
 * foreground run succeeds. Unknown effects retain the exact-action contract.
 */
export class ActionEvidenceAudit {
  private readonly pending = new Map<string, PendingEvidence>();
  private recoveryCount = 0;

  record(tool: string, toolCallId: string, args: Record<string, unknown>, result: Pick<ToolExecutionResult, 'actionEvidence' | 'structuredContent'>): void {
    const evidence = result.actionEvidence;
    if (!evidence) return;
    const pendingKey = JSON.stringify([tool, evidence.key]);
    const receipt = result.structuredContent;
    const isCommand = evidence.operation === 'execute_command';
    const stopped = isCommand && scopeHasStopped(receipt);
    const parsedVerification = isCommand ? commandVerification(args) : undefined;
    const verification = stopped ? parsedVerification : undefined;
    // A later run is not evidence that an earlier lost process has stopped,
    // even if its command is byte-for-byte identical.
    if (this.pending.get(pendingKey)?.scopeUnknown) return;
    if (evidence.status === 'verified' && verification && !verification.direct) {
      // A successful tail/echo is not the validator's exit receipt, even when
      // the enclosing shell action itself was fully verified.
      this.pending.set(pendingKey, {
        missing: { tool, toolCallId, operation: evidence.operation, status: 'missing' },
        verification,
        command: typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : '',
      });
    } else if (evidence.status === 'verified') {
      this.pending.delete(pendingKey);
      if (verification?.direct && receipt?.ok === true && receipt.exitCode === 0
        && receipt.signal === null && receipt.timedOut === false && receipt.cancelled !== true) {
        for (const [key, pending] of this.pending) {
          if (pending.missing.tool === tool && pending.verification?.key === verification.key) this.pending.delete(key);
        }
      }
    } else if (stopped && evidence.status === 'failed' && receipt?.exitCode === 1
      && receipt.timedOut === false && receipt.cancelled !== true && receipt.signal === null && isNegativeSearch(args)) {
      this.pending.delete(pendingKey);
    } else {
      this.pending.set(pendingKey, {
        missing: { tool, toolCallId, operation: evidence.operation, status: evidence.status },
        // Missing receipts are never semantically reconciled. A failed receipt
        // must account for its entire process scope before another run can help.
        verification: evidence.status === 'failed' ? verification : undefined,
        command: typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : '',
        scopeUnknown: isCommand && !stopped,
      });
    }
  }

  missing(): MissingActionEvidence[] {
    return [...this.pending.values()].map((item) => item.missing);
  }

  recoveryMessage(): string | undefined {
    const recoverable = [...this.pending.values()].filter((item) => item.verification);
    if (!recoverable.length || this.recoveryCount >= 2) return undefined;
    this.recoveryCount++;
    return [
      '[MA action evidence audit] A prior validation attempt is still unresolved. Do not report task completion yet.',
      ...recoverable.slice(0, 8).map((item) => `${item.missing.toolCallId}: ${item.command.slice(0, 800)}`),
      'Before any retry, inspect the actual scripts, package hooks and effects of the previous attempt. A test name does not make an operation safe or idempotent. Process cleanup proves termination, not that external side effects were absent or reversed.',
      'Do not automatically repeat unknown external mutations. If a previous attempt might have changed an external system, inspect that system and its receipts first; report the unresolved effect instead of replaying the command blindly.',
      'Only after establishing that repetition is safe, repair the validation and run the same target, directory, environment and selection arguments directly in the foreground. Keep its raw exit status; do not pipe it into tail, background it, or replace it with unrelated tests.',
      'Historical failures remain visible. A newer equivalent successful run with verified process cleanup can resolve the validation result; it does not erase evidence of earlier effects.',
    ].join('\n');
  }
}

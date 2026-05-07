/**
 * Tracks repeated errors for the same (toolName, args) combination.
 * Prevents infinite retry loops by blocking identical failing calls
 * after a threshold.
 */
export class ErrorTracker {
  private history = new Map<string, number>();

  constructor(private maxSameError = 2) {}

  /**
   * Check whether a call should be blocked due to repeated failures.
   */
  isBlocked(
    toolName: string,
    args: Record<string, any>
  ): { blocked: boolean; message?: string } {
    const key = `${toolName}:${JSON.stringify(args)}`;
    const count = this.history.get(key) || 0;
    if (count >= this.maxSameError) {
      return {
        blocked: true,
        message: `已尝试 ${count} 次均失败，请换个路径或方式。`,
      };
    }
    return { blocked: false };
  }

  /**
   * Record the outcome of a tool call.
   * Errors increment the counter; successes clear it.
   */
  record(toolName: string, args: Record<string, any>, isError: boolean): void {
    const key = `${toolName}:${JSON.stringify(args)}`;
    if (isError) {
      this.history.set(key, (this.history.get(key) || 0) + 1);
    } else {
      this.history.delete(key);
    }
  }

  /** Exposed for testing / debugging. */
  getHistory(): ReadonlyMap<string, number> {
    return this.history;
  }
}

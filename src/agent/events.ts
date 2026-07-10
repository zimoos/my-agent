export interface DiffArtifact {
  type: 'diff';
  filePath: string;
  addedLines: number;
  removedLines: number;
  diffText: string;
  truncated: boolean;
}

export interface WorkspaceDiffFile extends DiffArtifact {
  status: 'added' | 'modified' | 'deleted';
}

export interface WorkspaceDiffArtifact {
  type: 'workspace-diff';
  files: WorkspaceDiffFile[];
  summary: string;
  truncated: boolean;
}

export type AgentEvent =
  | { type: 'task:start'; taskId: string; prompt: string }
  | { type: 'task:done'; taskId: string; next?: string }
  | { type: 'task:failed'; taskId: string; error: string }
  | { type: 'task:aborted'; taskId: string }
  | { type: 'tool:call'; name: string; args: Record<string, any> }
  | {
      type: 'tool:result';
      ok: boolean;
      content: string;
      artifact?: DiffArtifact;
      structuredContent?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    }
  | { type: 'workspace:diff'; artifact: WorkspaceDiffArtifact }
  | { type: 'token'; text: string }
  | { type: 'text'; content: string }
  | { type: 'progress'; message: string }
  | { type: 'context:usage'; used: number; total: number; compactThreshold: number; source: string }
  | { type: 'thinking:start' }
  | { type: 'thinking:end'; durationMs: number }
  | { type: 'tool:confirm'; requestId: string; cmd: string; reason: string }
  | { type: 'compact:done'; freed: number }
  | { type: 'provider:attempt'; attempt: number; maxAttempts: number; timeoutMs: number; stream: boolean }
  | { type: 'provider:retry'; attempt: number; nextAttempt: number; retriesLeft: number; maxRetries: number; delayMs: number; error: string; stream: boolean }
  | { type: 'provider:progress'; provider: string; phase?: string; message: string; progress?: number; total?: number }
  | { type: 'ask_user'; question: string }
  | { type: 'plan'; content: string }
  | { type: 'aborted' }
  | { type: 'warning'; message: string };

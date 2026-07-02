import type { ChildProcess } from 'node:child_process';
import type { TaskStack } from '../task-stack.js';
import type { AgentEvent } from '../agent/events.js';
import type { ActiveContextItem, SessionPoolEntry } from '../agent/context-manager.js';

export type { AgentEvent } from '../agent/events.js';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

export interface McpConnection {
  name: string;
  process: ChildProcess;
  tools: McpTool[];
  call(
    toolName: string,
    args: Record<string, any>,
    signal?: AbortSignal
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface ModelConfig {
  provider?: string;
  baseURL: string;
  model: string;
  apiKey: string;
  secretRef?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  repeatPenalty?: number;
  contextWindow?: number;
  maxTokens?: number;
  maxOutputChars?: number;
  repeatWindowChars?: number;
  repeatWindowRepeats?: number;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRetries?: number;
  contextWindowSource?: 'config' | 'lmstudio' | 'registry' | 'default';
  extraParams?: Record<string, unknown>;
}

export interface CredentialConfig {
  provider: string;
  baseURL: string;
  secretRef?: string;
  apiKeyMode?: 'none' | 'secret';
  authPolicy?: 'session' | 'always';
  modelsCache?: {
    fetchedAt?: string;
    models: string[];
  };
}

export interface ProfileConfig {
  credentialId: string;
  model: string;
  label?: string;
}

export interface DangerConfig {
  mode?: 'confirm' | 'deny' | 'off';
  allow?: string[];
}

export interface AgentConfig {
  model: ModelConfig;
  mcpServers: Record<string, McpServerConfig>;
  defaultProfile?: string;
  credentials?: Record<string, CredentialConfig>;
  profiles?: Record<string, ProfileConfig>;
  systemPrompt?: string;
  maxLoops?: number;
  danger?: DangerConfig;
}

export interface ArchivedMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export type ChatContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

export interface Agent {
  chat(
    userMessage: ChatContent,
    signal?: AbortSignal
  ): AsyncGenerator<AgentEvent, void, unknown>;
  reset(): void;
  getTaskStack(): TaskStack;
  getArchive(taskId: string): ArchivedMessage[] | null;
  abortAll(): number;
  revertLastTurnContextOnly(): number;
  respondConfirm(requestId: string, approved: boolean): void;
  getContextUsage(): { used: number; total: number; compactThreshold: number; source: string };
  inspectContext(): string;
  searchContext(query: string): SessionPoolEntry[];
  recallContext(entryId: string): string;
  pinContext(text: string): string;
  activeContext(): ActiveContextItem[];
  poolContext(limit?: number): SessionPoolEntry[];
  dropContext(i: number): string;
  clearActiveContext(): string;
}

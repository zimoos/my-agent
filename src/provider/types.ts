import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { ModelConfig } from '../mcp/types.js';

export interface ParsedAssistantTurn {
  content: string;
  toolCalls: ChatCompletionMessageToolCall[] | null;
  reasoningContent?: string;
  contextPatch?: string;
}

export interface RequestBuildInput {
  model: ModelConfig;
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
  stream: boolean;
}

export interface ProviderCodec {
  name: string;
  encodeMessages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[];
  shouldStoreReasoningContent(turn: ParsedAssistantTurn): boolean;
  buildRequestExtras?(input: RequestBuildInput): Record<string, unknown>;
}

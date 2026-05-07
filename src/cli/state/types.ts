export interface UiImage {
  path: string;
  size: number;
}

export interface BannerData {
  model: string;
  baseURL: string;
  mcp: Array<{ name: string; toolCount: number }>;
}

export type Message =
  | { kind: 'user'; id: string; text: string; images?: UiImage[] }
  | { kind: 'assistant'; id: string; markdown: string; elapsedMs: number }
  | { kind: 'tool'; id: string; name: string; ok: boolean; preview: string; diff?: DiffData }
  | { kind: 'system'; id: string; text: string }
  | { kind: 'separator'; id: string; elapsed: string }
  | { kind: 'banner'; id: string; data: BannerData };

export interface DiffData {
  /** 文件路径 */
  filePath: string;
  /** 新增行数 */
  addedLines: number;
  /** 删除行数 */
  removedLines: number;
  /** 完整 diff 文本（带 ANSI 颜色） */
  diffText: string;
  /** 是否被截断 */
  truncated: boolean;
}

export interface ThinkingState {
  active: boolean;
  event: string;
  toolName: string | null;
  startedAt: number;
  isThinking?: boolean;
  thoughtDurationMs?: number | null;
}

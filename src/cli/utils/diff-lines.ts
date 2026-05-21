import parseDiff from 'parse-diff';
import cliTruncate from 'cli-truncate';
import stringWidth from 'string-width';

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'file' | 'meta';

export interface RenderDiffLine {
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  sign: string;
  content: string;
}

export const DEFAULT_DIFF_LINE_COLUMNS = 110;

export function truncateDiffContent(content: string, columns = DEFAULT_DIFF_LINE_COLUMNS): string {
  if (columns <= 0) return '';
  return cliTruncate(content, columns, {
    position: 'end',
    truncationCharacter: '…',
  });
}

export function diffDisplayWidth(content: string): number {
  return stringWidth(content);
}

export function buildDiffLines(diffText: string): RenderDiffLine[] {
  const parsed = parseDiff(diffText);
  const files = parsed.filter((file) => file.chunks.length > 0);
  if (files.length > 0) {
    return files.flatMap((file) =>
      file.chunks.flatMap((chunk) => [
        {
          kind: 'hunk' as const,
          sign: '@',
          content: chunk.content,
        },
        ...chunk.changes.map((change) => {
          if (change.type === 'add') {
            return {
              kind: 'add' as const,
              newLine: change.ln,
              sign: '+',
              content: stripDiffPrefix(change.content),
            };
          }
          if (change.type === 'del') {
            return {
              kind: 'del' as const,
              oldLine: change.ln,
              sign: '-',
              content: stripDiffPrefix(change.content),
            };
          }
          return {
            kind: 'context' as const,
            oldLine: change.ln1,
            newLine: change.ln2,
            sign: ' ',
            content: stripDiffPrefix(change.content),
          };
        }),
      ])
    );
  }

  return diffText
    .split('\n')
    .filter((line) => line.length > 0)
    .map(parseFallbackLine);
}

function parseFallbackLine(raw: string): RenderDiffLine {
  const line = stripAnsi(raw);
  if (line.startsWith('--- ') || line.startsWith('+++ ')) {
    return { kind: 'file', sign: ' ', content: line };
  }
  if (line.startsWith('@@')) {
    return { kind: 'hunk', sign: '@', content: line };
  }
  if (line.startsWith('...')) {
    return { kind: 'meta', sign: '·', content: line };
  }
  if (/^\+\d+\s+-\d+/.test(line.trim())) {
    return { kind: 'meta', sign: '·', content: line.trim() };
  }

  const numbered = line.match(/^([+\- ])\s*(\d+):\s?(.*)$/);
  if (numbered) {
    const [, sign, lineNoRaw, content] = numbered;
    const lineNo = Number.parseInt(lineNoRaw, 10);
    if (sign === '+') {
      return { kind: 'add', newLine: lineNo, sign, content };
    }
    if (sign === '-') {
      return { kind: 'del', oldLine: lineNo, sign, content };
    }
    return {
      kind: 'context',
      oldLine: lineNo,
      newLine: lineNo,
      sign: ' ',
      content,
    };
  }

  if (line.startsWith('+')) {
    return { kind: 'add', sign: '+', content: line.slice(1) };
  }
  if (line.startsWith('-')) {
    return { kind: 'del', sign: '-', content: line.slice(1) };
  }
  if (line.startsWith('\\')) {
    return { kind: 'meta', sign: '\\', content: line };
  }
  return { kind: 'context', sign: ' ', content: line.trimStart() };
}

function stripDiffPrefix(content: string): string {
  return content.length > 0 ? content.slice(1) : content;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Diff 生成工具
 * 
 * 使用 jsdiff 生成 unified diff，添加 ANSI 颜色编码和语法高亮。
 */

// @ts-ignore: jsdiff 没有类型声明
import { createTwoFilesPatch, diffLines } from 'jsdiff';
// @ts-ignore: cli-highlight 类型问题
import { highlight } from 'cli-highlight';
import * as pico from 'picocolors';

export interface DiffResult {
  /** 统一 diff 格式文本（带 ANSI 颜色） */
  diffText: string;
  /** 原始 diff（无颜色） */
  rawDiff: string;
  /** 新增行数 */
  addedLines: number;
  /** 删除行数 */
  removedLines: number;
  /** 总行数变化 */
  totalLines: number;
  /** 是否被截断 */
  truncated: boolean;
}

/**
 * 生成带颜色的 unified diff
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
  options?: {
    /** 上下文行数，默认 3 */
    contextLines?: number;
    /** 是否启用语法高亮，默认 true */
    syntaxHighlight?: boolean;
    /** 最大输出行数，超过则截断，默认 500 */
    maxLines?: number;
  }
): DiffResult {
  const ctx = options?.contextLines ?? 3;
  const highlightCode = options?.syntaxHighlight ?? true;
  const maxLines = options?.maxLines ?? 500;

  // 判断文件类型用于语法高亮
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const lang = getLanguageFromExt(ext);

  // 生成 unified diff
  let rawDiff: string;
  try {
    rawDiff = createTwoFilesPatch(
      filePath,
      filePath,
      oldContent,
      newContent,
      'old',
      'new',
      { context: ctx }
    );
  } catch {
    // 如果 jsdiff 失败，返回空 diff
    return {
      diffText: '',
      rawDiff: '',
      addedLines: 0,
      removedLines: 0,
      totalLines: 0,
      truncated: false,
    };
  }

  if (!rawDiff || rawDiff === oldContent) {
    return {
      diffText: '',
      rawDiff: '',
      addedLines: 0,
      removedLines: 0,
      totalLines: 0,
      truncated: false,
    };
  }

  // 计算统计信息
  const lines = rawDiff.split('\n');
  let addedLines = 0;
  let removedLines = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) addedLines++;
    if (line.startsWith('-') && !line.startsWith('---')) removedLines++;
  }

  // 智能截断过长的 diff
  let truncated = false;
  if (lines.length > maxLines) {
    const head = lines.slice(0, 15).join('\n');
    const tail = lines.slice(-15).join('\n');
    const count = lines.length - 15 - 15;
    rawDiff = `${head}\n${pico.yellow('  … … …')} (${count} lines collapsed) ${pico.yellow('… … …')}\n${tail}`;
    truncated = true;
  }

  // 添加 ANSI 颜色
  let coloredDiff = applyDiffColors(rawDiff, highlightCode, lang);

  // 添加头部信息
  const headerLines = [
    pico.blue('┌─') + pico.blue('─'.repeat(Math.max(0, 60))),
    pico.blue('│') + pico.dim(' 📝 ') + pico.cyan(pico.bold(filePath)),
    pico.blue('│') + pico.dim(`   `) + pico.green(pico.bold(`+${addedLines}`)) + pico.dim(' / ') + pico.red(pico.bold(`-${removedLines}`)) + (truncated ? pico.yellow(` (truncated)`) : ''),
    pico.blue('└─') + pico.blue('─'.repeat(Math.max(0, 60))),
  ].join('\n');

  return {
    diffText: `${headerLines}\n${coloredDiff}`,
    rawDiff: rawDiff,
    addedLines,
    removedLines,
    totalLines: addedLines + removedLines,
    truncated,
  };
}

/**
 * 生成文件变更摘要（不显示完整 diff）
 */
export function generateDiffSummary(
  oldContent: string,
  newContent: string,
  filePath: string
): string {
  const result = generateDiff(oldContent, newContent, filePath, {
    contextLines: 0,
    syntaxHighlight: false,
    maxLines: 500,
  });

  if (!result.rawDiff) {
    return pico.dim(`(no changes in ${filePath})`);
  }

  const parts = [pico.cyan(pico.bold(filePath))];
  if (result.addedLines > 0) parts.push(pico.green(`+${result.addedLines}`));
  if (result.removedLines > 0) parts.push(pico.red(`-${result.removedLines}`));
  return parts.join(' ');
}

/**
 * 应用 diff 颜色
 */
function applyDiffColors(diff: string, highlightCode: boolean, lang: string): string {
  const lines = diff.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      // 文件头
      result.push(pico.cyan(line));
    } else if (line.startsWith('@@')) {
      // hunk header
      result.push(pico.yellow(line));
    } else if (line.startsWith('+')) {
      // 新增行
      if (highlightCode) {
        result.push(pico.green(highlight(line.slice(1), { language: lang, ignoreIllegals: true })));
      } else {
        result.push(pico.green(line));
      }
    } else if (line.startsWith('-')) {
      // 删除行
      if (highlightCode) {
        result.push(pico.red(highlight(line.slice(1), { language: lang, ignoreIllegals: true })));
      } else {
        result.push(pico.red(line));
      }
    } else if (line.startsWith('\\')) {
      // no newline at end
      result.push(pico.dim(line));
    } else {
      // 上下文行
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * 根据文件扩展名获取语言名
 */
function getLanguageFromExt(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    dockerfile: 'dockerfile',
    toml: 'toml',
    ini: 'ini',
    env: 'bash',
    graphql: 'graphql',
    proto: 'protobuf',
    vim: 'vim',
    lua: 'lua',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    r: 'r',
    dart: 'dart',
  };
  return map[ext] || '';
}

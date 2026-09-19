import { resolve } from 'node:path';

type Token = { word: string; statusExpansion?: boolean } | { operator: string };

export interface CommandVerification {
  /** Includes cwd, runner, selection arguments, environment, and output destinations. */
  key: string;
  direct: boolean;
}

/** Parse only a small, literal shell subset. Never execute, expand, or rewrite it.
 * Unknown shell syntax deliberately keeps the original exact-action obligation.
 */
function tokens(command: string): Token[] | undefined {
  const result: Token[] = [];
  let word = '';
  let started = false;
  let descriptorEligible = true;
  let statusExpansion = false;
  let quote = '';
  const flush = () => {
    if (started) result.push({ word, ...(statusExpansion ? { statusExpansion } : {}) });
    word = '';
    started = false;
    descriptorEligible = true;
    statusExpansion = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = '';
      else word += ch;
      continue;
    }
    // Expansions can change arguments or invoke other programs, including inside
    // double quotes. A quoted literal dollar in single quotes is ordinary data.
    if (ch === '$' && command.startsWith('${PIPESTATUS[0]}', i)) {
      // The retained bash test recipe prints this status after its pipeline.
      // Permit that read only in a later echo/printf observer, never as input to
      // the validator or as proof of the validator's exit status.
      word += '${PIPESTATUS[0]}';
      i += '${PIPESTATUS[0]}'.length - 1;
      statusExpansion = true;
      descriptorEligible = false;
      started = true;
      continue;
    }
    if (ch === '$' || ch === '`') return undefined;
    if (ch === '\\') {
      const next = command[++i];
      if (next === undefined || next === '\n' || next === '\r') return undefined;
      if (quote === '"' && !['"', '\\'].includes(next)) word += '\\';
      word += next;
      started = true;
      descriptorEligible = false;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = '';
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      descriptorEligible = false;
      continue;
    }
    if (/[(){}~*?\[\]]/.test(ch)) return undefined;
    if (/\s/.test(ch)) {
      flush();
      if (ch === '\n' || ch === '\r') return undefined;
      continue;
    }
    if (';&|<>'.includes(ch)) {
      // Treat descriptor duplication as one token, not a background operator.
      if (ch === '>' && descriptorEligible && /^[12]?$/.test(word) && command.slice(i, i + 3) === '>&1') {
        const descriptor = word || '1';
        word = '';
        started = false;
        result.push({ operator: `${descriptor}>&1` });
        i += 2;
        continue;
      }
      if (ch === '>' && descriptorEligible && /^[12]?$/.test(word)) {
        const descriptor = word || '1';
        word = '';
        started = false;
        const append = command[i + 1] === '>';
        result.push({ operator: `${descriptor}${append ? '>>' : '>'}` });
        if (append) i++;
        continue;
      }
      flush();
      const pair = command.slice(i, i + 2);
      if (['&&', '||'].includes(pair)) {
        result.push({ operator: pair });
        i++;
      } else result.push({ operator: ch });
      continue;
    }
    if (ch === '#' && !started) return undefined;
    word += ch;
    started = true;
  }
  if (quote) return undefined;
  flush();
  return result;
}

function literalCommand(parts: Token[]): { words: string[]; outputs: string[]; statusExpansion: boolean } | undefined {
  const words: string[] = [];
  const outputs: string[] = [];
  let statusExpansion = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if ('word' in part) {
      words.push(part.word);
      statusExpansion ||= part.statusExpansion === true;
    }
    else if (part.operator === '2>&1' || part.operator === '1>&1') continue;
    else if (/^[12]>>?$/.test(part.operator)) {
      const next = parts[++i];
      if (!next || !('word' in next) || next.statusExpansion) return undefined;
      outputs.push(`${part.operator}${next.word}`);
    } else return undefined; // Includes stdin, heredocs, and descriptor tricks.
  }
  return words.length ? { words, outputs, statusExpansion } : undefined;
}

function observation(words: string[]): boolean {
  if (words[0] === 'echo' || words[0] === 'printf') return true;
  if (words[0] === 'sleep') return words.length === 2 && /^\d+(?:\.\d+)?$/.test(words[1]);
  return ['head', 'tail', 'grep', 'rg'].includes(words[0])
    && !words.some((word) => /^--(?:pre|hostname-bin)(?:=|$)/.test(word));
}

function validationWords(words: string[]): string[] | undefined {
  const normalized = [...words];
  const prefix: string[] = [];
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(normalized[0] ?? '')) prefix.push(normalized.shift()!);
  if (normalized[0] === 'nohup') normalized.shift();
  // Match command position and invocation, never a word such as "test" inside
  // code passed to node -e or an external script with a suggestive filename.
  const [runner, action, target] = normalized;
  const packageTest = ['npm', 'pnpm', 'yarn', 'bun'].includes(runner)
    && (/^test(?:$|:)/.test(action ?? '') || (action === 'run' && /^test(?:$|:)/.test(target ?? '')));
  const builtInTest = runner === 'node' && action === '--test';
  const directRunner = ['pytest', 'vitest', 'jest', 'mocha', 'ava', 'tap', 'ctest', 'rspec'].includes(runner);
  const languageTest = ['cargo', 'go', 'dotnet', 'mvn', 'gradle', 'playwright'].includes(runner) && action === 'test';
  const buildTest = ['make', 'just'].includes(runner) && ['test', 'check'].includes(action);
  const pythonTest = /^python\d*$/.test(runner) && action === '-m' && target === 'pytest';
  if (!packageTest && !builtInTest && !directRunner && !languageTest && !buildTest && !pythonTest) return undefined;
  if (normalized[0] === 'npm' && normalized[1] === 'test') normalized.splice(1, 1, 'run', 'test');
  if (normalized[0] === 'node' && normalized.includes('--test')) {
    // Reporting and the runner deadline do not select tests. All other flags,
    // file arguments, name filters, skip filters, and environment remain exact.
    for (let i = 1; i < normalized.length; i++) {
      if (/^--test-reporter=(?:spec|tap|dot|junit|lcov)$/.test(normalized[i]) || /^--test-timeout=\d+$/.test(normalized[i])) normalized.splice(i--, 1);
      else if ((normalized[i] === '--test-reporter' && /^(?:spec|tap|dot|junit|lcov)$/.test(normalized[i + 1] ?? ''))
        || (normalized[i] === '--test-timeout' && /^\d+$/.test(normalized[i + 1] ?? ''))) {
        normalized.splice(i--, 2);
      }
    }
  }
  return [...prefix, ...normalized];
}

export function isLiteralForegroundCommand(command: string): boolean {
  const parsed = tokens(command);
  if (!parsed?.length) return false;
  const literal = literalCommand(parsed);
  return !!literal && !literal.statusExpansion;
}

export function commandVerification(args: Record<string, unknown>): CommandVerification | undefined {
  const command = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : '';
  const parsed = tokens(command);
  if (!parsed?.length) return undefined;
  let cwd = resolve(typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd());
  // Only a leading, successful cd is an equivalent way to specify cwd.
  if ('word' in parsed[0] && parsed[0].word === 'cd') {
    const separator = parsed.findIndex((part) => 'operator' in part && part.operator === '&&');
    const directory = literalCommand(parsed.slice(0, separator));
    if (separator < 0 || !directory || directory.statusExpansion || directory.outputs.length || directory.words.length !== 2
      || !directory.words[1] || directory.words[1].startsWith('-')) return undefined;
    cwd = resolve(cwd, directory.words[1]);
    parsed.splice(0, separator + 1);
  }
  const separator = parsed.findIndex((part) => 'operator' in part && ['|', '&', ';', '&&', '||'].includes(part.operator));
  const first = literalCommand(separator < 0 ? parsed : parsed.slice(0, separator));
  if (!first || first.statusExpansion) return undefined;
  const validation = validationWords(first.words);
  if (!validation) return undefined;
  if (separator >= 0) {
    const rest = parsed.slice(separator);
    while (rest.length) {
      const delimiter = rest.shift()!;
      if (!('operator' in delimiter) || !['|', '&', ';', '&&'].includes(delimiter.operator)) return undefined;
      if (!rest.length) {
        if (delimiter.operator !== '&') return undefined;
        break;
      }
      const next = rest.findIndex((part) => 'operator' in part && ['|', '&', ';', '&&', '||'].includes(part.operator));
      const clause = literalCommand(rest.splice(0, next < 0 ? rest.length : next));
      if (!clause || clause.outputs.length || !observation(clause.words)
        || (clause.statusExpansion && !['echo', 'printf'].includes(clause.words[0]))) return undefined;
    }
  }
  return {
    key: JSON.stringify({ cwd, command: validation, outputs: first.outputs }),
    direct: separator < 0 && !first.words.includes('nohup'),
  };
}

/** grep/rg exit 1 is a completed negative observation, not a failed action.
 * Only accept literal, direct searches; rg subprocess hooks stay opaque.
 */
export function isNegativeSearch(args: Record<string, unknown>): boolean {
  const command = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : '';
  const parsed = tokens(command);
  const literal = parsed && literalCommand(parsed);
  return !!literal && !literal.statusExpansion && !literal.outputs.length
    && ['grep', 'rg'].includes(literal.words[0]) && observation(literal.words);
}

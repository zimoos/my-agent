#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import pc from 'picocolors';
import figures from 'figures';
import { bootstrap, shutdown } from '../index.js';
import { globalConfigPath } from '../config.js';
import { deleteSecret, maskSecret, readSecret, repairSecretAccess } from '../secrets/keychain.js';
import { createSessionStore } from '../session/store.js';
import { runInit } from '../init.js';
import type { BootstrapResult } from '../index.js';
import type { Agent, McpConnection } from '../mcp/types.js';
import { App } from './App.js';
import { VERSION } from './version.js';
import { assertInteractiveInput, TerminalInputError } from './terminal.js';
import { runContextWatch } from './watch.js';
import { createContextManager } from '../agent/context-manager.js';

let activeConnections: McpConnection[] = [];
let activeAgent: Agent | undefined;

/**
 * A non-interactive run can be killed by an external E2E harness while an
 * Agora MCP child owns the local model. Node's default SIGTERM behaviour skips
 * runPrompt's finally block, so explicitly close provider-owned children first.
 */
function installRunSignalCleanup(
  connections: McpConnection[],
  agent: Agent,
): () => void {
  let shuttingDown = false;

  const stop = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        await shutdown(connections, agent);
      } finally {
        activeConnections = [];
        activeAgent = undefined;
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
    })();
  };

  const onSigint = (): void => stop('SIGINT');
  const onSigterm = (): void => stop('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  return () => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
}

function parseResume(raw: string | boolean | undefined): string | true | undefined {
  if (raw === undefined) return undefined;
  if (raw === true || raw === '') return true;
  if (typeof raw === 'string') return raw;
  return true;
}

interface RunChatOptions {
  debug: boolean;
  resume?: string | true;
}

function readGlobalConfigJson(): Record<string, any> {
  const file = globalConfigPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${(err as Error).message}`);
  }
}

function writeGlobalConfigJson(config: Record<string, any>): void {
  const file = globalConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

async function runChat(configPath: string | undefined, runOpts: RunChatOptions): Promise<void> {
  assertInteractiveInput();

  const { debug } = runOpts;
  let resume = runOpts.resume;
  if (debug) {
    const logDir = path.join(os.homedir(), '.my-agent');
    fs.mkdirSync(logDir, { recursive: true });
    console.log(pc.yellow(`${figures.warning} debug mode — logging to ~/.my-agent/debug.log`));
  }

  for (;;) {
    let boot: BootstrapResult;
    try {
      boot = await bootstrap(configPath, { resume });
    } catch (err) {
      console.error(pc.red(`[error] ${(err as Error).message}`));
      process.exit(1);
    }

    const { config, createdDefault, connections, agent, sessionId, resumed } = boot;
    const sessionStore = createSessionStore();
    let nextSessionId: string | null = null;
    activeConnections = connections;
    activeAgent = agent;

    if (createdDefault) {
      console.log(pc.yellow(`Created ~/.my-agent/config.json — edit model settings there.`));
    }
    if (resumed) {
      console.log(pc.dim(`resumed session ${sessionId}`));
    } else {
      console.log(pc.dim(`session ${sessionId}`));
    }

    const { waitUntilExit } = render(
      <App
        config={config}
        connections={connections}
        agent={agent}
        sessionStore={sessionStore}
        currentSessionId={sessionId}
        debug={debug}
        onSwitchSession={(id) => {
          nextSessionId = id;
        }}
        onRestartSession={(id) => {
          nextSessionId = id;
        }}
      />,
    );

    const onSigint = (): void => {
      void (async () => {
        await shutdown(connections, agent);
        process.exit(0);
      })();
    };
    process.on('SIGINT', onSigint);

    try {
      await waitUntilExit();
    } finally {
      process.off('SIGINT', onSigint);
      await shutdown(connections, agent);
      activeConnections = [];
      activeAgent = undefined;
    }

    if (!nextSessionId) break;
    resume = nextSessionId;
  }
}

async function runPrompt(configPath: string | undefined, prompt: string): Promise<void> {
  let boot: BootstrapResult;
  try {
    boot = await bootstrap(configPath);
  } catch (err) {
    console.error(pc.red(`[error] ${(err as Error).message}`));
    process.exit(1);
  }

  const { connections, agent } = boot;
  activeConnections = connections;
  activeAgent = agent;
  let finalText = '';
  const removeSignalCleanup = installRunSignalCleanup(connections, agent);

  try {
    for await (const event of agent.chat(prompt)) {
      if (event.type === 'token') {
        process.stdout.write(event.text);
        finalText += event.text;
      } else if (event.type === 'text') {
        process.stdout.write(event.content);
        finalText += event.content;
      } else if (event.type === 'ask_user') {
        const text = event.question;
        process.stdout.write(text);
        finalText += text;
      } else if (event.type === 'plan') {
        process.stdout.write(event.content);
        finalText += event.content;
      } else if (event.type === 'warning') {
        process.stderr.write(`[warning] ${event.message}\n`);
      } else if (event.type === 'progress') {
        process.stderr.write(`[progress] ${event.message}\n`);
      } else if (event.type === 'task:failed') {
        process.stderr.write(`[task:failed] ${event.error}\n`);
      } else if (event.type === 'tool:call') {
        process.stderr.write(`[tool] ${event.name}\n`);
      }
    }

    if (!finalText.endsWith('\n')) process.stdout.write('\n');
    process.stdout.write(`\n===FINAL_ANSWER===\n${finalText.trim()}\n===END===\n`);
  } finally {
    removeSignalCleanup();
    await shutdown(connections, agent);
    activeConnections = [];
    activeAgent = undefined;
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program.name('my-agent').description('CLI agent with local model + MCP').version(VERSION);

  program
    .command('chat')
    .description('Start interactive chat session')
    .option('-c, --config <path>', 'path to config file')
    .option('--resume [id]', 'resume a saved session (empty = latest)')
    .action(async (opts: { config?: string; resume?: string | boolean }) => {
      const resume = parseResume(opts.resume);
      await runChat(opts.config, { debug: false, resume });
    });

  program
    .command('dev')
    .description('Start chat with debug logging to ~/.my-agent/debug.log')
    .option('-c, --config <path>', 'path to config file')
    .option('--resume [id]', 'resume a saved session (empty = latest)')
    .action(async (opts: { config?: string; resume?: string | boolean }) => {
      const resume = parseResume(opts.resume);
      await runChat(opts.config, { debug: true, resume });
    });

  program
    .command('run')
    .description('Run a single prompt non-interactively')
    .requiredOption('--prompt <prompt>', 'prompt to run')
    .option('-c, --config <path>', 'path to config file')
    .action(async (opts: { prompt: string; config?: string }) => {
      await runPrompt(opts.config, opts.prompt);
    });

  program
    .command('sessions')
    .description('List saved sessions')
    .option('--prune', 'delete old sessions, keeping the most recent 20')
    .action((opts: { prune?: boolean }) => {
      const store = createSessionStore();
      if (opts.prune) {
        const removed = store.prune(20);
        console.log(pc.green(`${figures.tick} pruned ${removed} session(s)`));
        return;
      }
      const list = store.list(10);
      if (list.length === 0) {
        console.log(pc.dim('no sessions'));
        return;
      }
      for (const m of list) {
        const when = new Date(m.createdAt).toISOString().replace('T', ' ').slice(0, 19);
        console.log(
          `${pc.cyan(m.id)}  ${pc.dim(when)}  ${pc.dim(m.model)}  ${pc.dim(`${m.messageCount} msg`)}  ${m.cwd}`
        );
      }
    });

  program
    .command('watch')
    .description('Start local context watch UI for a session')
    .argument('[sessionId]', 'session id; can also be supplied by ?sid= in the browser')
    .option('-p, --port <port>', 'HTTP port', '8787')
    .option('--host <host>', 'HTTP host', '127.0.0.1')
    .action(async (sessionId: string | undefined, opts: { port?: string; host?: string }) => {
      const port = Number.parseInt(opts.port ?? '8787', 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        console.error(pc.red(`invalid port: ${opts.port}`));
        process.exit(1);
      }
      const store = createSessionStore();
      await runContextWatch({
        sessionDir: store.getSessionDir(),
        port,
        host: opts.host,
        sid: sessionId,
      });
    });

  const ctx = program
    .command('ctx')
    .description('Inspect MA context index (debug/compat)');

  ctx
    .command('list')
    .description('List context sidecar items')
    .option('--session <id>', 'session id')
    .action((opts: { session?: string }) => {
      const sid = opts.session;
      if (!sid) {
        console.error(pc.red('--session is required when running outside agent'));
        process.exit(1);
      }
      const store = createSessionStore();
      const cm = createContextManager(sid, store.getSessionDir());
      const items = cm.active();
      if (items.length === 0) {
        console.log(pc.dim('empty'));
        return;
      }
      for (const item of items) {
        const summary = (item.content || '').replace(/\s+/g, ' ').slice(0, 100);
        console.log(`${pc.cyan(`i=${item.i}`)} ${pc.dim(item.role)} ${pc.dim(item.mode)} ${summary}`);
      }
    });

  ctx
    .command('rm')
    .description('Move a context sidecar item to pool')
    .argument('<i>', 'context index')
    .option('--session <id>', 'session id')
    .action((i: string, opts: { session?: string }) => {
      const sid = opts.session;
      if (!sid) {
        console.error(pc.red('--session is required when running outside agent'));
        process.exit(1);
      }
      const store = createSessionStore();
      const cm = createContextManager(sid, store.getSessionDir());
      const result = cm.drop(Number.parseInt(i, 10));
      console.log(result);
    });

  ctx
    .command('search')
    .description('Search session pool')
    .argument('<query>', 'search query')
    .option('--session <id>', 'session id')
    .action((query: string, opts: { session?: string }) => {
      const sid = opts.session;
      if (!sid) {
        console.error(pc.red('--session is required when running outside agent'));
        process.exit(1);
      }
      const store = createSessionStore();
      const cm = createContextManager(sid, store.getSessionDir());
      const results = cm.search(query);
      if (results.length === 0) {
        console.log(pc.dim('no results'));
        return;
      }
      for (const entry of results) {
        const snippet = (entry.summary || entry.text).replace(/\s+/g, ' ').slice(0, 120);
        console.log(`${pc.cyan(entry.id)} ${pc.dim(`i=${entry.i}`)} ${snippet}`);
      }
    });

  ctx
    .command('recall')
    .description('Recall a pool entry to the context sidecar')
    .argument('<id>', 'pool entry id or index')
    .option('--session <id>', 'session id')
    .action((id: string, opts: { session?: string }) => {
      const sid = opts.session;
      if (!sid) {
        console.error(pc.red('--session is required when running outside agent'));
        process.exit(1);
      }
      const store = createSessionStore();
      const cm = createContextManager(sid, store.getSessionDir());
      const result = cm.recall(id);
      console.log(result);
    });

  ctx
    .command('pin')
    .description('Pin text into the context sidecar')
    .argument('<text>', 'text to pin')
    .option('--session <id>', 'session id')
    .action((text: string, opts: { session?: string }) => {
      const sid = opts.session;
      if (!sid) {
        console.error(pc.red('--session is required when running outside agent'));
        process.exit(1);
      }
      const store = createSessionStore();
      const cm = createContextManager(sid, store.getSessionDir());
      const result = cm.pin(text);
      console.log(result);
    });

  ctx
    .command('say')
    .description('Output text as a message (for parallel tool calls)')
    .argument('<text>', 'text to output')
    .option('--session <id>', 'session id')
    .action((text: string, _opts: { session?: string }) => {
      console.log(text);
    });

  ctx
    .command('clear')
    .description('Clear context sidecar items')
    .option('--session <id>', 'session id')
    .action((opts: { session?: string }) => {
      const sid = opts.session;
      if (!sid) {
        console.error(pc.red('--session is required when running outside agent'));
        process.exit(1);
      }
      const store = createSessionStore();
      const cm = createContextManager(sid, store.getSessionDir());
      const result = cm.clearActive();
      console.log(result);
    });

  program
    .command('profiles')
    .description('List configured model profiles')
    .action(() => {
      const cfg = readGlobalConfigJson();
      const profiles = cfg.profiles && typeof cfg.profiles === 'object' ? cfg.profiles : {};
      const credentials = cfg.credentials && typeof cfg.credentials === 'object' ? cfg.credentials : {};
      const ids = Object.keys(profiles);
      if (ids.length === 0) {
        console.log(pc.dim('no profiles'));
        return;
      }
      for (const id of ids) {
        const p = profiles[id] ?? {};
        const c = credentials[p.credentialId] ?? {};
        const marker = cfg.defaultProfile === id ? '*' : ' ';
        const provider = c.provider ?? '?';
        let base = '?';
        try {
          base = typeof c.baseURL === 'string' ? new URL(c.baseURL).host : '?';
        } catch {
          base = c.baseURL ?? '?';
        }
        console.log(`${marker} ${pc.cyan(id)}  ${pc.dim(provider)}  ${pc.dim(base)}`);
      }
    });

  program
    .command('profile')
    .description('Manage the default model profile')
    .command('use')
    .argument('<id>', 'profile id')
    .action((id: string) => {
      const cfg = readGlobalConfigJson();
      if (!cfg.profiles?.[id]) {
        console.error(pc.red(`profile not found: ${id}`));
        process.exit(1);
      }
      cfg.defaultProfile = id;
      writeGlobalConfigJson(cfg);
      console.log(pc.green(`${figures.tick} default profile: ${id}`));
    });

  const secrets = program
    .command('secrets')
    .description('Manage secure API keys');

  secrets
    .command('list')
    .description('List credentials that reference secure secrets')
    .action(() => {
      const cfg = readGlobalConfigJson();
      const credentials = cfg.credentials && typeof cfg.credentials === 'object' ? cfg.credentials : {};
      const rows = Object.entries(credentials)
        .filter(([, c]: any) => typeof c?.secretRef === 'string');
      if (rows.length === 0) {
        console.log(pc.dim('no secure secrets'));
        return;
      }
      for (const [id, c] of rows as Array<[string, any]>) {
        console.log(`${pc.cyan(id)}  ${pc.dim(c.provider ?? '?')}  ${pc.dim(c.secretRef)}`);
      }
    });

  secrets
    .command('view')
    .argument('<credentialId>', 'credential id')
    .description('Reveal an API key after system authentication')
    .action((credentialId: string) => {
      const cfg = readGlobalConfigJson();
      const cred = cfg.credentials?.[credentialId];
      if (!cred?.secretRef) {
        console.error(pc.red(`secure credential not found: ${credentialId}`));
        process.exit(1);
      }
      const secret = readSecret(cred.secretRef, `MA needs access to view ${credentialId}`, {
        authenticate: true,
      });
      console.log(`${credentialId}: ${maskSecret(secret)}`);
    });

  secrets
    .command('delete')
    .argument('<credentialId>', 'credential id')
    .description('Delete an API key after system authentication')
    .action((credentialId: string) => {
      const cfg = readGlobalConfigJson();
      const cred = cfg.credentials?.[credentialId];
      if (!cred?.secretRef) {
        console.error(pc.red(`secure credential not found: ${credentialId}`));
        process.exit(1);
      }
      deleteSecret(cred.secretRef, `MA needs access to delete ${credentialId}`);
      delete cfg.credentials[credentialId];
      for (const [id, p] of Object.entries(cfg.profiles ?? {}) as Array<[string, any]>) {
        if (p?.credentialId === credentialId) delete cfg.profiles[id];
      }
      if (cfg.defaultProfile && !cfg.profiles?.[cfg.defaultProfile]) {
        cfg.defaultProfile = Object.keys(cfg.profiles ?? {})[0];
      }
      writeGlobalConfigJson(cfg);
      console.log(pc.green(`${figures.tick} deleted credential: ${credentialId}`));
    });

  secrets
    .command('repair')
    .argument('<credentialId>', 'credential id')
    .description('Repair Keychain trusted access for the MA helper')
    .action((credentialId: string) => {
      const cfg = readGlobalConfigJson();
      const cred = cfg.credentials?.[credentialId];
      if (!cred?.secretRef) {
        console.error(pc.red(`secure credential not found: ${credentialId}`));
        process.exit(1);
      }
      repairSecretAccess(cred.secretRef);
      console.log(pc.green(`${figures.tick} repaired Keychain access for: ${credentialId}`));
    });

  program
    .command('init')
    .description('Initialize global config, built-in MCP servers, and project skills')
    .argument('[baseURL]', 'Model API base URL (e.g. http://localhost:1234/v1)')
    .argument('[model]', 'Model name (e.g. qwen3-30b-a3b)')
    .argument('[apiKey]', 'API key (default: lm-studio)')
    .action(async (baseURL: string | undefined, model: string | undefined, apiKey?: string) => {
      const args = [baseURL, model, apiKey].filter((v): v is string => Boolean(v));
      await runInit(args);
    });

  program
    .command('version')
    .description('Show version')
    .action(() => {
      console.log(VERSION);
    });

  program
    .option('--resume [id]', 'resume a saved session (empty = latest)')
    .action(async (opts: { resume?: string | boolean }) => {
      const resume = parseResume(opts.resume);
      await runChat(undefined, { debug: false, resume });
    });

  await program.parseAsync(process.argv);
}

main().catch(async (err) => {
  const error = err as Error;
  console.error(pc.red(`[fatal] ${error instanceof TerminalInputError ? error.message : error.stack ?? error.message}`));
  try {
    await shutdown(activeConnections, activeAgent);
  } catch {
    /* ignore shutdown errors during fatal cleanup */
  }
  process.exit(1);
});

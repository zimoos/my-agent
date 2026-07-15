#!/usr/bin/env node
import { runAcpServer } from './server.js';

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

runAcpServer({
  configPath: optionValue('--config') ?? process.env.MA_ACP_CONFIG_PATH,
  sessionDir: optionValue('--session-dir') ?? process.env.MA_ACP_SESSION_DIR,
}).catch((error) => {
  process.stderr.write(`[ma-acp] ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});

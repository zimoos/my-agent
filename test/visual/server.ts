import http from 'node:http';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.VISUAL_PORT ?? 3456);
const TEST_CWD = process.env.TEST_CWD ?? process.cwd();
// Default: run the in-repo CLI via node to sidestep PATH/nvm issues.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CMD = process.execPath;
const DEFAULT_ARGS = [path.join(PROJECT_ROOT, 'dist', 'src', 'cli', 'index.js')];
const SHELL_CMD = process.env.VISUAL_CMD ?? DEFAULT_CMD;
const SHELL_ARGS = process.env.VISUAL_ARGS
  ? process.env.VISUAL_ARGS.split(' ')
  : process.env.VISUAL_CMD ? [] : DEFAULT_ARGS;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  console.log(`[server] client connected, spawn: ${SHELL_CMD} ${SHELL_ARGS.join(' ')} (cwd=${TEST_CWD})`);
  let shell: pty.IPty;
  try {
    const childEnv = { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' };
    delete childEnv.NO_COLOR;
    shell = pty.spawn(SHELL_CMD, SHELL_ARGS, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: TEST_CWD,
      env: childEnv,
    });
  } catch (err) {
    const msg = `[server] failed to spawn shell: ${(err as Error).message}\r\n`;
    console.error(msg);
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
      ws.close();
    }
    return;
  }
  shell.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  shell.onExit(({ exitCode }) => {
    console.log(`[server] shell exited code=${exitCode}`);
    if (ws.readyState === ws.OPEN) ws.close();
  });
  ws.on('message', (msg) => {
    const text = typeof msg === 'string' ? msg : Buffer.isBuffer(msg) ? msg.toString() : String(msg);
    try { shell.write(text); } catch { /* shell may have exited */ }
  });
  ws.on('close', () => {
    console.log('[server] client disconnected, kill shell');
    try { shell.kill(); } catch { /* noop */ }
  });
});

process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err);
});

server.listen(PORT, () => {
  console.log(`[server] listening http://localhost:${PORT}`);
});

const shutdown = () => {
  console.log('[server] shutting down');
  wss.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

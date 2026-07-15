import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const helper = path.join(
    root,
    'node_modules',
    'node-pty',
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper'
  );
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}

import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SessionManager } from '@earendil-works/pi-coding-agent';

/** Bootstrap-only: materialize the SDK's actual public records before its first assistant reply. */
export async function persistInitialPiSession(manager: SessionManager, trustedDirectory: string, cwd: string): Promise<SessionManager> {
  const root = await realpath(trustedDirectory);
  if (root !== resolve(trustedDirectory)) throw new Error('MA_SESSION_DIRECTORY_INVALID');
  const file = manager.getSessionFile();
  if (!file || !isAbsolute(file)) throw new Error('MA_PERSISTENT_SESSION_REQUIRED');
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('MA_SESSION_DIRECTORY_INVALID');
  const directory = dirname(file);
  try {
    await mkdir(directory, { mode: 0o700 });
    const parent = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory || (stat.mode & 0o077) !== 0) {
    throw new Error('MA_SESSION_DIRECTORY_INVALID');
  }
  const header = manager.getHeader();
  if (!header || header.id !== manager.getSessionId() || header.cwd !== cwd) throw new Error('MA_PI_HEADER_INVALID');
  const entries = manager.getEntries();
  const records = [header, ...entries];
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = await existing.stat();
      if (!actual.isFile() || (actual.mode & 0o077) !== 0) throw new Error('MA_PI_HEADER_INVALID');
      const bytes = await existing.readFile();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.endsWith('\n')) throw new Error('MA_PI_HISTORY_INCOMPLETE');
      const found = text.split('\n').slice(0, -1).map(line => JSON.parse(line));
      if (!isDeepStrictEqual(found, records)) throw new Error('MA_PI_HEADER_CONFLICT');
    } finally { await existing.close(); }
  } finally { await handle?.close(); }
  const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
  const reopened = SessionManager.open(file, directory, cwd);
  if (reopened.getSessionId() !== manager.getSessionId() || reopened.getSessionFile() !== file
    || !isDeepStrictEqual(reopened.getHeader(), header) || !isDeepStrictEqual(reopened.getEntries(), entries)) {
    throw new Error('MA_PI_SESSION_ROUND_TRIP_FAILED');
  }
  return reopened;
}

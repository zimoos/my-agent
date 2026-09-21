import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSessionEntries, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';

/** Read-only compatibility view. Pi retains the sole conversation file and branch ownership. */
export function readPiSessionMessages(sessionRoot: string, sessionId: string): Array<Record<string, unknown>> | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(sessionId) || sessionId === '..') throw new Error('Invalid session identity');
  const directory = path.resolve(sessionRoot, sessionId);
  const manifestPath = path.join(directory, 'manifest.json');
  let hasManifest = false;
  try { fs.lstatSync(manifestPath); hasManifest = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!hasManifest) return null;
  if (fs.realpathSync(directory) !== directory) throw new Error('Invalid session directory');
  const read = (file: string): Buffer => {
    const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(handle).isFile()) throw new Error('Invalid saved session file');
      return fs.readFileSync(handle);
    } finally { fs.closeSync(handle); }
  };
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(manifestPath)));
  if (manifest.schemaVersion !== 2 || manifest.sessionId !== sessionId || manifest.kernelVersion !== 'pi-0.86.1'
    || typeof manifest.engineSessionFile !== 'string') throw new Error('Invalid MA session manifest');
  const piDirectory = path.join(directory, 'pi');
  const relative = path.relative(piDirectory, manifest.engineSessionFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.realpathSync(piDirectory) !== piDirectory
    || fs.realpathSync(manifest.engineSessionFile) !== manifest.engineSessionFile) throw new Error('Invalid saved Pi history path');
  const bytes = read(manifest.engineSessionFile);
  // A live append is not a record until its newline is present. Do not decode a partial UTF-8 tail.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.lastIndexOf(10) + 1));
  const records = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (records[0]?.type !== 'session' || records[0].id !== manifest.engineSessionId) throw new Error('Invalid saved Pi history header');
  const parsed = parseSessionEntries(text);
  if (parsed.length !== records.length) throw new Error('Invalid saved Pi history record');
  return parsed.flatMap(entry => entry.type === 'message' || entry.type === 'custom_message'
    ? sessionEntryToContextMessages(entry).map(message => structuredClone(message) as unknown as Record<string, unknown>) : []);
}

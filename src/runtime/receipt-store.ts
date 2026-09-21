import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { cloneRuntimeJson } from './data.js';

export interface ReceiptStore {
  write(value: Record<string, unknown>): Promise<string>;
  read(reference: string): Promise<Record<string, unknown>>;
  digest(references: readonly string[]): string;
  list(): Promise<string[]>;
}

/** The session owner holds the journal lock; this store never acquires execution authority. */
export async function openReceiptStore(directory: string): Promise<ReceiptStore> {
  const root = resolve(directory);
  try {
    await mkdir(root, { mode: 0o700 });
    const parent = await open(dirname(root), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('MA_RECEIPT_DIRECTORY_INVALID');
  const referencePath = (reference: string): string => {
    if (!/^receipt_[a-f0-9]{32}\.json$/.test(reference)) throw new Error('MA_RECEIPT_REFERENCE_INVALID');
    return join(root, reference);
  };
  const syncDirectory = async (): Promise<void> => {
    const handle = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  return {
    async list() {
      return (await readdir(root)).filter(name => /^receipt_[a-f0-9]{32}\.json$/.test(name)).sort();
    },
    async write(value) {
      const json = JSON.stringify(cloneRuntimeJson(value));
      const reference = `receipt_${randomUUID().replaceAll('-', '')}.json`;
      const path = referencePath(reference);
      const temporary = `${path}.pending`;
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | constants.O_NOFOLLOW, 0o600);
      let installed = false;
      try {
        await handle.writeFile(`${json}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        await rename(temporary, path);
        installed = true;
        await syncDirectory();
        return reference;
      } finally {
        await handle.close().catch(() => {});
        if (!installed) await unlink(temporary).catch(() => {});
      }
    },
    async read(reference) {
      const handle = await open(referencePath(reference), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('MA_RECEIPT_INVALID');
        const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MA_RECEIPT_INVALID');
        return cloneRuntimeJson(parsed as Record<string, unknown>);
      } finally { await handle.close(); }
    },
    digest(references) {
      for (const reference of references) referencePath(reference);
      return createHash('sha256').update(JSON.stringify([...references].sort()), 'utf8').digest('hex');
    },
  };
}

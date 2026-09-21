import { constants, closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Session-lock owner only. Reserved gaps are allowed; values never repeat after a crash. */
export function createEventSequence(directory: string, sessionId: string): () => number {
  const path = join(directory, 'event-sequence.json');
  let next = 1;
  let highWater = 0;
  let input: number | undefined;
  try {
    input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const saved = JSON.parse(readFileSync(input, 'utf8'));
    if (saved.schemaVersion !== 1 || saved.sessionId !== sessionId || !Number.isSafeInteger(saved.highWater) || saved.highWater < 0) {
      throw new Error('MA_EVENT_SEQUENCE_INVALID');
    }
    next = saved.highWater + 1; highWater = saved.highWater;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  finally { if (input !== undefined) closeSync(input); }
  return () => {
    if (next > highWater) {
      const reserved = highWater + 1024;
      if (!Number.isSafeInteger(reserved)) throw new Error('MA_EVENT_SEQUENCE_EXHAUSTED');
      const temporary = `${path}.${randomUUID()}.pending`;
      const output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, sessionId, highWater: reserved })}\n`); fsyncSync(output); }
      finally { closeSync(output); }
      renameSync(temporary, path);
      const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
      highWater = reserved;
    }
    return next++;
  };
}

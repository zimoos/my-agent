import { openExecutionJournal } from '../../../src/runtime/execution-journal.js';
import { journalTurnVector } from './batch1-vectors.js';

const options = JSON.parse(process.argv[2] ?? '{}') as {
  directory: string; sessionId: string; ownerId: string; mode: 'hold' | 'probe';
};
function send(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('journal child requires IPC'));
    process.send(value, (error: Error | null) => error ? reject(error) : resolve());
  });
}
try {
  const journal = await openExecutionJournal(options);
  if (options.mode === 'probe') {
    await journal.close();
    await send({ type: 'probe', acquired: true });
    process.disconnect();
  } else {
    const entry = await journal.append(journalTurnVector(1));
    await send({ type: 'ready', pid: process.pid, entry });
    process.on('message', (message) => {
      if (message !== 'close') return;
      void journal.close().then(() => send({ type: 'closed' })).then(() => process.disconnect()).catch(async (error: unknown) => {
        await send({ type: 'error', code: (error as { code?: string }).code, message: String(error) });
        process.exitCode = 1;
        process.disconnect();
      });
    });
  }
} catch (error) {
  await send({ type: 'probe', acquired: false, code: (error as { code?: string }).code, message: String(error) });
  process.disconnect();
}

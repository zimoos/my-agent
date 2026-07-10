import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

test('provider request path does not use ContextManager active context builders', () => {
  const agentSource = fs.readFileSync(path.join(process.cwd(), 'src/agent.ts'), 'utf-8');

  assert.match(
    agentSource,
    /providerCodec\.encodeMessages\s*\(/,
    'src/agent.ts must still have an observable provider request encoding path'
  );
  assert.equal(
    agentSource.match(/contextManager\.buildLlmContext\s*\(/)?.[0] ?? null,
    null,
    'provider request and context usage must not read ContextManager.buildLlmContext()'
  );
  assert.equal(
    agentSource.match(/\.buildContextRequestMessages\s*\(/)?.[0] ?? null,
    null,
    'provider request must not use MessageStore.buildContextRequestMessages(activeContext)'
  );
});

test('provider request path does not route ZimoOS current state through suffix/system text', () => {
  const agentSource = fs.readFileSync(path.join(process.cwd(), 'src/agent.ts'), 'utf-8');

  assert.equal(
    agentSource.match(/runtimeSlots\.render\s*\(\s*\)/)?.[0] ?? null,
    null,
    'ZimoOS current frame must not enter provider requests via buildRequestSuffix()/runtimeSlots.render()'
  );
});

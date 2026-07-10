import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { createAgent } from '../src/agent.js';
import { isSemanticTestCommand } from '../src/agent/completion-obligations.js';
import type { AgentConfig, AgentEvent, McpConnection } from '../src/mcp/types.js';

type StreamChunk = {
  choices: Array<{
    finish_reason?: string | null;
    delta: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

function findCompletionsPrototype(): any {
  const probe = new OpenAI({ baseURL: 'http://0.0.0.0', apiKey: 'test-key' });
  return Object.getPrototypeOf((probe as any).chat.completions);
}

function installProviderResponses(responses: StreamChunk[][]): {
  restore: () => void;
  calls: () => number;
} {
  const proto = findCompletionsPrototype();
  const original = proto.create;
  let callCount = 0;
  proto.create = function patched() {
    callCount++;
    const chunks = responses.shift();
    if (!chunks) throw new Error('test provider: no response queued');
    return Promise.resolve((async function* () {
      for (const chunk of chunks) yield chunk;
    })() as any);
  };
  return {
    restore: () => { proto.create = original; },
    calls: () => callCount,
  };
}

function textResponse(content: string): StreamChunk[] {
  return [
    { choices: [{ delta: { content } }] },
    { choices: [{ finish_reason: 'stop', delta: {} }] },
  ];
}

function toolResponse(
  id: string,
  name: string,
  args: Record<string, unknown>
): StreamChunk[] {
  return [
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id,
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
      }],
    },
    { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
  ];
}

async function drain(stream: AsyncGenerator<AgentEvent, void, unknown>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const config: AgentConfig = {
  model: {
    baseURL: 'http://127.0.0.1:0',
    model: 'completion-obligation-test',
    apiKey: 'test-key',
  },
  mcpServers: {},
  danger: { mode: 'off' },
};

function connection(
  name: string,
  toolName: string,
  result: { content: string; structuredContent?: Record<string, unknown> }
): McpConnection {
  return {
    name,
    process: {} as any,
    tools: [{
      name: toolName,
      description: `Fake ${toolName}`,
      inputSchema: { type: 'object', properties: {} },
    }],
    call: async () => ({ ...result, isError: false }),
    close: async () => {},
  };
}

function verifiedExecConnection(): McpConnection {
  return connection('exec', 'execute_command', {
    content: 'tests passed',
    structuredContent: {
      'my-agent/evidence': {
        operation: 'execute_command',
        status: 'verified',
      },
    },
  });
}

test('completion obligations: ordinary question completes without another provider request', async () => {
  const provider = installProviderResponses([textResponse('42')]);
  const agent = await createAgent(config, []);
  try {
    const events = await drain(agent.chat('What is six times seven?'));
    assert.equal(provider.calls(), 1);
    assert.ok(events.some((event) => event.type === 'task:done'));
    assert.equal(events.some((event) => event.type === 'task:failed'), false);
  } finally {
    provider.restore();
    await agent.close();
  }
});

test('completion obligations: successful semantic test command satisfies explicit test request', async () => {
  const provider = installProviderResponses([
    toolResponse('call_test', 'exec__execute_command', { cmd: 'npm test' }),
    textResponse('All tests passed.'),
  ]);
  const agent = await createAgent(config, [verifiedExecConnection()]);
  try {
    const events = await drain(agent.chat('Implement the fix and run npm test before finishing.'));
    assert.equal(provider.calls(), 2);
    assert.ok(events.some((event) => event.type === 'task:done'));
    assert.equal(events.some((event) => event.type === 'task:failed'), false);
  } finally {
    provider.restore();
    await agent.close();
  }
});

test('completion obligations: missing test evidence is nudged and can be repaired', async () => {
  const provider = installProviderResponses([
    textResponse('Implemented and done.'),
    toolResponse('call_test_repair', 'exec__execute_command', { cmd: 'node --test test/example.test.js' }),
    textResponse('The requested test now passes.'),
  ]);
  const agent = await createAgent(config, [verifiedExecConnection()]);
  try {
    const events = await drain(agent.chat('修复后请运行测试再交付。'));
    assert.equal(provider.calls(), 3);
    assert.ok(events.some((event) => event.type === 'warning' && /测试|test/i.test(event.message)));
    assert.ok(events.some((event) => event.type === 'task:done'));
    assert.equal(events.some((event) => event.type === 'task:failed'), false);
  } finally {
    provider.restore();
    await agent.close();
  }
});

test('completion obligations: web_fetch is not real browser verification and exhaustion fails', async () => {
  const provider = installProviderResponses([
    toolResponse('call_fetch', 'web__web_fetch', { url: 'http://localhost:3000' }),
    textResponse('HTTP 200, done.'),
    textResponse('I already checked it.'),
    textResponse('Final answer: verified.'),
  ]);
  const agent = await createAgent(config, [
    connection('web', 'web_fetch', { content: 'HTTP 200 OK' }),
  ]);
  try {
    const events = await drain(agent.chat('Use a real browser to verify the interaction before finishing.'));
    assert.equal(provider.calls(), 4);
    assert.equal(events.some((event) => event.type === 'task:done'), false);
    const failed = events.find((event) => event.type === 'task:failed');
    assert.ok(failed && failed.type === 'task:failed');
    assert.match(failed.error, /browser|浏览器|playwright|puppeteer/i);
  } finally {
    provider.restore();
    await agent.close();
  }
});

test('completion obligations: verified Playwright command satisfies browser request', async () => {
  const provider = installProviderResponses([
    toolResponse('call_browser', 'exec__execute_command', {
      cmd: 'npx playwright test test/visual/game.spec.ts',
    }),
    textResponse('Playwright interaction verification passed.'),
  ]);
  const agent = await createAgent(config, [verifiedExecConnection()]);
  try {
    const events = await drain(agent.chat('请用 Playwright 进行真实浏览器验证后交付。'));
    assert.equal(provider.calls(), 2);
    assert.ok(events.some((event) => event.type === 'task:done'));
    assert.equal(events.some((event) => event.type === 'task:failed'), false);
  } finally {
    provider.restore();
    await agent.close();
  }
});

test('completion obligations: successful browser automation tool satisfies browser request', async () => {
  const provider = installProviderResponses([
    toolResponse('call_click', 'browser__click', { selector: '#start' }),
    textResponse('The real browser interaction succeeded.'),
  ]);
  const agent = await createAgent(config, [
    connection('browser', 'click', { content: 'clicked #start' }),
  ]);
  try {
    const events = await drain(agent.chat('Use a real browser to verify the interaction before finishing.'));
    assert.equal(provider.calls(), 2);
    assert.ok(events.some((event) => event.type === 'task:done'));
    assert.equal(events.some((event) => event.type === 'task:failed'), false);
  } finally {
    provider.restore();
    await agent.close();
  }
});

test('completion obligations: filenames containing test as a substring are not test commands', () => {
  assert.equal(isSemanticTestCommand('node scripts/latest.js'), false);
  assert.equal(isSemanticTestCommand('cat test/report.txt'), false);
});

test('completion obligations: repeated unsupported final exhausts bounded retries without task done', async () => {
  const provider = installProviderResponses([
    textResponse('Tests passed.'),
    textResponse('Everything is complete.'),
    textResponse('Final delivery.'),
  ]);
  const agent = await createAgent(config, []);
  try {
    const events = await drain(agent.chat('Run the tests and then deliver the result.'));
    assert.equal(provider.calls(), 3);
    assert.equal(events.filter((event) => event.type === 'warning').length, 2);
    assert.equal(events.some((event) => event.type === 'task:done'), false);
    assert.ok(events.some((event) => event.type === 'task:failed'));
  } finally {
    provider.restore();
    await agent.close();
  }
});

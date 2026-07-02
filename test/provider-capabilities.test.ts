import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelCapabilities } from '../src/provider/capabilities.js';

test('provider capabilities: DeepSeek v4 flash/pro default to 1m context', () => {
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    const capabilities = resolveModelCapabilities({
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      model,
      apiKey: 'test',
    });
    assert.equal(capabilities.contextWindow, 1_000_000);
    assert.equal(capabilities.contextWindowSource, 'registry');
  }
});

test('provider capabilities: explicit contextWindow overrides registry', () => {
  const capabilities = resolveModelCapabilities({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    apiKey: 'test',
    contextWindow: 123_456,
  });
  assert.equal(capabilities.contextWindow, 123_456);
  assert.equal(capabilities.contextWindowSource, 'config');
});

test('provider capabilities: LM Studio hint overrides registry fallback', () => {
  const capabilities = resolveModelCapabilities(
    {
      provider: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      model: 'local-model',
      apiKey: 'lm-studio',
    },
    { lmStudioContextWindow: 65_536 }
  );
  assert.equal(capabilities.contextWindow, 65_536);
  assert.equal(capabilities.contextWindowSource, 'lmstudio');
});

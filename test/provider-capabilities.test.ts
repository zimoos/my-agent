import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEEPSEEK_REQUEST_BODY_BYTE_LIMIT,
  DEFAULT_REQUEST_BODY_BYTE_LIMIT,
  resolveModelCapabilities,
} from '../src/provider/capabilities.js';

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
    assert.equal(capabilities.requestBodyByteLimit, DEEPSEEK_REQUEST_BODY_BYTE_LIMIT);
    assert.equal(capabilities.requestBodyByteLimitSource, 'deepseek');
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

test('provider capabilities: Agora qwen3.6 local profile uses registered 262k context', () => {
  const capabilities = resolveModelCapabilities({
    provider: 'agora',
    baseURL: 'mcp-stdio://agora',
    model: 'qwen3.6-35b-a3b-q4',
    apiKey: 'agora-mcp',
  });
  assert.equal(capabilities.contextWindow, 262_144);
  assert.equal(capabilities.contextWindowSource, 'registry');
  assert.equal(capabilities.requestBodyByteLimit, DEFAULT_REQUEST_BODY_BYTE_LIMIT);
  assert.equal(capabilities.requestBodyByteLimitSource, 'agora');
});

test('provider capabilities: LM Studio and OpenAI are not capped by DeepSeek body limit', () => {
  for (const model of [
    {
      provider: 'lmstudio',
      baseURL: 'http://127.0.0.1:1234/v1',
      model: 'local-model',
      apiKey: 'lm-studio',
    },
    {
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-4.1',
      apiKey: 'test',
    },
  ]) {
    const capabilities = resolveModelCapabilities(model);
    assert.equal(capabilities.requestBodyByteLimit, DEFAULT_REQUEST_BODY_BYTE_LIMIT);
    assert.ok(capabilities.requestBodyByteLimit > DEEPSEEK_REQUEST_BODY_BYTE_LIMIT);
  }
});

test('provider capabilities: DeepSeek model through another compatible host is not treated as official DeepSeek', () => {
  const capabilities = resolveModelCapabilities({
    provider: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4',
    apiKey: 'test',
  });
  assert.equal(capabilities.requestBodyByteLimit, DEFAULT_REQUEST_BODY_BYTE_LIMIT);
  assert.equal(capabilities.requestBodyByteLimitSource, 'openai');
});

test('provider capabilities: explicit requestBodyByteLimit overrides provider default', () => {
  const capabilities = resolveModelCapabilities({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    apiKey: 'test',
    requestBodyByteLimit: 777_777,
  });
  assert.equal(capabilities.requestBodyByteLimit, 777_777);
  assert.equal(capabilities.requestBodyByteLimitSource, 'config');
});

test('provider capabilities: prefilled registry context still resolves DeepSeek byte limit', () => {
  const capabilities = resolveModelCapabilities({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    apiKey: 'test',
    contextWindow: 1_000_000,
    contextWindowSource: 'registry',
  });
  assert.equal(capabilities.contextWindow, 1_000_000);
  assert.equal(capabilities.contextWindowSource, 'registry');
  assert.equal(capabilities.requestBodyByteLimit, DEEPSEEK_REQUEST_BODY_BYTE_LIMIT);
  assert.equal(capabilities.requestBodyByteLimitSource, 'deepseek');
});

test('provider capabilities: invalid explicit requestBodyByteLimit fails fast', () => {
  for (const requestBodyByteLimit of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => resolveModelCapabilities({
        provider: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        apiKey: 'test',
        requestBodyByteLimit,
      }),
      /requestBodyByteLimit must be a positive integer/
    );
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderCodec } from '../src/provider/detect.js';

test('provider codec: LM Studio sends pure base64 image_url values', () => {
  const codec = resolveProviderCodec({
    provider: 'lmstudio',
    baseURL: 'http://192.168.21.5:1234/v1',
    model: 'qwen-vl',
    apiKey: 'lm-studio',
  });

  const encoded = codec.encodeMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
        },
      ],
    } as any,
  ]);

  assert.equal(codec.name, 'lmstudio');
  assert.equal(
    (encoded[0] as any).content[1].image_url.url,
    'iVBORw0KGgo='
  );
});

test('provider codec: LM Studio is detected from port 1234 for legacy configs', () => {
  const codec = resolveProviderCodec({
    baseURL: 'http://127.0.0.1:1234/v1',
    model: 'qwen-vl',
    apiKey: 'lm-studio',
  });

  assert.equal(codec.name, 'lmstudio');
});

test('provider codec: OpenAI-compatible default keeps data URI image_url values', () => {
  const codec = resolveProviderCodec({
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    apiKey: 'sk-test',
  });

  const encoded = codec.encodeMessages([
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
        },
      ],
    } as any,
  ]);

  assert.equal(
    (encoded[0] as any).content[0].image_url.url,
    'data:image/png;base64,iVBORw0KGgo='
  );
});

test('provider codec: Agora explicit provider uses OpenAI-compatible message shape', () => {
  const codec = resolveProviderCodec({
    provider: 'agora',
    baseURL: 'http://127.0.0.1:8000/v1',
    model: 'qwen3.6-35b-a3b-q4',
    apiKey: 'lm-studio',
  });

  const encoded = codec.encodeMessages([
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
        },
      ],
    } as any,
  ]);

  assert.equal(codec.name, 'openai');
  assert.equal(
    (encoded[0] as any).content[0].image_url.url,
    'data:image/png;base64,iVBORw0KGgo='
  );
});

import type { ModelsDevInfo } from './qa-model-parsers.ts';
import { describe, expect, test } from 'bun:test';
import {
  detectProvider,
  inferCapabilities,
  inferUnderlyingProvider,
  parseAnthropic,
  parseFlatArray,
  parseGoogle,
  parseOpenAICompatible,
  parseProvider,
  prefixForProvider,
} from './qa-model-parsers.ts';
import { filterModelsForCli, toHarnessModelId } from './qa-model-selector.ts';

const meta = (entries: Record<string, { provider: string, status?: string }>): Map<string, ModelsDevInfo> =>
  new Map(Object.entries(entries).map(([id, m]) => [id, { provider: m.provider, status: m.status ?? 'active' }]));

describe('detectProvider', () => {
  test('known endpoints map to the right provider', () => {
    expect(detectProvider('https://opencode.ai/zen/go/v1/models')).toBe('opencode-go');
    expect(detectProvider('https://opencode.ai/zen/v1/models')).toBe('opencode');
    expect(detectProvider('https://generativelanguage.googleapis.com/v1beta/models')).toBe('google');
    expect(detectProvider('https://api.anthropic.com/v1/models')).toBe('anthropic');
    expect(detectProvider('https://api.openai.com/v1/models')).toBe('openai-direct');
    expect(detectProvider('https://api.deepseek.com/models')).toBe('deepseek');
    expect(detectProvider('https://api.moonshot.cn/v1/models')).toBe('kimi');
    expect(detectProvider('https://example.com/unknown')).toBe('custom');
  });

  test('OPENAI_API_BASE proxy is recognized as openai-direct', () => {
    const prev = process.env.OPENAI_API_BASE;
    process.env.OPENAI_API_BASE = 'https://my-proxy.example.com/v1';
    try {
      expect(detectProvider('https://my-proxy.example.com/v1/models')).toBe('openai-direct');
    }
    finally {
      if (prev === undefined) { delete process.env.OPENAI_API_BASE; }
      else { process.env.OPENAI_API_BASE = prev; }
    }
  });
});

describe('inferUnderlyingProvider', () => {
  test('strips any provider prefix and resolves the vendor', () => {
    expect(inferUnderlyingProvider('opencode/claude-opus-5')).toBe('anthropic');
    expect(inferUnderlyingProvider('anthropic/claude-3-5-sonnet')).toBe('anthropic');
    expect(inferUnderlyingProvider('openai/gpt-4')).toBe('openai');
    expect(inferUnderlyingProvider('opencode-go/deepseek-v4-pro')).toBe('deepseek');
    expect(inferUnderlyingProvider('deepseek/deepseek-chat')).toBe('deepseek');
    expect(inferUnderlyingProvider('google/gemini-2.5-flash')).toBe('google');
    expect(inferUnderlyingProvider('opencode/mimo-v2.5-free')).toBe('opencode');
  });
});

describe('inferCapabilities', () => {
  test('flash is NOT vision; it maps to budget', () => {
    expect(inferCapabilities('gemini-2.5-flash')).not.toContain('vision');
    expect(inferCapabilities('gemini-2.5-flash')).toContain('budget');
  });
  test('vision/code/pro are tagged', () => {
    expect(inferCapabilities('claude-vision-pro')).toContain('vision');
    expect(inferCapabilities('deepseek-coder')).toContain('code');
    expect(inferCapabilities('deepseek-v4-pro')).toContain('reasoning');
  });
});

describe('parseAnthropic', () => {
  test('normalizes { data: [{ id, display_name }] }', () => {
    const payload = { data: [{ id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet', type: 'model' }] };
    expect(parseAnthropic(payload, 'https://api.anthropic.com/v1/models')).toEqual([
      {
        id: 'anthropic/claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        provider: 'anthropic',
        source: 'https://api.anthropic.com/v1/models',
        capabilities: inferCapabilities('claude-3-5-sonnet-20241022'),
      },
    ]);
  });
  test('returns [] on a non-list payload', () => {
    expect(parseAnthropic({ foo: 'bar' }, 'x')).toEqual([]);
  });
});

describe('parseGoogle', () => {
  test('strips the "models/" prefix from Gemini ids', () => {
    const payload = { models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }] };
    expect(parseGoogle(payload, 'https://generativelanguage.googleapis.com/v1beta/models')).toEqual([
      {
        id: 'google/gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        provider: 'google',
        source: 'https://generativelanguage.googleapis.com/v1beta/models',
        capabilities: inferCapabilities('gemini-2.5-flash'),
      },
    ]);
  });
});

describe('parseOpenAICompatible', () => {
  test('deepseek provider prefixes ids with deepseek/', () => {
    const payload = { data: [{ id: 'deepseek-chat' }] };
    const models = parseOpenAICompatible(payload, 'https://api.deepseek.com/models', 'deepseek', new Map());
    expect(models[0].id).toBe('deepseek/deepseek-chat');
    expect(models[0].provider).toBe('deepseek');
  });

  test('openai-direct prefixes ids with openai/ and hardcodes provider openai', () => {
    const payload = { data: [{ id: 'gpt-4', name: 'GPT-4', owned_by: 'system' }] };
    const models = parseOpenAICompatible(payload, 'https://api.openai.com/v1/models', 'openai-direct', new Map());
    expect(models[0].id).toBe('openai/gpt-4');
    expect(models[0].provider).toBe('openai');
  });

  test('opencode uses models.dev provider override', () => {
    const payload = { data: [{ id: 'claude-opus-5' }] };
    const models = parseOpenAICompatible(payload, 'https://opencode.ai/zen/v1/models', 'opencode', meta({ 'claude-opus-5': { provider: 'anthropic' } }));
    expect(models[0].id).toBe('opencode/claude-opus-5');
    expect(models[0].provider).toBe('anthropic');
  });
});

describe('parseFlatArray', () => {
  test('handles the custom flat-array format', () => {
    const payload = [{ id: 'acme-model', name: 'Acme', provider: 'acme' }];
    expect(parseFlatArray(payload, 'https://example.com/models', 'custom')).toEqual([
      {
        id: 'acme-model',
        name: 'Acme',
        provider: 'acme',
        source: 'https://example.com/models',
        capabilities: inferCapabilities('acme-model'),
      },
    ]);
  });
});

describe('parseProvider dispatch', () => {
  test('routes anthropic and google payloads to their parsers', () => {
    expect(parseProvider('anthropic', { data: [{ id: 'claude-3' }] }, 'x', new Map())[0].id).toBe('anthropic/claude-3');
    expect(parseProvider('google', { models: [{ name: 'models/gemini-pro' }] }, 'x', new Map())[0].id).toBe('google/gemini-pro');
  });
  test('falls through to flat-array for a bare array body', () => {
    expect(parseProvider('custom', [{ id: 'acme' }], 'x', new Map())[0].id).toBe('acme');
  });
});

describe('prefixForProvider', () => {
  test('maps provider to the canonical prefix', () => {
    expect(prefixForProvider('opencode-go', 'x')).toBe('opencode-go/x');
    expect(prefixForProvider('opencode', 'x')).toBe('opencode/x');
    expect(prefixForProvider('openai-direct', 'x')).toBe('openai/x');
    expect(prefixForProvider('deepseek', 'x')).toBe('deepseek/x');
    expect(prefixForProvider('kimi', 'x')).toBe('kimi/x');
    expect(prefixForProvider('custom', 'x')).toBe('x');
  });
});

describe('toHarnessModelId', () => {
  test('opencode/codex keep the catalog id as-is', () => {
    expect(toHarnessModelId('opencode', 'opencode/claude-opus-5')).toBe('opencode/claude-opus-5');
    expect(toHarnessModelId('codex', 'openai/gpt-5')).toBe('openai/gpt-5');
  });
  test('claude-code maps to short aliases', () => {
    expect(toHarnessModelId('claude-code', 'opencode/claude-opus-5')).toBe('opus');
    expect(toHarnessModelId('claude-code', 'opencode/claude-sonnet-5')).toBe('sonnet');
    expect(toHarnessModelId('claude-code', 'opencode/claude-haiku-4-5')).toBe('haiku');
  });
});

describe('filterModelsForCli', () => {
  const models = [
    { id: 'opencode/claude-opus-5', name: 'Claude Opus 5', provider: 'anthropic', source: 'z', capabilities: [] },
    { id: 'openai/gpt-4', name: 'GPT-4', provider: 'openai', source: 'z', capabilities: [] },
    { id: 'opencode-go/deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'opencode', source: 'z', capabilities: [] },
  ];
  test('claude-code keeps only anthropic models', () => {
    expect(filterModelsForCli(models, 'claude-code').map(m => m.id)).toEqual(['opencode/claude-opus-5']);
  });
  test('codex keeps only openai models', () => {
    expect(filterModelsForCli(models, 'codex').map(m => m.id)).toEqual(['openai/gpt-4']);
  });
  test('opencode keeps everything', () => {
    expect(filterModelsForCli(models, 'opencode').map(m => m.id)).toHaveLength(3);
  });
});

/**
 * ============================================================================
 * QA MODEL PARSERS — pure provider parsing + inference functions
 * ============================================================================
 *
 * Extracted from qa-model-selector.ts so each provider's response format is
 * isolated in its own typed function. No side effects, no fetches, no env
 * reads (except detectProvider's OPENAI_API_BASE proxy hint) — unit-testable
 * with `bun test`.
 *
 * Every parser takes an `unknown` payload (the parsed JSON body) and returns
 * normalized ModelEntry[] with the canonical `provider/` ID prefix.
 */

export interface ModelEntry {
  id: string
  name: string
  provider: string
  source: string
  capabilities: string[]
}

export interface ModelsDevInfo {
  status: string
  provider: string
}

/**
 * Infer capability tags from a model id. Deliberately heuristic and narrow:
 * only assert a capability when the name strongly implies it. `flash`/`lite`
 * mean "fast/cheap", NOT vision — those map to `budget`, not `vision`.
 */
export function inferCapabilities(modelId: string): string[] {
  const caps: string[] = [];
  const lower = modelId.toLowerCase();
  if (lower.includes('vision')) {
    caps.push('vision');
  }
  if (lower.includes('code') || lower.includes('coder')) {
    caps.push('code');
  }
  if (lower.includes('pro') || lower.includes('reason')) {
    caps.push('reasoning');
  }
  if (lower.includes('free') || lower.includes('lite') || lower.includes('mini')) {
    caps.push('budget');
  }
  return caps;
}

/**
 * Resolve the underlying model vendor regardless of which provider prefix an
 * id carries (opencode/claude-…, anthropic/claude-…, openai/gpt-…, etc.).
 */
export function inferUnderlyingProvider(modelId: string): string {
  const id = modelId.replace(/^(?:opencode-go|opencode|openai|google|anthropic|deepseek|kimi)\//, '');
  if (id.startsWith('claude') || id.startsWith('sonnet') || id.startsWith('opus') || id.startsWith('haiku')) {
    return 'anthropic';
  }
  if (id.startsWith('gpt') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('codex')) {
    return 'openai';
  }
  if (id.startsWith('gemini')) {
    return 'google';
  }
  if (id.startsWith('deepseek')) {
    return 'deepseek';
  }
  if (id.startsWith('glm')) {
    return 'zhipu';
  }
  if (id.startsWith('kimi')) {
    return 'moonshot';
  }
  if (id.startsWith('qwen')) {
    return 'alibaba';
  }
  if (id.startsWith('grok')) {
    return 'xai';
  }
  if (id.startsWith('minimax')) {
    return 'minimax';
  }
  if (id.startsWith('nemotron')) {
    return 'nvidia';
  }
  if (id.startsWith('mimo') || id.startsWith('muse') || id.startsWith('ling') || id.startsWith('big-pickle')) {
    return 'opencode';
  }
  if (id.startsWith('hy') || id.startsWith('omen') || id.startsWith('longcat')) {
    return 'opencode';
  }
  return 'other';
}

/**
 * Identify the provider from an endpoint URL. Pure URL matching, plus a hint
 * for a custom OpenAI-compatible base (OPENAI_API_BASE proxy).
 */
export function detectProvider(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('opencode.ai/zen/go')) {
    return 'opencode-go';
  }
  if (lower.includes('opencode.ai/zen') || lower.includes('opencode')) {
    return 'opencode';
  }
  if (lower.includes('generativelanguage.googleapis.com') || lower.includes('google')) {
    return 'google';
  }
  if (lower.includes('api.anthropic.com')) {
    return 'anthropic';
  }
  if (lower.includes('api.openai.com')) {
    return 'openai-direct';
  }
  const openaiBase = process.env.OPENAI_API_BASE;
  if (openaiBase && lower.startsWith(openaiBase.toLowerCase())) {
    return 'openai-direct';
  }
  if (lower.includes('api.deepseek.com')) {
    return 'deepseek';
  }
  if (lower.includes('api.moonshot.cn')) {
    return 'kimi';
  }
  if (lower.includes('openai')) {
    return 'openai';
  }
  return 'custom';
}

/** Apply the canonical `provider/` prefix for a raw model id. */
export function prefixForProvider(provider: string, rawId: string): string {
  switch (provider) {
    case 'opencode-go': return `opencode-go/${rawId}`;
    case 'opencode': return `opencode/${rawId}`;
    case 'openai-direct': return `openai/${rawId}`;
    case 'deepseek': return `deepseek/${rawId}`;
    case 'kimi': return `kimi/${rawId}`;
    default: return rawId;
  }
}

/** Anthropic: `{ data: [{ id, display_name }] }`. */
export function parseAnthropic(data: unknown, source: string): ModelEntry[] {
  const list = (data as { data?: unknown[] })?.data;
  if (!Array.isArray(list)) { return []; }
  const models: ModelEntry[] = [];
  for (const raw of list) {
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string') { continue; }
    models.push({
      id: `anthropic/${m.id}`,
      name: typeof m.display_name === 'string' ? m.display_name : m.id,
      provider: 'anthropic',
      source,
      capabilities: inferCapabilities(m.id),
    });
  }
  return models;
}

/** Google Gemini: `{ models: [{ name: "models/…", displayName }] }`. */
export function parseGoogle(data: unknown, source: string): ModelEntry[] {
  const list = (data as { models?: unknown[] })?.models;
  if (!Array.isArray(list)) { return []; }
  const models: ModelEntry[] = [];
  for (const raw of list) {
    const m = raw as Record<string, unknown>;
    const name = typeof m.name === 'string' ? m.name : '';
    const rawId = name.replace('models/', '');
    if (!rawId) { continue; }
    models.push({
      id: `google/${rawId}`,
      name: typeof m.displayName === 'string' ? m.displayName : rawId,
      provider: 'google',
      source,
      capabilities: inferCapabilities(rawId),
    });
  }
  return models;
}

/**
 * OpenAI-compatible list: `{ data: [{ id, name?, owned_by? }] }`.
 * Used by opencode, opencode-go, openai-direct, deepseek, kimi and any
 * custom OpenAI-compatible endpoint.
 */
export function parseOpenAICompatible(
  data: unknown,
  source: string,
  provider: string,
  metaMap: Map<string, ModelsDevInfo>,
): ModelEntry[] {
  const list = (data as { data?: unknown[] })?.data;
  if (!Array.isArray(list)) { return []; }
  const models: ModelEntry[] = [];
  for (const raw of list) {
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string') { continue; }
    const rawId = m.id;
    const meta = metaMap.get(rawId);
    const modelProvider = provider === 'openai-direct'
      ? 'openai'
      : (meta?.provider || (typeof m.owned_by === 'string' ? m.owned_by : provider));
    models.push({
      id: prefixForProvider(provider, rawId),
      name: typeof m.name === 'string' ? m.name : rawId,
      provider: modelProvider,
      source,
      capabilities: inferCapabilities(rawId),
    });
  }
  return models;
}

/** Custom flat format: `[{ id, name?, provider?, capabilities? }]`. */
export function parseFlatArray(data: unknown, source: string, provider: string): ModelEntry[] {
  if (!Array.isArray(data)) { return []; }
  const models: ModelEntry[] = [];
  for (const raw of data) {
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string') { continue; }
    models.push({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : m.id,
      provider: typeof m.provider === 'string' ? m.provider : provider,
      source,
      capabilities: Array.isArray(m.capabilities) ? m.capabilities as string[] : inferCapabilities(m.id),
    });
  }
  return models;
}

/** Dispatch to the right parser for a provider. */
export function parseProvider(
  provider: string,
  data: unknown,
  source: string,
  metaMap: Map<string, ModelsDevInfo>,
): ModelEntry[] {
  if (provider === 'anthropic') { return parseAnthropic(data, source); }
  if (provider === 'google') { return parseGoogle(data, source); }
  const list = (data as { data?: unknown[] })?.data;
  if (Array.isArray(list)) { return parseOpenAICompatible(data, source, provider, metaMap); }
  if (Array.isArray(data)) { return parseFlatArray(data, source, provider); }
  return [];
}

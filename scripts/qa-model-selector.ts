#!/usr/bin/env bun

/**
 * ============================================================================
 * QA MODEL SELECTOR — Interactive CLI to select AI models per QA role
 * ============================================================================
 *
 * Fetches available models from multiple providers, caches them locally,
 * and lets you interactively assign models to each QA role (qa-plan,
 * qa-code, qa-review, qa-bulk, qa-write, qa-vision).
 *
 * Updates agent markdown files across all harnesses:
 *   .opencode/agents/, .codex/agents/, .claude/agents/
 *
 * ============================================================================
 * USAGE
 * ============================================================================
 *
 *   bun run qa-role:model:select                          # interactive (default)
 *   bun run qa-role:model:select --dry-run                # print changes, do not write
 *   bun run qa-role:model:select --role qa-plan --model x # set single role
 *   bun run qa-role:model:select --list                   # list available models
 *   bun run qa-role:model:select --refresh                # force re-fetch models
 *   bun run qa-role:model:select --help                   # show help
 *
 * ============================================================================
 * ENVIRONMENT VARIABLES
 * ============================================================================
 *
 *   MODELS_CATALOG_URLS    Comma-separated API endpoints for model discovery.
 *                          Default: https://api.opencode.ai/v1/models
 *                          Supports OpenAI-compatible and custom formats.
 *
 *   MODELS_CACHE_TTL       Cache TTL in seconds (default: 86400 = 24h).
 *   MODELS_CACHE_FILE      Cache file path (default: .models.catalog.json).
 *
 * ============================================================================
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { confirm, input, select, Separator } from '@inquirer/prompts';

// ============================================================================
// CONSTANTS
// ============================================================================

const REPO_ROOT = join(import.meta.dir, '..');

const QA_ROLES = ['qa-plan', 'qa-code', 'qa-review', 'qa-bulk', 'qa-write', 'qa-vision'] as const;
type QaRole = typeof QA_ROLES[number];

const ROLE_DESCRIPTIONS: Record<QaRole, string> = {
  'qa-plan': 'Reasoning/analysis — shift-left, test planning, GO/NO-GO',
  'qa-code': 'Code generation — KATA, Playwright, TypeScript',
  'qa-review': 'Code review — KATA compliance, doctrine checking',
  'qa-bulk': 'Mechanical/bulk — TC creation, CI monitoring, CLI ops',
  'qa-write': 'Prose — Jira comments, ATR/ATP bodies, reports',
  'qa-vision': 'Visual — screenshots, bug annotation, UI inspection',
};

const HARNESS_DIRS = [
  '.opencode/agents',
  '.codex/agents',
  '.claude/agents',
];

const PREF_FILE = join(REPO_ROOT, '.selected-qa-models');

// ============================================================================
// TYPES
// ============================================================================

interface ModelEntry {
  id: string
  name: string
  provider: string
  source: string
  capabilities: string[]
}

interface ModelCatalog {
  models: ModelEntry[]
  fetchedAt: number
  sources: string[]
}

interface CliFlags {
  dryRun: boolean
  list: boolean
  refresh: boolean
  role: string | null
  model: string | null
  help: boolean
}

// ============================================================================
// CLI DETECTION
// ============================================================================

type ActiveCli = 'opencode' | 'claude-code' | 'codex';

function detectActiveCli(): ActiveCli {
  // Authoritative signal = the env var set by the running CLI. Directory-based
  // fallbacks are ambiguous: this repo commits .opencode/, .claude/ AND .codex/
  // simultaneously, so any dir check would always resolve to the first match
  // regardless of which CLI is actually running.
  if (process.env.OPENCODE === '1' || process.env.OPENCODE_PID) {
    return 'opencode';
  }
  if (process.env.CLAUDE_CODE === '1' || process.env.CLAUDE_CODE_SESSION) {
    return 'claude-code';
  }
  if (process.env.CODEX === '1' || process.env.CODEX_SESSION) {
    return 'codex';
  }
  // Safe default for this boilerplate.
  return 'opencode';
}

function getAgentDirForCli(cli: ActiveCli): string {
  switch (cli) {
    case 'claude-code': return '.claude/agents';
    case 'codex': return '.codex/agents';
    case 'opencode': return '.opencode/agents';
  }
}

function filterModelsForCli(models: ModelEntry[], cli: ActiveCli): ModelEntry[] {
  switch (cli) {
    case 'claude-code':
      // Claude Code only supports Anthropic models
      return models.filter(m => inferUnderlyingProvider(m.id) === 'anthropic');
    case 'codex':
      // Codex only supports OpenAI models
      return models.filter(m => inferUnderlyingProvider(m.id) === 'openai');
    case 'opencode':
      // OpenCode supports all models
      return models;
  }
}

function toHarnessModelId(cli: ActiveCli, modelId: string): string {
  if (cli !== 'claude-code') { return modelId; }
  // Claude Code agent `model:` uses short aliases (opus/sonnet/haiku), not
  // catalog IDs like opencode/claude-opus-5. Map by model family.
  const id = modelId.toLowerCase();
  if (id.includes('opus')) { return 'opus'; }
  if (id.includes('sonnet')) { return 'sonnet'; }
  if (id.includes('haiku')) { return 'haiku'; }
  return modelId.replace(/^(?:opencode-go|opencode|anthropic)\//, '');
}

// ============================================================================
// COLORS / OUTPUT
// ============================================================================

const colors = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[2m',
  red: '\x1B[31m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  blue: '\x1B[34m',
  cyan: '\x1B[36m',
};

function out(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

const log = {
  info: (msg: string) => err(`${colors.blue}i${colors.reset} ${msg}`),
  success: (msg: string) => err(`${colors.green}+${colors.reset} ${msg}`),
  warn: (msg: string) => err(`${colors.yellow}!${colors.reset} ${msg}`),
  error: (msg: string) => err(`${colors.red}x${colors.reset} ${msg}`),
  dim: (msg: string) => err(`${colors.dim}${msg}${colors.reset}`),
  header: (msg: string) => err(`\n${colors.bold}${colors.cyan}${msg}${colors.reset}`),
};

// ============================================================================
// CLI PARSING
// ============================================================================

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    dryRun: false,
    list: false,
    refresh: false,
    role: null,
    model: null,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--list':
        flags.list = true;
        break;
      case '--refresh':
        flags.refresh = true;
        break;
      case '--role':
        flags.role = argv[++i] ?? null;
        break;
      case '--model':
        flags.model = argv[++i] ?? null;
        break;
      case '--help':
      case '-h':
        flags.help = true;
        break;
      default:
        log.warn(`Unknown flag: ${arg} (ignored)`);
    }
  }
  return flags;
}

function printHelp(): void {
  out(`qa-role:model:select — select AI models per QA role

USAGE:
  bun run qa-role:model:select [flags]

FLAGS:
  --dry-run            Print changes without writing files.
  --list               List available models and exit.
  --refresh            Force re-fetch from providers (ignore cache).
  --role <role>        Set model for a single role (non-interactive).
  --model <model>      Model ID to assign (use with --role).
  --help, -h           Show this help.

ENVIRONMENT VARIABLES:
  MODELS_CATALOG_URLS    Comma-separated API endpoints for model discovery.
                         Default: https://opencode.ai/zen/v1/models
  MODELS_CACHE_TTL       Cache TTL in seconds (default: 86400).
  MODELS_CACHE_FILE      Cache file path (default: .models.catalog.json).

EXAMPLES:
  bun run qa-role:model:select                    # interactive selector
  bun run qa-role:model:select --list             # show available models
  bun run qa-role:model:select --role qa-plan --model opencode-go/glm-5.3
`);
}

// ============================================================================
// MODEL CATALOG — fetch, cache, normalize
// ============================================================================

function getCacheFile(): string {
  const file = process.env.MODELS_CACHE_FILE;
  if (file) {
    return join(REPO_ROOT, file);
  }
  return join(REPO_ROOT, '.models.catalog.json');
}

function getCacheTtl(): number {
  const ttl = process.env.MODELS_CACHE_TTL;
  return ttl ? Number.parseInt(ttl, 10) * 1000 : 86400 * 1000; // 24h default
}

function getCatalogUrls(): string[] {
  const urls = process.env.MODELS_CATALOG_URLS;
  if (urls) {
    return urls.split(',').map(u => u.trim()).filter(Boolean);
  }
  // Default: OpenCode Zen + Go endpoints (user's connected providers)
  const defaultUrls = [
    'https://opencode.ai/zen/v1/models',
    'https://opencode.ai/zen/go/v1/models',
  ];
  // Add Google Gemini API if key is available in .env
  const googleKey = process.env.GOOGLE_API_KEY;
  if (googleKey) {
    // Store base URL without key in cache; key added at fetch time
    defaultUrls.push('https://generativelanguage.googleapis.com/v1beta/models');
  }
  // Add Anthropic API if key is available in .env
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    defaultUrls.push('https://api.anthropic.com/v1/models');
  }
  // Add OpenAI API if key is available in .env
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    defaultUrls.push('https://api.openai.com/v1/models');
  }
  // Add DeepSeek API if key is available in .env
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (deepseekKey) {
    defaultUrls.push('https://api.deepseek.com/models');
  }
  // Add Kimi (Moonshot) API if key is available in .env
  const kimiKey = process.env.KIMI_API_KEY;
  if (kimiKey) {
    defaultUrls.push('https://api.moonshot.cn/v1/models');
  }
  return defaultUrls;
}

function loadCache(): ModelCatalog | null {
  const cacheFile = getCacheFile();
  if (!existsSync(cacheFile)) {
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(cacheFile, 'utf8')) as ModelCatalog;
    const age = Date.now() - data.fetchedAt;
    if (age > getCacheTtl()) {
      log.info('Cache expired, will re-fetch.');
      return null;
    }
    return data;
  }
  catch {
    return null;
  }
}

function saveCache(catalog: ModelCatalog): void {
  const cacheFile = getCacheFile();
  const dir = dirname(cacheFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(cacheFile, JSON.stringify(catalog, null, 2), 'utf8');
}

// Provider adapters — normalize different API response formats

function detectProvider(url: string): string {
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

function inferCapabilities(modelId: string): string[] {
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

function inferUnderlyingProvider(modelId: string): string {
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
  if (id.startsWith('hy')) {
    return 'opencode';
  }
  if (id.startsWith('omen')) {
    return 'opencode';
  }
  if (id.startsWith('longcat')) {
    return 'opencode';
  }
  return 'other';
}

// models.dev metadata cache — deprecated models are filtered from /models menu
// and provider info is used for correct assignment
const MODELS_DEV_URL = 'https://models.dev/api.json';

interface ModelsDevInfo {
  status: string
  provider: string
}

async function fetchModelsDevMetadata(): Promise<Map<string, ModelsDevInfo>> {
  const metaMap = new Map<string, ModelsDevInfo>();
  try {
    const response = await fetch(MODELS_DEV_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      log.warn(`models.dev returned ${response.status}`);
      return metaMap;
    }
    const data = await response.json() as Record<string, unknown>;
    const oc = data.opencode as Record<string, unknown> | undefined;
    if (!oc || typeof oc !== 'object') {
      return metaMap;
    }
    const models = oc.models as Record<string, Record<string, unknown>> | undefined;
    if (!models || typeof models !== 'object') {
      return metaMap;
    }
    for (const [id, model] of Object.entries(models)) {
      const status = typeof model.status === 'string' ? model.status : 'active';
      // Use models.dev provider info if available (more accurate than owned_by)
      const providerInfo = model.provider as Record<string, unknown> | undefined;
      const npm = typeof providerInfo?.npm === 'string' ? providerInfo.npm : '';
      let provider = 'opencode';
      if (npm.includes('google')) {
        provider = 'google';
      }
      else if (npm.includes('anthropic')) {
        provider = 'anthropic';
      }
      else if (npm.includes('openai')) {
        provider = 'openai';
      }
      metaMap.set(id, { status, provider });
    }
    log.dim(`  models.dev: ${metaMap.size} model(s) metadata loaded`);
  }
  catch (e) {
    log.warn(`Failed to fetch models.dev metadata: ${(e as Error).message}`);
  }
  return metaMap;
}

async function fetchFromProvider(url: string, metaMap: Map<string, ModelsDevInfo>): Promise<ModelEntry[]> {
  try {
    const provider = detectProvider(url);
    // Build headers based on provider
    const headers: Record<string, string> = { Accept: 'application/json' };
    let fetchUrl = url;
    if (provider === 'anthropic') {
      const key = process.env.ANTHROPIC_API_KEY;
      if (key) {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
      }
    }
    else if (provider === 'openai-direct') {
      const key = process.env.OPENAI_API_KEY;
      if (key) {
        headers.Authorization = `Bearer ${key}`;
      }
    }
    else if (provider === 'deepseek') {
      const key = process.env.DEEPSEEK_API_KEY;
      if (key) {
        headers.Authorization = `Bearer ${key}`;
      }
    }
    else if (provider === 'kimi') {
      const key = process.env.KIMI_API_KEY;
      if (key) {
        headers.Authorization = `Bearer ${key}`;
      }
    }
    else if (provider === 'google') {
      const key = process.env.GOOGLE_API_KEY;
      if (key) {
        fetchUrl = `${url}?key=${key}`;
      }
    }
    const response = await fetch(fetchUrl, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      log.warn(`Provider ${provider} returned ${response.status}`);
      return [];
    }

    const data = await response.json() as Record<string, unknown>;
    const models: ModelEntry[] = [];

    // Anthropic API format: { data: [{ id, type, ... }] }
    if (provider === 'anthropic' && Array.isArray(data.data)) {
      for (const m of data.data as Record<string, unknown>[]) {
        if (typeof m.id !== 'string') {
          continue;
        }
        models.push({
          id: `anthropic/${m.id}`,
          name: typeof m.display_name === 'string' ? m.display_name : m.id,
          provider: 'anthropic',
          source: url,
          capabilities: inferCapabilities(m.id),
        });
      }
      return models;
    }

    // OpenAI API format: { data: [{ id, owned_by, ... }] }
    if (provider === 'openai-direct' && Array.isArray(data.data)) {
      for (const m of data.data as Record<string, unknown>[]) {
        if (typeof m.id !== 'string') {
          continue;
        }
        models.push({
          id: `openai/${m.id}`,
          name: typeof m.name === 'string' ? m.name : m.id,
          provider: 'openai',
          source: url,
          capabilities: inferCapabilities(m.id),
        });
      }
      return models;
    }

    // Google Gemini API format: { models: [{ name: "models/...", displayName, ... }] }
    if (provider === 'google' && Array.isArray(data.models)) {
      for (const m of data.models as Record<string, unknown>[]) {
        const name = typeof m.name === 'string' ? m.name : '';
        const rawId = name.replace('models/', '');
        if (!rawId) {
          continue;
        }
        const displayName = typeof m.displayName === 'string' ? m.displayName : rawId;
        models.push({
          id: `google/${rawId}`,
          name: displayName,
          provider: 'google',
          source: url,
          capabilities: inferCapabilities(rawId),
        });
      }
      return models;
    }

    // OpenAI-compatible format: { data: [{ id, owned_by, ... }] }
    if (Array.isArray(data.data)) {
      for (const m of data.data as Record<string, unknown>[]) {
        if (typeof m.id !== 'string') {
          continue;
        }
        const rawId = m.id;
        // Add provider prefix to match agent file format
        let id: string;
        if (provider === 'opencode-go') {
          id = `opencode-go/${rawId}`;
        }
        else if (provider === 'opencode') {
          id = `opencode/${rawId}`;
        }
        else if (provider === 'deepseek') {
          id = `deepseek/${rawId}`;
        }
        else if (provider === 'kimi') {
          id = `kimi/${rawId}`;
        }
        else {
          id = rawId;
        }
        const name = typeof m.name === 'string' ? m.name : rawId;
        // Use models.dev provider info if available (more accurate than owned_by)
        const meta = metaMap.get(rawId);
        const modelProvider = meta?.provider || (typeof m.owned_by === 'string' ? m.owned_by : provider);
        models.push({
          id,
          name,
          provider: modelProvider,
          source: url,
          capabilities: inferCapabilities(rawId),
        });
      }
    }
    // Custom flat format: [{ id, name, ... }]
    else if (Array.isArray(data)) {
      for (const m of data as Record<string, unknown>[]) {
        if (typeof m.id !== 'string') {
          continue;
        }
        models.push({
          id: m.id,
          name: typeof m.name === 'string' ? m.name : m.id,
          provider: typeof m.provider === 'string' ? m.provider : provider,
          source: url,
          capabilities: Array.isArray(m.capabilities) ? m.capabilities as string[] : inferCapabilities(m.id),
        });
      }
    }

    return models;
  }
  catch (e) {
    log.warn(`Failed to fetch from ${url}: ${(e as Error).message}`);
    return [];
  }
}

async function fetchModels(forceRefresh = false): Promise<ModelCatalog> {
  if (!forceRefresh) {
    const cached = loadCache();
    if (cached) {
      return cached;
    }
  }

  const urls = getCatalogUrls();
  log.info(`Fetching models from ${urls.length} provider(s)...`);

  // Fetch models.dev metadata to filter deprecated models and get provider info
  const metaMap = await fetchModelsDevMetadata();

  const allModels: ModelEntry[] = [];
  for (const url of urls) {
    const models = await fetchFromProvider(url, metaMap);
    allModels.push(...models);
    log.dim(`  ${detectProvider(url)}: ${models.length} model(s)`);
  }

  // Dedupe by ID
  const seen = new Set<string>();
  const deduped: ModelEntry[] = [];
  let deprecatedCount = 0;
  for (const m of allModels) {
    if (seen.has(m.id)) {
      continue;
    }
    // Check models.dev status — filter deprecated models (not in /models menu)
    const rawId = m.id.replace(/^(?:opencode-go|opencode)\//, '');
    const meta = metaMap.get(rawId);
    if (meta?.status === 'deprecated') {
      deprecatedCount++;
      continue;
    }
    seen.add(m.id);
    deduped.push(m);
  }

  if (deprecatedCount > 0) {
    log.dim(`  filtered ${deprecatedCount} deprecated model(s) via models.dev`);
  }

  const catalog: ModelCatalog = {
    models: deduped,
    fetchedAt: Date.now(),
    sources: urls,
  };

  saveCache(catalog);
  return catalog;
}

// ============================================================================
// INTERACTIVE SELECTION
// ============================================================================

async function selectModelForRole(
  role: QaRole,
  models: ModelEntry[],
  currentModel: string | null,
): Promise<string | null> {
  // Separate free tier models from paid models
  const zenFreeModels: ModelEntry[] = [];
  const paidModels: ModelEntry[] = [];
  for (const m of models) {
    if (m.source === 'https://opencode.ai/zen/v1/models' && m.id.endsWith('-free')) {
      zenFreeModels.push(m);
    }
    else {
      paidModels.push(m);
    }
  }

  // Group paid models by endpoint, then by underlying provider
  const byEndpoint: Record<string, Record<string, ModelEntry[]>> = {};
  for (const m of paidModels) {
    const endpoint = m.source || 'unknown';
    if (!byEndpoint[endpoint]) {
      byEndpoint[endpoint] = {};
    }
    const underlying = inferUnderlyingProvider(m.id);
    if (!byEndpoint[endpoint][underlying]) {
      byEndpoint[endpoint][underlying] = [];
    }
    byEndpoint[endpoint][underlying].push(m);
  }

  // Loop to allow searching again
  while (true) {
    // Ask for search filter first
    log.dim(`  ${models.length} models available. Type to filter, or press Enter to see all.\n`);
    const filter = await input({
      message: `Search models for ${role} (e.g. "gemini", "claude", "gpt")`,
    });
    const filterLower = filter.trim().toLowerCase();

    // Filter models if search term provided
    // Search in model ID and name only (not provider, which groups unrelated models)
    const filterModel = (m: ModelEntry): boolean => {
      if (!filterLower) { return true; }
      const searchStr = `${m.id} ${m.name || ''}`.toLowerCase();
      return filterLower.split(/\s+/).every((term) => {
        // Match whole words (surrounded by word boundaries or separators)
        const regex = new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`, 'i');
        return regex.test(searchStr);
      });
    };

    const filteredZenFreeModels = zenFreeModels.filter(filterModel);
    const filteredPaidModels = paidModels.filter(filterModel);

    // Re-group filtered paid models
    const filteredByEndpoint: Record<string, Record<string, ModelEntry[]>> = {};
    for (const m of filteredPaidModels) {
      const endpoint = m.source || 'unknown';
      if (!filteredByEndpoint[endpoint]) {
        filteredByEndpoint[endpoint] = {};
      }
      const underlying = inferUnderlyingProvider(m.id);
      if (!filteredByEndpoint[endpoint][underlying]) {
        filteredByEndpoint[endpoint][underlying] = [];
      }
      filteredByEndpoint[endpoint][underlying].push(m);
    }

    // Build choices with free tier first, then paid models
    const choices: (string | { value: string, name: string } | Separator)[] = [];

    // Add "back" option at the top
    choices.push({ value: '__back', name: '← back to roles' });
    choices.push(new Separator());

    // Free tier section (at the top)
    if (filteredZenFreeModels.length > 0) {
      choices.push(new Separator(`─ opencode zen free tier (${filteredZenFreeModels.length}) ─`));
      const byUnderlying: Record<string, ModelEntry[]> = {};
      for (const m of filteredZenFreeModels) {
        const underlying = inferUnderlyingProvider(m.id);
        if (!byUnderlying[underlying]) {
          byUnderlying[underlying] = [];
        }
        byUnderlying[underlying].push(m);
      }
      for (const [underlying, underModels] of Object.entries(byUnderlying)) {
        choices.push(new Separator(`  ${underlying}`));
        for (const m of underModels) {
          const marker = m.id === currentModel ? ' (current)' : '';
          choices.push({
            value: m.id,
            name: `    ${m.name || m.id}${marker}`,
          });
        }
      }
    }

    // Paid models by endpoint
    for (const [endpoint, providers] of Object.entries(filteredByEndpoint)) {
      const endpointName = detectProvider(endpoint);
      const displayName = endpointName === 'opencode' ? 'opencode zen' : endpointName;
      // Mask API keys in endpoint URL for security
      const maskedEndpoint = endpoint.replace(/([?&]key=)[^&]+/, '$1***');
      const totalCount = Object.values(providers).reduce((sum, arr) => sum + arr.length, 0);
      choices.push(new Separator(`─ ${displayName} (${totalCount}) ${maskedEndpoint} ─`));
      for (const [underlying, underModels] of Object.entries(providers)) {
        choices.push(new Separator(`  ${underlying}`));
        for (const m of underModels) {
          const marker = m.id === currentModel ? ' (current)' : '';
          choices.push({
            value: m.id,
            name: `    ${m.name || m.id}${marker}`,
          });
        }
      }
    }

    // Check if we have any results (model choices, not nav separators)
    const hasResults = filteredZenFreeModels.length > 0 || filteredPaidModels.length > 0;
    if (!hasResults) {
      log.warn(`No models matching "${filter.trim()}". Showing all models.`);
      continue;
    }

    const defaultChoice = undefined;

    const result = await select({
      message: `Model for ${role} — ${ROLE_DESCRIPTIONS[role]}`,
      choices: choices as any[],
      default: defaultChoice,
      loop: false,
    });

    // If user wants to go back, return null
    if (result === '__back') {
      return null;
    }

    return result;
  }
}

async function interactiveSelect(
  models: ModelEntry[],
  currentAssignment: Record<QaRole, string>,
  dryRun: boolean,
): Promise<Record<QaRole, string> | null> {
  log.header('QA Model Selector — interactive mode');
  log.dim(`${models.length} model(s) available from ${new Set(models.map(m => m.provider)).size} provider(s)\n`);

  const newAssignment = { ...currentAssignment };

  while (true) {
    // Show current assignments with role selection
    log.header('Current assignments');
    const choices: (string | { value: string, name: string } | Separator)[] = [];
    for (const role of QA_ROLES) {
      choices.push({
        value: role,
        name: `${role.padEnd(12)} ${colors.dim}${newAssignment[role]}${colors.reset}`,
      });
    }
    choices.push(new Separator());
    choices.push({ value: '__done', name: 'done — save assignments' });
    choices.push({ value: '__cancel', name: 'cancel — discard changes' });

    const selected = await select({
      message: 'Select a role to edit',
      choices,
      loop: false,
    });

    if (selected === '__done') {
      break;
    }

    if (selected === '__cancel') {
      log.warn('Cancelled. No changes saved.');
      return null;
    }

    // Edit the selected role
    const role = selected as QaRole;
    const current = newAssignment[role];
    const newModel = await selectModelForRole(role, models, current);
    // null means user went back, so we skip the update
    if (newModel !== null && newModel !== current) {
      newAssignment[role] = newModel;
    }
  }

  // Summary
  log.header('Assignment summary');
  for (const role of QA_ROLES) {
    const changed = newAssignment[role] !== currentAssignment[role];
    const marker = changed ? `${colors.green}*${colors.reset}` : ' ';
    err(`  ${marker} ${role.padEnd(12)} ${newAssignment[role]}`);
  }

  const proceed = await confirm({
    message: dryRun ? 'Show changes? (dry-run — nothing will be written)' : 'Save these assignments?',
    default: true,
  });

  if (!proceed) {
    log.warn('Cancelled. No changes saved.');
    return null;
  }

  return newAssignment;
}

// ============================================================================
// AGENT FILE UPDATES
// ============================================================================

function findAgentFiles(agentDir?: string): string[] {
  const files: string[] = [];
  const dirs = agentDir ? [agentDir] : HARNESS_DIRS;
  for (const dir of dirs) {
    const fullPath = join(REPO_ROOT, dir);
    if (!existsSync(fullPath)) { continue; }
    for (const role of QA_ROLES) {
      const file = join(fullPath, `${role}.md`);
      if (existsSync(file)) {
        files.push(file);
      }
    }
  }
  return files;
}

function updateModelInFile(filePath: string, newModel: string): boolean {
  const content = readFileSync(filePath, 'utf8');
  // Remove ALL existing model lines and add one new one
  const lines = content.split('\n');
  const newLines: string[] = [];
  let modelAdded = false;

  for (const line of lines) {
    if (line.startsWith('model:')) {
      if (!modelAdded) {
        newLines.push(`model: ${newModel}`);
        modelAdded = true;
      }
      // Skip duplicate model lines
    }
    else {
      newLines.push(line);
    }
  }

  // If no model line was found, insert after mode: subagent
  if (!modelAdded) {
    const insertedLines: string[] = [];
    for (const line of newLines) {
      insertedLines.push(line);
      if (line === 'mode: subagent') {
        insertedLines.push(`model: ${newModel}`);
        modelAdded = true;
      }
    }
    if (modelAdded) {
      writeFileSync(filePath, insertedLines.join('\n'), 'utf8');
      return true;
    }
    return false;
  }

  writeFileSync(filePath, newLines.join('\n'), 'utf8');
  return true;
}

function applyAssignment(
  assignment: Record<QaRole, string>,
  dryRun: boolean,
  partial = false,
  cli: ActiveCli = 'opencode',
): { updated: number, skipped: number, files: string[] } {
  const agentFiles = findAgentFiles(getAgentDirForCli(cli));
  let updated = 0;
  let skipped = 0;
  const changedFiles: string[] = [];

  for (const file of agentFiles) {
    const basename = relative(REPO_ROOT, file);
    const role = basename.split(sep).pop()?.replace('.md', '') as QaRole;

    if (!QA_ROLES.includes(role)) {
      skipped++;
      continue;
    }

    const catalogModel = assignment[role];
    if (!catalogModel) {
      // In partial mode, skip roles not in the assignment
      if (partial) {
        continue;
      }
      skipped++;
      continue;
    }
    const newModel = toHarnessModelId(cli, catalogModel);

    if (dryRun) {
      const content = readFileSync(file, 'utf8');
      const currentMatch = content.match(/^model: (.+)$/m);
      const currentModel = currentMatch?.[1]?.trim() ?? '(none)';
      if (currentModel !== newModel) {
        log.info(`DRY-RUN: ${basename} ${currentModel} -> ${newModel}`);
        changedFiles.push(basename);
      }
      else {
        log.dim(`UNCHANGED: ${basename} already on ${newModel}`);
      }
      updated++;
    }
    else {
      if (updateModelInFile(file, newModel)) {
        log.success(`${basename} -> ${newModel}`);
        changedFiles.push(basename);
        updated++;
      }
      else {
        log.warn(`SKIP: ${basename} — could not update`);
        skipped++;
      }
    }
  }

  return { updated, skipped, files: changedFiles };
}

// ============================================================================
// PREFS (save/load last assignment)
// ============================================================================

function loadPrefs(): Record<QaRole, string> | null {
  try {
    const data = JSON.parse(readFileSync(PREF_FILE, 'utf8')) as Record<string, string>;
    const result: Record<string, string> = {};
    for (const role of QA_ROLES) {
      if (data[role]) { result[role] = data[role]; }
    }
    return Object.keys(result).length > 0 ? result as Record<QaRole, string> : null;
  }
  catch {
    return null;
  }
}

function savePrefs(assignment: Record<QaRole, string>): void {
  writeFileSync(PREF_FILE, JSON.stringify(assignment, null, 2), 'utf8');
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const flags = parseArgs(process.argv);

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  // Detect active CLI
  const activeCli = detectActiveCli();
  const agentDir = getAgentDirForCli(activeCli);

  log.header(`QA Model Selector — ${activeCli}`);
  log.dim(`Agent directory: ${agentDir}\n`);

  // Fetch models
  const catalog = await fetchModels(flags.refresh);

  if (catalog.models.length === 0) {
    log.warn('No models fetched. Check your API keys in .env and run --refresh.');
  }

  // Filter models based on CLI
  const availableModels = filterModelsForCli(catalog.models, activeCli);
  log.dim(`${availableModels.length} model(s) compatible with ${activeCli}\n`);

  // List mode
  if (flags.list) {
    log.header('Available models by endpoint');

    // Group by source endpoint, separating OpenCode Zen free tier
    const bySource: Record<string, ModelEntry[]> = {};
    const zenFreeModels: ModelEntry[] = [];
    for (const m of availableModels) {
      const source = m.source || 'unknown';
      // Separate OpenCode Zen free tier models
      if (source === 'https://opencode.ai/zen/v1/models' && m.id.endsWith('-free')) {
        zenFreeModels.push(m);
        continue;
      }
      if (!bySource[source]) {
        bySource[source] = [];
      }
      bySource[source].push(m);
    }

    for (const [url, models] of Object.entries(bySource)) {
      if (models.length === 0) {
        continue;
      }
      const provider = detectProvider(url);
      // Rename opencode to opencode zen for display
      const displayName = provider === 'opencode' ? 'opencode zen' : provider;
      // Mask API keys in URL for security
      const maskedUrl = url.replace(/([?&]key=)[^&]+/, '$1***');
      err(`\n  ${colors.bold}${colors.cyan}${displayName}${colors.reset} ${colors.dim}(${maskedUrl})${colors.reset}`);
      err(`  ${colors.dim}${'─'.repeat(60)}${colors.reset}`);

      // Sub-group by underlying provider (anthropic, openai, google, etc.)
      const byUnderlying: Record<string, ModelEntry[]> = {};
      for (const m of models) {
        const underlying = inferUnderlyingProvider(m.id);
        if (!byUnderlying[underlying]) {
          byUnderlying[underlying] = [];
        }
        byUnderlying[underlying].push(m);
      }

      for (const [underlying, underModels] of Object.entries(byUnderlying)) {
        err(`    ${colors.bold}${underlying}${colors.reset} ${colors.dim}(${underModels.length})${colors.reset}`);
        for (const m of underModels) {
          err(`      ${m.id}`);
        }
      }
    }

    // Display OpenCode Zen free tier models as separate section
    if (zenFreeModels.length > 0) {
      err(`\n  ${colors.bold}${colors.cyan}opencode zen free tier${colors.reset} ${colors.dim}(https://opencode.ai/zen/v1/models)${colors.reset}`);
      err(`  ${colors.dim}${'─'.repeat(60)}${colors.reset}`);
      // Sub-group by underlying provider
      const byUnderlying: Record<string, ModelEntry[]> = {};
      for (const m of zenFreeModels) {
        const underlying = inferUnderlyingProvider(m.id);
        if (!byUnderlying[underlying]) {
          byUnderlying[underlying] = [];
        }
        byUnderlying[underlying].push(m);
      }
      for (const [underlying, underModels] of Object.entries(byUnderlying)) {
        err(`    ${colors.bold}${underlying}${colors.reset} ${colors.dim}(${underModels.length})${colors.reset}`);
        for (const m of underModels) {
          err(`      ${m.id}`);
        }
      }
    }

    err(`\n  ${colors.dim}Total: ${availableModels.length} model(s) compatible with ${activeCli}${colors.reset}`);
    process.exit(0);
  }

  // Load current assignment from agent files, then prefs
  const currentAssignment: Record<QaRole, string> = {} as Record<QaRole, string>;

  // Read actual models from agent files (only from the active CLI's directory)
  for (const role of QA_ROLES) {
    const file = join(REPO_ROOT, agentDir, `${role}.md`);
    if (!existsSync(file)) {
      continue;
    }
    try {
      const content = readFileSync(file, 'utf8');
      const match = content.match(/^model: (.+)$/m);
      if (match) {
        currentAssignment[role] = match[1].trim();
      }
    }
    catch {
      /* skip */
    }
  }

  // Prefs override
  const saved = loadPrefs();
  if (saved) {
    Object.assign(currentAssignment, saved);
  }

  // Validate assigned models against available models
  const availableModelIds = new Set(availableModels.map(m => m.id));
  const invalidRoles: QaRole[] = [];
  for (const role of QA_ROLES) {
    const assigned = currentAssignment[role];
    if (assigned && !availableModelIds.has(assigned)) {
      invalidRoles.push(role);
      log.warn(`Model "${assigned}" for ${role} no longer available in ${activeCli}`);
      delete currentAssignment[role];
    }
  }

  if (invalidRoles.length > 0) {
    log.info(`${invalidRoles.length} role(s) have invalid models. Re-select in interactive mode.`);
  }

  // Non-interactive: single role + model
  if (flags.role && flags.model) {
    const role = flags.role as QaRole;
    if (!QA_ROLES.includes(role)) {
      log.error(`Invalid role: ${role}. Valid: ${QA_ROLES.join(', ')}`);
      process.exit(1);
    }
    const singleAssignment = { [role]: flags.model } as Record<QaRole, string>;
    applyAssignment(singleAssignment, flags.dryRun, true, activeCli);
    savePrefs({ ...currentAssignment, [role]: flags.model });
    log.success(flags.dryRun ? 'Dry run complete.' : 'Assignment saved.');
    process.exit(0);
  }

  // Interactive mode
  if (!process.stdin.isTTY) {
    log.error('Non-TTY detected. Use --role/--model or --list.');
    process.exit(1);
  }

  const newAssignment = await interactiveSelect(availableModels, currentAssignment, flags.dryRun);
  if (!newAssignment) {
    process.exit(0);
  }

  applyAssignment(newAssignment, flags.dryRun, false, activeCli);
  savePrefs(newAssignment);
  log.success(flags.dryRun ? 'Dry run complete.' : 'Assignments saved.');
}

try {
  if (import.meta.main) {
    void main();
  }
}
catch (error) {
  console.error('Unexpected error:', (error as Error).message);
  process.exit(1);
}

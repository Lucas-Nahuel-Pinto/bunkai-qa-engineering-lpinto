#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { input, select } from '@inquirer/prompts';

// =========== TYPES ============
interface McpServer {
  type?: string
  url?: string
  command?: string | string[]
  args?: string[]
  headers?: Record<string, string>
  env?: Record<string, string>
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

interface McpCatalog {
  mcpServers?: Record<string, McpServer>
  mcp?: Record<string, McpServer>
}

interface OpencodeServer {
  type: string
  url?: string
  command?: string | string[]
  environment?: Record<string, string>
  headers?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

// ============ CONFIGURACION (env lazy — no side-effect at import) ============

function getMcpCatalogFile(): string {
  const file = process.env.MCP_CATALOG_FILE;
  if (!file) {
    console.error('Falta variable de entorno: MCP_CATALOG_FILE (ver .env)');
    process.exit(1);
  }
  return path.isAbsolute(file) ? file : path.join(process.cwd(), file);
}

// Soporte para multiples archivos separados por coma.
// Escribe SOLO a archivos locales gitignored (*.local.*) — nunca a los
// commiteados (.mcp.json / opencode.jsonc / .codex/config.toml), que son el
// inventario curado por el equipo y no deben regenerarse por sesion.
function getMcpFiles(): string[] {
  const files = process.env.MCP_FILE;
  if (!files) {
    console.error('Falta variable de entorno: MCP_FILE (ver .env)');
    process.exit(1);
  }
  return files.split(',').map(f => f.trim()).filter(Boolean).map(f =>
    path.isAbsolute(f) ? f : path.join(process.cwd(), f),
  );
}

const PREF_FILE = path.join(process.cwd(), '.selected-mcps-kit');

function loadPreference(): string | null {
  try {
    return fs.readFileSync(PREF_FILE, 'utf8').trim();
  }
  catch {
    return null;
  }
}

function savePreference(profile: string): void {
  fs.writeFileSync(PREF_FILE, profile, 'utf8');
}

export function clearPreference(): void {
  if (fs.existsSync(PREF_FILE)) {
    fs.unlinkSync(PREF_FILE);
  }
}

// Perfiles predefinidos para QA Engineering
export const PROFILES: Record<string, string[] | 'ALL'> = {
  // QA core: docs + search (siempre util)
  base: ['context7', 'tavily'],

  // E2E testing: browser + docs
  e2e: ['playwright', 'context7'],

  // API testing: openapi + docs
  api: ['openapi', 'context7', 'tavily'],

  // Database testing: dbhub + docs
  db: ['dbhub', 'context7'],

  // Full stack: browser + API + DB + docs
  fullstack: ['playwright', 'openapi', 'dbhub', 'context7', 'tavily'],

  // Sprint testing: browser + API + DB + docs + search
  sprint: ['playwright', 'openapi', 'dbhub', 'context7', 'tavily'],

  // Regression: everything except postman
  regression: ['playwright', 'openapi', 'dbhub', 'context7', 'tavily'],

  // Report / CI: github + slack (via postman remote)
  report: ['postman', 'context7'],

  // Todos los MCPs del catalogo
  full: 'ALL',
};

// ============ TOML SERIALIZER ============

interface TomlSection {
  header?: string
  table: string
  entries: Record<string, unknown>
}

function tomlValue(val: string | number | boolean): string {
  if (typeof val === 'boolean') {
    return val ? 'true' : 'false';
  }
  if (typeof val === 'number') {
    return String(val);
  }
  return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlArray(arr: string[]): string {
  if (arr.length === 0) {
    return '[]';
  }
  if (arr.length === 1) {
    return `[${tomlValue(arr[0])}]`;
  }
  const items = arr.map(item => `  ${tomlValue(item)},`).join('\n');
  return `[\n${items}\n]`;
}

function serializeToml(sections: TomlSection[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    if (section.header) {
      lines.push(`# ${section.header}`);
    }
    lines.push(`[${section.table}]`);
    for (const [key, value] of Object.entries(section.entries)) {
      if (Array.isArray(value)) {
        lines.push(`${key} = ${tomlArray(value as string[])}`);
      }
      else {
        lines.push(`${key} = ${tomlValue(value as string | number | boolean)}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ============ CONVERSION ============

function claudeToCodexToml(filteredMcps: Record<string, McpServer>): string {
  const sections: TomlSection[] = [];

  // Header block (static, Codex-specific)
  sections.push({
    header: 'Codex CLI + Desktop read this same file. The MCP inventory below is the Codex-format adapter.',
    table: 'shell_environment_policy',
    entries: { inherit: 'core' },
  });

  for (const [name, server] of Object.entries(filteredMcps)) {
    const entries: Record<string, unknown> = {};

    // url (remote servers)
    if (server.url) {
      entries.url = server.url;
    }

    // command + args
    if (Array.isArray(server.command)) {
      entries.command = server.command[0];
      if (server.command.length > 1 || server.args) {
        entries.args = [...server.command.slice(1), ...(server.args || [])];
      }
    }
    else if (server.command) {
      entries.command = server.command;
      if (server.args) {
        entries.args = server.args;
      }
    }

    // bearer_token_env_var (from Authorization: Bearer ${VAR} header)
    if (server.headers?.Authorization) {
      const match = server.headers.Authorization.match(/\$\{(\w+)\}/);
      if (match) {
        entries.bearer_token_env_var = match[1];
      }
    }

    // env_vars (array of keys from env object)
    const env = server.env || server.environment;
    if (env && typeof env === 'object' && Object.keys(env).length > 0) {
      entries.env_vars = Object.keys(env);
    }

    // enabled
    if (server.enabled !== undefined) {
      entries.enabled = server.enabled;
    }

    sections.push({
      table: `mcp_servers.${name}`,
      entries,
    });
  }

  return serializeToml(sections);
}

// ============ FUNCIONES ============

export function loadCatalog(): McpCatalog {
  const mcpCatalogFile = getMcpCatalogFile();

  if (!fs.existsSync(mcpCatalogFile)) {
    console.error(`No encontre ${mcpCatalogFile}`);
    console.error('Crea el archivo con tus MCPs disponibles (ver .env.example)');
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(mcpCatalogFile, 'utf8');
    return JSON.parse(content);
  }
  catch (error) {
    console.error(`Error al leer ${mcpCatalogFile}:`, (error as Error).message);
    process.exit(1);
  }
}

async function parseArgs(catalog: McpCatalog): Promise<string[]> {
  const args = process.argv.slice(2);

  // Sin argumentos en terminal interactiva: selector
  if (args.length === 0) {
    if (!process.stdin.isTTY) {
      printUsage();
      process.exit(0);
    }
    return interactiveSelect(catalog);
  }

  return resolveProfile(args[0], catalog);
}

async function interactiveSelect(catalog: McpCatalog): Promise<string[]> {
  const saved = loadPreference();
  const profileNames = Object.keys(PROFILES);

  const choice = await select({
    message: 'Selecciona tu perfil:',
    default: saved && PROFILES[saved] ? saved : undefined,
    loop: false,
    choices: [
      ...profileNames.map((name) => {
        const mcps = PROFILES[name];
        const desc = mcps === 'ALL'
          ? 'todos los MCPs del catalogo'
          : Array.isArray(mcps) ? mcps.join(', ') : mcps;
        return { value: `profile:${name}`, name: `${name} — ${desc}` };
      }),
      { value: 'custom', name: 'Seleccionar MCPs manualmente...' },
    ],
  });

  if (choice === 'custom') {
    const customInput = await input({
      message: 'Escribe los MCPs separados por coma:',
    });
    const mcps = customInput.split(',').map(m => m.trim()).filter(Boolean);
    return resolveMcps(mcps, catalog);
  }

  const profile = choice.replace('profile:', '');
  savePreference(profile);
  return resolveProfile(profile, catalog);
}

export function resolveProfile(input: string, catalog: McpCatalog): string[] {
  if (input === 'full') {
    const allMcps = Object.keys(catalog.mcpServers || catalog.mcp || {});
    console.log('\nADVERTENCIA: Usando perfil "full"');
    console.log(`Esto carga TODOS los MCPs disponibles (${allMcps.length} total)`);
    console.log('Consume muchos tokens. Considera perfiles especificos (e2e, api, db)');
    return allMcps;
  }

  if (PROFILES[input]) {
    const profile = PROFILES[input];
    if (profile === 'ALL') {
      return Object.keys(catalog.mcpServers || catalog.mcp || {});
    }
    return profile;
  }

  // Si no es perfil, tratar como MCPs separados por coma
  const mcps = input.split(',').map(m => m.trim());
  return resolveMcps(mcps, catalog);
}

function resolveMcps(mcps: string[], catalog: McpCatalog): string[] {
  const catalogMcps = catalog.mcpServers || catalog.mcp || {};
  const invalid = mcps.filter(m => !catalogMcps[m]);
  if (invalid.length > 0) {
    console.error('MCPs invalidos:', invalid.join(', '));
    console.log('\nMCPs disponibles:', Object.keys(catalogMcps).join(', '));
    console.log('\nPerfiles:', Object.keys(PROFILES).join(', '));
    process.exit(1);
  }
  return mcps;
}

// Convertir formato Claude Code (.mcp.json) a OpenCode (opencode.jsonc)
function claudeToOpencode(claudeConfig: { mcpServers?: Record<string, McpServer> }): { mcp: Record<string, OpencodeServer> } {
  const mcp: Record<string, OpencodeServer> = {};

  Object.entries(claudeConfig.mcpServers || {}).forEach(([name, server]) => {
    const entry: OpencodeServer = { type: '' };

    if (server.type === 'http') {
      entry.type = 'remote';
      entry.url = server.url;
      if (server.headers) {
        entry.headers = {};
        Object.entries(server.headers).forEach(([key, value]) => {
          // Convertir ${VAR} a {env:VAR} para OpenCode
          entry.headers![key] = value.replace(/\$\{(\w+)\}/g, '{env:$1}');
        });
      }
    }
    else if (server.type === 'sse') {
      entry.type = 'remote';
      entry.url = server.url;
    }
    else {
      // stdio
      entry.type = 'local';
      if (Array.isArray(server.command)) {
        entry.command = server.command;
      }
      else if (server.command) {
        entry.command = server.command;
      }
      if (server.args) {
        entry.command = entry.command
          ? [...(Array.isArray(entry.command) ? entry.command : [entry.command]), ...server.args]
          : server.args;
      }
    }

    const env = server.env || server.environment;
    if (env && typeof env === 'object') {
      entry.environment = {};
      Object.entries(env).forEach(([key, value]) => {
        // Convertir ${VAR} a {env:VAR} para OpenCode
        entry.environment![key] = String(value).replace(/\$\{(\w+)\}/g, '{env:$1}');
      });
    }

    if (server.headers && !entry.headers) {
      entry.headers = {};
      Object.entries(server.headers).forEach(([key, value]) => {
        entry.headers![key] = value.replace(/\$\{(\w+)\}/g, '{env:$1}');
      });
    }

    if (server.enabled !== undefined) {
      entry.enabled = server.enabled;
    }

    if (server.timeout !== undefined) {
      entry.timeout = server.timeout;
    }

    mcp[name] = entry;
  });

  return { mcp };
}

export function generateMcpJson(selectedMcps: string[], catalog: McpCatalog, silent = false): void {
  const catalogMcps = catalog.mcpServers || catalog.mcp || {};

  // Construir config con solo los seleccionados
  const filteredMcps: Record<string, McpServer> = {};
  selectedMcps.forEach((name) => {
    filteredMcps[name] = catalogMcps[name];
  });

  // Generar para cada archivo local (siempre escribe completo — son regenerables)
  getMcpFiles().forEach((mcpFile) => {
    const isOpencodeFormat = mcpFile.includes('opencode');
    const isCodexFormat = mcpFile.endsWith('.toml');

    let content: string;
    if (isCodexFormat) {
      content = claudeToCodexToml(filteredMcps);
    }
    else if (isOpencodeFormat) {
      const config = { mcp: catalog.mcpServers ? claudeToOpencode({ mcpServers: filteredMcps }).mcp : filteredMcps };
      content = JSON.stringify(config, null, 2);
    }
    else {
      content = JSON.stringify({ mcpServers: filteredMcps }, null, 2);
    }

    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    fs.writeFileSync(mcpFile, content, 'utf8');

    if (!silent) {
      const format = isCodexFormat ? 'Codex' : isOpencodeFormat ? 'OpenCode' : 'Claude Code';
      console.log(`  ${path.basename(mcpFile)} (${format} format)`);
    }
  });
}

export function printUsage(): void {
  console.log('Uso: bun run mcps-kit <perfil | mcp1,mcp2,...>\n');
  console.log('Perfiles:');
  Object.entries(PROFILES).forEach(([name, mcps]) => {
    const desc = mcps === 'ALL'
      ? 'todos los MCPs del catalogo'
      : Array.isArray(mcps) ? mcps.join(', ') : mcps;
    console.log(`  ${name.padEnd(12)} ${desc}`);
  });
  console.log('\nEjemplos:');
  console.log('  bun run mcps-kit e2e           # playwright + context7');
  console.log('  bun run mcps-kit api           # openapi + context7 + tavily');
  console.log('  bun run mcps-kit db            # dbhub + context7');
  console.log('  bun run mcps-kit fullstack     # playwright + openapi + dbhub + context7 + tavily');
  console.log('  bun run mcps-kit openapi,tavily # MCPs especificos por nombre');
}

// ============ MAIN ============
async function main(): Promise<void> {
  const catalog = loadCatalog();
  const selectedMcps = await parseArgs(catalog);

  generateMcpJson(selectedMcps, catalog);
}

try {
  if (import.meta.main) {
    void main();
  }
}
catch (error) {
  console.error('Error inesperado:', (error as Error).message);
  process.exit(1);
}

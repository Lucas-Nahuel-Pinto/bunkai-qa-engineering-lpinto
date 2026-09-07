#!/usr/bin/env bun
import { clearPreference, generateMcpJson, loadCatalog, resolveProfile } from './mcp-builder.ts';

const BASE_PROFILE = 'base';

clearPreference();

const catalog = loadCatalog();
const selectedMcps = resolveProfile(BASE_PROFILE, catalog);

generateMcpJson(selectedMcps, catalog, true);

process.exit(0);

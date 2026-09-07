#!/usr/bin/env bun
import { PROFILES } from './mcp-builder.ts';

const BASE_PROFILE = 'base';
const baseMcps = PROFILES[BASE_PROFILE];
const desc = Array.isArray(baseMcps) ? baseMcps.join(', ') : 'todos los MCPs';

console.log('\nKit de MCPs\n');
console.log('1. Ejecuta "bun run mcps-kit" en terminal para abrir el menú interactivo.\n');
console.log('2. Elige un perfil para cargar únicamente los MCPs necesarios.');
console.log(`\nPerfil Predeterminado: "${BASE_PROFILE} - (${desc})".\n`);

process.exit(0);

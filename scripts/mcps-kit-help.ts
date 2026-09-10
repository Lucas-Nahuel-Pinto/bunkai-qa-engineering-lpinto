#!/usr/bin/env bun
import { PROFILES } from './mcp-builder.ts';

const BASE_PROFILE = 'base';
const baseMcps = PROFILES[BASE_PROFILE];
const desc = Array.isArray(baseMcps) ? baseMcps.join(', ') : 'todos los MCPs';

const W = 65;
const line = (s: string) => `│${s.padEnd(W)}│`;

console.log('');
console.log(`┌${'─'.repeat(W)}┐`);
console.log(line('  Kit de MCPs'));
console.log(`├${'─'.repeat(W)}┤`);
console.log(line('  1. "bun run mcps-kit" → menú interactivo'));
console.log(line('  2. Elegí un perfil para cargar únicamente los MCPs necesarios.'));
console.log(`├${'─'.repeat(W)}┤`);
console.log(line(`  Perfil default: ${BASE_PROFILE} (${desc})`));
console.log(`└${'─'.repeat(W)}┘`);
console.log('');

process.exit(0);

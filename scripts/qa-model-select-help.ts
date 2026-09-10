#!/usr/bin/env bun

const W = 70;
const line = (s: string) => `│${s.padEnd(W)}│`;

console.log('');
console.log(`┌${'─'.repeat(W)}┐`);
console.log(line('  Selector de Modelos de IA para cada Rol'));
console.log(`├${'─'.repeat(W)}┤`);
console.log(line('  1. "bun run qa-role:model:select" → menú interactivo'));
console.log(line('  2. Seleccioná el rol al que le quieras cambiar el modelo de IA'));
console.log(line('  3. Buscá el modelo por nombre o proveedor para filtrar'));
console.log(`├${'─'.repeat(W)}┤`);
console.log(line('  Cada subagente es despachado con su rol correspondiente.'));
console.log(line('  Roles: qa-plan, qa-code, qa-review, qa-bulk, qa-write, qa-vision'));
console.log(`└${'─'.repeat(W)}┘`);
console.log('');

process.exit(0);

#!/usr/bin/env node
/**
 * Reproduces exactly how opencode spawns MCP servers on Windows.
 *
 * Usage:
 *   node scripts/test-mcp-handshake.mjs overlapped    # single server, overlapped stdio
 *   node scripts/test-mcp-handshake.mjs pipe          # single server, pipe stdio
 *   node scripts/test-mcp-handshake.mjs concurrent    # all 7 MCPs at once (like opencode)
 */

import { spawn } from 'node:child_process';

const mode = process.argv[2] || 'overlapped';

const MCP_SERVERS = {
  dbhub: ['bunx', '-y', '@bytebase/dbhub@1.2.1', '--config', 'dbhub.toml'],
  context7: ['bunx', '-y', '@upstash/context7-mcp'],
  playwright: ['bunx', '@playwright/mcp@0.0.79', '--caps', 'vision,pdf,testing,tracing,tabs'],
  tavily: ['bunx', '-y', 'mcp-remote', `https://mcp.tavily.com/mcp/?tavilyApiKey=${process.env.TAVILY_API_KEY}`],
  openapi: ['bunx', '-y', '@ivotoby/openapi-mcp-server', '--tools', 'dynamic'],
};

const INIT_REQUEST = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
})}\n`;

function spawnOne(name, cmd, args, stdioMode) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(cmd, args, {
      stdio: [stdioMode, stdioMode, 'pipe'],
      env: { ...process.env },
      shell: false,
    });

    let stderr = '';
    let stdout = '';
    let resolved = false;

    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (resolved) { return; }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.jsonrpc === '2.0' && parsed.id === 1) {
          resolved = true;
          resolve({ name, ok: true, ms: Date.now() - start, serverInfo: parsed.result?.serverInfo, stderr });
          child.kill();
        }
      }
      catch {}
    });

    child.on('error', (err) => {
      if (!resolved) { resolved = true; resolve({ name, ok: false, ms: Date.now() - start, error: err.message, stderr }); }
    });

    child.on('close', (code, signal) => {
      if (!resolved) { resolved = true; resolve({ name, ok: false, ms: Date.now() - start, code, signal, stderr: stderr.slice(-200) }); }
    });

    // Send initialize immediately
    child.stdin.write(INIT_REQUEST);

    // 30s timeout
    setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ name, ok: false, ms: Date.now() - start, error: 'TIMEOUT', stderr: stderr.slice(-200) }); child.kill(); }
    }, 30_000);
  });
}

async function main() {
  if (mode === 'concurrent') {
    console.log(`\n=== Concurrent MCP Spawn Test (all ${Object.keys(MCP_SERVERS).length} servers) ===\n`);
    const start = Date.now();
    const results = await Promise.all(
      Object.entries(MCP_SERVERS).map(([name, args]) => {
        const [cmd, ...rest] = args;
        return spawnOne(name, cmd, rest, 'overlapped');
      }),
    );
    const elapsed = Date.now() - start;
    console.log(`\nAll done in ${elapsed}ms\n`);
    for (const r of results) {
      const icon = r.ok ? '✅' : '❌';
      const detail = r.ok ? `${r.serverInfo?.name}@${r.serverInfo?.version}` : (r.error || `exit ${r.code}`);
      console.log(`  ${icon} ${r.name.padEnd(14)} ${r.ms}ms  ${detail}`);
      if (!r.ok && r.stderr) { console.log(`     stderr: ${r.stderr.slice(0, 120)}`); }
    }
    const failed = results.filter(r => !r.ok);
    process.exit(failed.length > 0 ? 1 : 0);
  }
  else {
    // Single server mode
    const stdioMode = mode === 'overlapped' ? 'overlapped' : 'pipe';
    const [cmd, ...args] = MCP_SERVERS.dbhub;
    console.log(`\n=== Single MCP Handshake (${stdioMode} mode) ===`);
    console.log(`Command: ${cmd} ${args.join(' ')}\n`);
    const result = await spawnOne('dbhub', cmd, args, stdioMode);
    if (result.ok) {
      console.log(`\n✅ ${result.serverInfo?.name}@${result.serverInfo?.version} responded in ${result.ms}ms`);
      console.log(`\nStderr:\n${result.stderr}`);
      process.exit(0);
    }
    else {
      console.log(`\n❌ Failed: ${result.error || `exit ${result.code}`}`);
      console.log(`\nStderr:\n${result.stderr}`);
      process.exit(1);
    }
  }
}

main();

#!/usr/bin/env bun

// Bootstrap the homebrew-supplied sqlite for sqlite-vec on macOS.
// Must run before any `new Database(...)` call. Idempotent.
import { Database } from 'bun:sqlite';
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded or not available */ }

import { rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInit } from '../../cli/src/commands/init.js';
import { runStart } from '../../cli/src/commands/start.js';
import { runStop } from '../../cli/src/commands/stop.js';

interface Args {
  sandbox?: string;
  persist: boolean;
  mcpConfigOnly: boolean;
  pretty: boolean;
  noTail: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { persist: false, mcpConfigOnly: false, pretty: process.stdout.isTTY ?? false, noTail: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--sandbox': out.sandbox = argv[++i]; break;
      case '--persist': out.persist = true; break;
      case '--mcp-config-only': out.mcpConfigOnly = true; break;
      case '--pretty': out.pretty = true; break;
      case '--no-tail': out.noTail = true; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`usage: penumbra-harness [options]

  --sandbox <path>          Reuse an existing storage root.
  --persist                 Keep the sandbox dir on exit.
  --mcp-config-only         Print the MCP config snippet for an existing
                            sandbox (--sandbox required), then exit.
  --pretty                  Pretty-print JSON log lines.
  --no-tail                 Don't tail logs after starting.
  -h, --help                Print this help.`);
}

function findRepoRoot(): string {
  // bin/penumbra-harness.ts → ../../.. = repo root
  const here = new URL('.', import.meta.url).pathname;
  return resolve(here, '..', '..', '..');
}

function mcpBinPath(): string {
  return join(findRepoRoot(), 'packages/mcp/bin/penumbra-mcp.ts');
}

function printMcpConfig(sandbox: string, port: number): void {
  const config = {
    mcpServers: {
      penumbra: {
        type: 'stdio',
        command: 'bun',
        args: [mcpBinPath()],
        env: {
          PENUMBRA_STORAGE_ROOT: sandbox,
        },
      },
    },
  };
  console.log('');
  console.log('=== Claude Code MCP config (paste into your .mcp.json) ===');
  console.log(JSON.stringify(config, null, 2));
  console.log('');
  console.log(`(daemon listening on http://127.0.0.1:${port}; storage root: ${sandbox})`);
  console.log('');
}

async function runMcpConfigOnly(args: Args): Promise<number> {
  if (!args.sandbox) {
    console.error('--mcp-config-only requires --sandbox <path>');
    return 1;
  }
  const portRaw = readFileSync(join(args.sandbox, 'port'), 'utf8').trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port)) {
    console.error(`port file ${join(args.sandbox, 'port')} is not a valid port: ${portRaw}`);
    return 1;
  }
  printMcpConfig(args.sandbox, port);
  return 0;
}

async function runDefault(args: Args): Promise<number> {
  const userProvidedSandbox = !!args.sandbox;
  const sandbox = args.sandbox ?? mkdtempSync(join(tmpdir(), 'penumbra-harness-'));
  let stopping = false;
  let cleanedUp = false;

  await runInit({ storageRoot: sandbox });
  const handle = await runStart({ storageRoot: sandbox });
  printMcpConfig(sandbox, handle.port);

  if (!args.noTail) {
    console.log('Tailing daemon log. Press Ctrl-C to stop.');
  }

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { await runStop({ storageRoot: sandbox, handle }); } catch (err) {
      console.error(`runStop error: ${(err as Error).message}`);
    }
    if (!args.persist && !userProvidedSandbox) {
      try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  };

  const onSignal = async (sig: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${sig} received; shutting down...`);
    await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', () => { void onSignal('SIGINT'); });
  process.on('SIGTERM', () => { void onSignal('SIGTERM'); });

  // Block forever; signals drive exit.
  await new Promise<never>(() => {});
  return 0;
}

const args = parseArgs(process.argv);
if (args.help) { printHelp(); process.exit(0); }
if (args.mcpConfigOnly) {
  process.exit(await runMcpConfigOnly(args));
}
process.exit(await runDefault(args));

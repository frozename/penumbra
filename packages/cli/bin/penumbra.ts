#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { Branding, resolveDaemonStorageRoot } from '@penumbra/core';

// Bootstrap the homebrew-supplied sqlite for sqlite-vec on macOS.
// Must run before any `new Database(...)` call. Idempotent.
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded or not available */ }
import { runInit } from '../src/commands/init.js';
import { runStart, runStartDetached } from '../src/commands/start.js';
import { runStop } from '../src/commands/stop.js';
import { runStatus } from '../src/commands/status.js';
import { runExport } from '../src/commands/export.js';
import { runImport } from '../src/commands/import.js';
import { runRepair } from '../src/commands/repair.js';
import { runTail } from '../src/commands/tail.js';
import { runRecent } from '../src/commands/recent.js';
import { runRecall } from '../src/commands/recall.js';
import { runHook } from '../src/commands/hook.js';

const cmd = process.argv[2];
let root = process.env.PENUMBRA_STORAGE_ROOT ?? Branding.storageRoot;

switch (cmd) {
  case 'init':
    process.exit(await runInit({ storageRoot: root }));
  case 'start': {
    const detach = process.argv.includes('--detach') || process.argv.includes('-d');
    if (detach) {
      try {
        const r = await runStartDetached({ storageRoot: root });
        console.log(`penumbra: detached on http://127.0.0.1:${r.port} (pid=${r.pid}); logs at ${r.logPath}`);
        process.exit(0);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    const handle = await runStart({ storageRoot: root });
    let stopping = false;
    const onSignal = async () => {
      if (stopping) return;
      stopping = true;
      await runStop({ storageRoot: root, handle });
      process.exit(0);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    console.log(`penumbra: running on http://127.0.0.1:${handle.port} (pid=${process.pid}). Ctrl-C to stop.`);
    await new Promise<never>(() => {}); // block forever; signals drive exit
    process.exit(0);
  }
  case 'stop':
    process.exit(await runStop({ storageRoot: root }));
  case 'status': {
    const s = await runStatus({ storageRoot: root });
    console.log(JSON.stringify(s, null, 2));
    process.exit(s.status === 'running' ? 0 : 2);
  }
  case 'export': {
    const outPath = process.argv[3] ?? join(root, 'export.jsonl');
    const projectFlagIdx = process.argv.indexOf('--project');
    const project = projectFlagIdx >= 0 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
    const dbPath = join(root, 'db.sqlite');
    process.exit(await runExport({ dbPath, project, outPath }));
  }
  case 'import': {
    const inPath = process.argv[3];
    if (!inPath) { console.error('usage: penumbra import <file.jsonl>'); process.exit(1); }
    const dbPath = join(root, 'db.sqlite');
    process.exit(await runImport({ dbPath, inPath }));
  }
  case 'repair': {
    const r = await runRepair({ storageRoot: root });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.outcome === 'failed' ? 2 : 0);
  }
  case 'tail': {
    const projectFlagIdx = process.argv.indexOf('--project');
    const project = projectFlagIdx >= 0 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
    const limitFlagIdx = process.argv.indexOf('--limit');
    const limit = limitFlagIdx >= 0 ? Number(process.argv[limitFlagIdx + 1]) : 20;
    if (!Number.isInteger(limit) || limit < 1) {
      console.error('penumbra tail: --limit must be a positive integer');
      process.exit(1);
    }
    const dbPath = join(root, 'db.sqlite');
    const rows = runTail({ dbPath, project, limit });
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  }
  case 'recent': {
    const projectFlagIdx = process.argv.indexOf('--project');
    const project = projectFlagIdx >= 0 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
    const limitFlagIdx = process.argv.indexOf('--limit');
    const limit = limitFlagIdx >= 0 ? Number(process.argv[limitFlagIdx + 1]) : 10;
    if (!Number.isInteger(limit) || limit < 1) {
      console.error('penumbra recent: --limit must be a positive integer');
      process.exit(1);
    }
    const dbPath = join(root, 'db.sqlite');
    const rows = runRecent({ dbPath, project, limit });
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  }
  case 'recall': {
    const query = process.argv[3];
    if (!query) {
      console.error('usage: penumbra recall <query> [--project <id>] [--limit <n>]');
      process.exit(1);
    }
    const projectFlagIdx = process.argv.indexOf('--project');
    const project = projectFlagIdx >= 0 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
    const limitFlagIdx = process.argv.indexOf('--limit');
    const limit = limitFlagIdx >= 0 ? Number(process.argv[limitFlagIdx + 1]) : 5;
    if (!Number.isInteger(limit) || limit < 1) {
      console.error('penumbra recall: --limit must be a positive integer');
      process.exit(1);
    }
    try {
      root = resolveDaemonStorageRoot({ explicit: process.env.PENUMBRA_STORAGE_ROOT });
      const hits = await runRecall({ storageRoot: root, query, project, limit });
      console.log(JSON.stringify(hits, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  }
  case 'hook': {
    // Reads a Claude Code hook event JSON from stdin and forwards a t0 observation.
    // Designed for use in ~/.claude/settings.json hooks (PreToolUse, PostToolUse,
    // UserPromptSubmit). Best-effort — never blocks the hook on observation failures.
    const subtype = process.argv[3];
    if (subtype !== 'claude-code') {
      console.error('usage: penumbra hook claude-code [--project <id>] [--session <id>]');
      process.exit(1);
    }
    const projectFlagIdx = process.argv.indexOf('--project');
    const project = projectFlagIdx >= 0 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
    const sessionFlagIdx = process.argv.indexOf('--session');
    const sessionId = sessionFlagIdx >= 0 ? (process.argv[sessionFlagIdx + 1] ?? null) : null;
    const rawEvent = await Bun.stdin.text();
    try {
      root = resolveDaemonStorageRoot({ explicit: process.env.PENUMBRA_STORAGE_ROOT });
    } catch {
      // hook is best-effort — never block the calling Claude Code hook on discovery.
      process.exit(0);
    }
    process.exit(await runHook({ storageRoot: root, rawEvent, project, sessionId }));
  }
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log('usage: penumbra <init|start|stop|status|export|import|repair|tail|recent|recall|hook>');
    process.exit(0);
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}

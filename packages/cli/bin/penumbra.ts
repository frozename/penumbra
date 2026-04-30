#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { Branding } from '@penumbra/core';

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
import { resolveCliStorageRoot } from '../src/storage-root.js';

const cmd = process.argv[2];
const bootstrapRoot = process.env.PENUMBRA_STORAGE_ROOT ?? Branding.storageRoot;

function resolveLiveRoot(): string {
  try {
    return resolveCliStorageRoot();
  } catch {
    return bootstrapRoot;
  }
}

switch (cmd) {
  case 'init':
    process.exit(await runInit({ storageRoot: bootstrapRoot }));
  case 'start': {
    const detach = process.argv.includes('--detach') || process.argv.includes('-d');
    const host = readOptionalFlagValue('--host');
    const portRaw = readOptionalFlagValue('--port');
    let port: number | undefined;
    if (portRaw !== undefined) {
      const parsed = Number(portRaw);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        console.error(`penumbra start: --port must be an integer in [0, 65535] (got: ${portRaw})`);
        process.exit(2);
      }
      port = parsed;
    }
    const displayHost = formatHostForUrl(host ?? process.env.PENUMBRA_DAEMON_HOST ?? '127.0.0.1');
    if (detach) {
      try {
        const r = await runStartDetached({ storageRoot: bootstrapRoot, host, port });
        console.log(`penumbra: detached on http://${displayHost}:${r.port} (pid=${r.pid}); logs at ${r.logPath}`);
        process.exit(0);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    }
    const handle = await runStart({ storageRoot: bootstrapRoot, host, port });
    let stopping = false;
    const onSignal = async () => {
      if (stopping) return;
      stopping = true;
      await runStop({ storageRoot: bootstrapRoot, handle });
      process.exit(0);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    console.log(`penumbra: running on http://${displayHost}:${handle.port} (pid=${process.pid}). Ctrl-C to stop.`);
    await new Promise<never>(() => {}); // block forever; signals drive exit
    process.exit(0);
  }
  case 'stop':
    process.exit(await runStop({ storageRoot: resolveLiveRoot() }));
  case 'status': {
    const s = await runStatus({ storageRoot: resolveLiveRoot() });
    console.log(JSON.stringify(s, null, 2));
    process.exit(s.status === 'running' ? 0 : 2);
  }
  case 'export': {
    const outPath = process.argv[3] ?? join(bootstrapRoot, 'export.jsonl');
    const projectFlagIdx = process.argv.indexOf('--project');
    const project = projectFlagIdx >= 0 ? (process.argv[projectFlagIdx + 1] ?? null) : null;
    const dbPath = join(bootstrapRoot, 'db.sqlite');
    process.exit(await runExport({ dbPath, project, outPath }));
  }
  case 'import': {
    const inPath = process.argv[3];
    if (!inPath) { console.error('usage: penumbra import <file.jsonl>'); process.exit(1); }
    const dbPath = join(bootstrapRoot, 'db.sqlite');
    process.exit(await runImport({ dbPath, inPath }));
  }
  case 'repair': {
    const r = await runRepair({ storageRoot: resolveLiveRoot() });
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
    const dbPath = join(bootstrapRoot, 'db.sqlite');
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
    const dbPath = join(bootstrapRoot, 'db.sqlite');
    const rows = runRecent({ dbPath, project, limit });
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  }
  case 'hooks': {
    const sub = process.argv[3];
    const forceReplace = process.argv.includes('--force-replace');
    const claudeFlag = process.argv.includes('--claude');
    const geminiOtelFlag = process.argv.includes('--gemini-otel');
    const codexOtelFlag = process.argv.includes('--codex-otel');
    const claudeOtelFlag = process.argv.includes('--claude-otel');
    try {
      const { runHooksInstallClaude, runHooksUninstallClaude, runHooksStatus, runHooksInstallGeminiOtel, runHooksUninstallGeminiOtel, runHooksInstallCodexOtel, runHooksUninstallCodexOtel, runHooksInstallClaudeOtel, runHooksUninstallClaudeOtel } = await import('../src/commands/hooks.js');
      if (sub === 'install') {
        if (claudeOtelFlag) {
          const r = await runHooksInstallClaudeOtel();
          console.log(r.idempotent ? `penumbra hooks: claude OTel already configured (${r.endpoint})` : `penumbra hooks: claude OTel installed → ${r.endpoint}`);
          process.exit(0);
        }
        if (codexOtelFlag) {
          const r = await runHooksInstallCodexOtel();
          console.log(r.idempotent ? `penumbra hooks: codex OTel already configured (${r.endpoint})` : `penumbra hooks: codex OTel installed → ${r.endpoint}`);
          process.exit(0);
        }
        if (geminiOtelFlag) {
          const r = await runHooksInstallGeminiOtel();
          console.log(r.idempotent ? `penumbra hooks: gemini OTel already configured (${r.endpoint})` : `penumbra hooks: gemini OTel installed → ${r.endpoint}`);
          process.exit(0);
        }
        if (!claudeFlag) {
          console.error('usage: penumbra hooks install (--claude [--force-replace] | --claude-otel | --gemini-otel | --codex-otel)');
          process.exit(1);
        }
        const r = await runHooksInstallClaude({ force: forceReplace });
        console.log(r.idempotent ? 'penumbra hooks: already installed' : `penumbra hooks: installed statusline at ${r.scriptPath}`);
        if (r.backupPath) console.log(`penumbra hooks: backed up previous settings to ${r.backupPath}`);
        process.exit(0);
      }
      if (sub === 'uninstall') {
        if (claudeOtelFlag) {
          const r = await runHooksUninstallClaudeOtel();
          console.log(r.removed ? 'penumbra hooks: removed claude OTel telemetry env vars' : 'penumbra hooks: no claude OTel telemetry env vars found');
          process.exit(0);
        }
        if (codexOtelFlag) {
          const r = await runHooksUninstallCodexOtel();
          console.log(r.removed ? 'penumbra hooks: removed codex OTel telemetry block' : 'penumbra hooks: no codex OTel telemetry block found');
          process.exit(0);
        }
        if (geminiOtelFlag) {
          const r = await runHooksUninstallGeminiOtel();
          console.log(r.removed ? 'penumbra hooks: removed gemini OTel telemetry block' : 'penumbra hooks: no gemini OTel telemetry block found');
          process.exit(0);
        }
        if (!claudeFlag) {
          console.error('usage: penumbra hooks uninstall (--claude | --claude-otel | --gemini-otel | --codex-otel)');
          process.exit(1);
        }
        const r = await runHooksUninstallClaude();
        console.log(r.removed ? 'penumbra hooks: removed statusLine from settings.json' : 'penumbra hooks: no penumbra statusLine found');
        process.exit(0);
      }
      if (sub === 'status') {
        await runHooksStatus();
        process.exit(0);
      }
      console.error('usage: penumbra hooks <install|uninstall|status> (--claude [--force-replace] | --claude-otel | --gemini-otel | --codex-otel)');
      process.exit(1);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  }
  case 'cost': {
    const sub = process.argv[3];
    const since = readOptionalFlagValue('--since');
    const projectId = readOptionalFlagValue('--project-id');
    const json = process.argv.includes('--json');
    try {
      const { runCostRecent, runCostQuota } = await import('../src/commands/cost.js');
      if (sub === 'recent') {
        await runCostRecent({
          since,
          project_id: projectId ?? null,
          json,
          storageRoot: resolveLiveRoot(),
        });
        process.exit(0);
      }
      if (sub === 'quota') {
        await runCostQuota({
          since,
          json,
          storageRoot: resolveLiveRoot(),
        });
        process.exit(0);
      }
      console.error('usage: penumbra cost <recent|quota> [--since <duration>] [--project-id <id>] [--json]');
      process.exit(1);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  }
  case 'recall': {
    const query = process.argv[3];
    if (!query) {
      console.error('usage: penumbra recall <query> [--project <id>] [--limit <n>] [--session <id>] [--event-types <types>]');
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
    const sessionFlagIdx = process.argv.indexOf('--session');
    const sessionId = sessionFlagIdx >= 0 ? (process.argv[sessionFlagIdx + 1] ?? undefined) : undefined;
    const eventTypesFlagIdx = process.argv.indexOf('--event-types');
    const eventTypesRaw = eventTypesFlagIdx >= 0 ? (process.argv[eventTypesFlagIdx + 1] ?? '') : '';
    const eventTypes = eventTypesRaw ? eventTypesRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

    try {
      const hits = await runRecall({
        storageRoot: resolveLiveRoot(),
        query,
        project,
        limit,
        session_id: sessionId,
        event_types: eventTypes,
      });
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
      const root = resolveLiveRoot();
      process.exit(await runHook({ storageRoot: root, rawEvent, project, sessionId }));
    } catch {
      // hook is best-effort — never block the calling Claude Code hook on discovery.
      process.exit(0);
    }
  }
  case 'statusline': {
    const { runStatusline } = await import('../src/commands/statusline.js');
    const line = await runStatusline();
    console.log(line);
    process.exit(0);
  }
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log('usage: penumbra <init|start|stop|status|export|import|repair|tail|recent|cost|recall|hook|hooks|statusline>');
    process.exit(0);
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}

function readOptionalFlagValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('-')) {
    console.error(`usage: penumbra start ${flag} <value>`);
    process.exit(1);
  }
  return value;
}

function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

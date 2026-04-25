import { expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runStart } from '../src/commands/start.js';
import { runStop } from '../src/commands/stop.js';
import { runStatus } from '../src/commands/status.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }

let dir = '';
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'penumbra-cli-status-'));
  await runInit({ storageRoot: dir, uuid: () => 'tok' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('status returns "running" when daemon is up', async () => {
  const handle = await runStart({ storageRoot: dir });
  try {
    const r = await runStatus({ storageRoot: dir });
    expect(r.status).toBe('running');
    expect(r.port).toBe(handle.port);
    expect(r.embedder).toBeDefined();
  } finally { await runStop({ storageRoot: dir, handle }); }
});

test('status returns "stopped" when pid/port files are absent', async () => {
  const r = await runStatus({ storageRoot: dir });
  expect(r.status).toBe('stopped');
});

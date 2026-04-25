import { expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runStart } from '../src/commands/start.js';
import { runStop } from '../src/commands/stop.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }

let dir = '';
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'penumbra-cli-ss-'));
  await runInit({ storageRoot: dir, uuid: () => 'tok' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('start writes port + pid files; stop removes them', async () => {
  const handle = await runStart({ storageRoot: dir });
  try {
    expect(existsSync(join(dir, 'port'))).toBe(true);
    expect(existsSync(join(dir, 'pid'))).toBe(true);
    const port = Number(readFileSync(join(dir, 'port'), 'utf8'));
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
  } finally {
    await runStop({ storageRoot: dir, handle });
  }
  expect(existsSync(join(dir, 'port'))).toBe(false);
  expect(existsSync(join(dir, 'pid'))).toBe(false);
});

test('start refuses if a live daemon is already running', async () => {
  const handle = await runStart({ storageRoot: dir });
  try {
    await expect(runStart({ storageRoot: dir })).rejects.toThrow(/already running/);
  } finally {
    await runStop({ storageRoot: dir, handle });
  }
});

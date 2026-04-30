import { expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
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

test('stop without handle calls process.kill on recorded pid and unlinks files', async () => {
  // Synthetic pid file pointing at a known-dead pid. We can't safely test
  // SIGTERM against a real process from inside the test runner — that would
  // kill the runner. We test the cleanup invariants that runStop guarantees:
  // - file unlink runs
  // - bad pid throws are swallowed
  const fakePid = 2147483640; // near INT_MAX, very unlikely to be a real pid
  writeFileSync(join(dir, 'pid'), `${fakePid}\n`);
  writeFileSync(join(dir, 'port'), '12345\n');

  const result = await runStop({ storageRoot: dir });
  expect(result).toBe(0);
  expect(existsSync(join(dir, 'pid'))).toBe(false);
  expect(existsSync(join(dir, 'port'))).toBe(false);
});

test('start binds to an explicit port when one is provided', async () => {
  // Pick a port that's almost certainly free: well above macOS service range
  // and above the ephemeral default. If something else grabs it, the test
  // will fail loudly rather than silently random-rebind.
  const port = 51380;
  const handle = await runStart({ storageRoot: dir, port });
  try {
    expect(handle.port).toBe(port);
    const portFile = Number(readFileSync(join(dir, 'port'), 'utf8').trim());
    expect(portFile).toBe(port);
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
  } finally {
    await runStop({ storageRoot: dir, handle });
  }
});

test('concurrent runStart calls — exactly one wins, the other rejects', async () => {
  // Race two starts. One should claim the pid file via O_EXCL; the other
  // should reject with "already running" (or fail the EEXIST liveness check).
  const results = await Promise.allSettled([
    runStart({ storageRoot: dir }),
    runStart({ storageRoot: dir }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(1);

  // Clean up the winner.
  const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof runStart>>>).value;
  await runStop({ storageRoot: dir, handle: winner });
});

import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

// On macOS, Bun uses the Apple SQLite build which disables extension loading.
// Switch to Homebrew's full-featured SQLite before any Database is created.
// See: https://bun.sh/docs/api/sqlite#loadextension
// Guard: setCustomSQLite throws if called after SQLite is already loaded (e.g.
// when multiple test files in the same bun test run each attempt the call).
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded in this process
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqliteVec } from '../src/db/sqlite-vec.js';
import { migrate } from '../src/db/migrations.js';
import { buildServices } from '../src/services.js';
import { TestEmbedder } from '../src/embedder/test-embedder.js';

test('buildServices wires all core dependencies with injected clock/uuid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-svc-'));
  try {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const svc = buildServices({
      env: {},
      input: {},
      storageRoot: dir,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      clock: () => new Date('2026-04-23T00:00:00Z'),
      uuid: () => 'u',
    });
    expect(svc.settings.t0RetentionDays).toBe(30);
    expect(svc.machineId.get()).toBe('u');
    expect(svc.redactor).toBeDefined();
    expect(svc.t0Writer).toBeDefined();
    expect(svc.recallReader).toBeDefined();
    expect(svc.supervisor).toBeDefined();
    expect(svc.projectCache).toBeDefined();
    expect(svc.pidRegistry).toBeDefined();
    expect(svc.workflowRegistry).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildServices passes through workflowRegistry when provided', () => {
  const dir = mkdtempSync(join(tmpdir(), 'penumbra-svc-wf-'));
  try {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const stub = {
      list: () => [{ name: 'demo' }],
      entries: () => [],
      get: () => undefined,
      findByTrigger: () => [],
      getEntry: () => undefined,
      errors: [],
    };
    const svc = buildServices({
      env: {},
      input: {},
      storageRoot: dir,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      workflowRegistry: stub,
    });
    expect(svc.workflowRegistry).toBe(stub);
    expect(svc.workflowRegistry?.list().length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { applySchema, SCHEMA_VERSION } from '../../src/db/schema.js';

// On macOS, Bun uses the Apple SQLite build which disables extension loading.
// Switch to Homebrew's full-featured SQLite before any Database is created.
// See: https://bun.sh/docs/api/sqlite#loadextension
// Guard: setCustomSQLite throws if called after SQLite is already loaded (e.g.
// when multiple test files in the same bun test run each attempt the call).
if (process.platform === 'darwin') {
  try {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  } catch {
    // already loaded by a sibling test file — no-op
  }
}

test('applySchema creates all tables', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  const tables = db
    .query<{ name: string }, [string]>('SELECT name FROM sqlite_master WHERE type=?')
    .all('table')
    .map((r) => r.name);
  expect(tables).toContain('t0_events');
  expect(tables).toContain('t1_rollups');
  expect(tables).toContain('t2_memories');
  expect(tables).toContain('projects');
  expect(tables).toContain('recall_audit');
  expect(tables).toContain('db_meta');
});

test('applySchema creates vec0 companion tables', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  db.run('INSERT INTO t1_vec(rowid, embedding) VALUES (?, ?)', [
    1,
    new Float32Array(384),
  ]);
  expect(
    db.query<{ c: number }, []>('SELECT COUNT(*) c FROM t1_vec').get()?.c,
  ).toBe(1);
});

test('SCHEMA_VERSION is an integer', () => {
  expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
  expect(SCHEMA_VERSION).toBeGreaterThan(0);
});

import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { applySchema, SCHEMA_VERSION } from '../../src/db/schema.js';
import { migrate } from '../../src/db/migrations.js';

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

test('applySchema creates handoffs table with status index', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='handoffs'",
  ).all();
  expect(tables.length).toBe(1);

  const indexes = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='handoffs'",
  ).all().map((r) => r.name);
  expect(indexes).toContain('handoffs_pending');
  expect(indexes).toContain('handoffs_by_conv');

  db.close();
});

test('applySchema adds t2_promoted_at to t1_rollups', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info('t1_rollups')`)
    .all()
    .map((r) => r.name);
  expect(cols).toContain('t2_promoted_at');
  db.close();
});

test('schema creates agent_performance table and indexes', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const table = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_performance'`,
  ).get();
  expect(table?.name).toBe('agent_performance');
  const indexes = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_performance' ORDER BY name`,
  ).all().map(r => r.name);
  expect(indexes).toContain('agent_perf_by_task_agent');
  expect(indexes).toContain('agent_perf_by_ts');
});

test('applySchema adds dream_research_cache negative-cache fields and index', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  applySchema(db);

  const columns = db
    .query<{ name: string; type: string; notnull: number; dflt_value: string | null }, []>(
      `PRAGMA table_info('dream_research_cache')`,
    )
    .all();
  const isNegative = columns.find((column) => column.name === 'is_negative');
  expect(isNegative).toBeDefined();
  expect(isNegative?.type).toBe('INTEGER');
  expect(isNegative?.notnull).toBe(1);
  expect(isNegative?.dflt_value).toBe('0');

  const indexes = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_dream_research_cache_negative'`,
    )
    .all();
  expect(indexes).toHaveLength(1);
});

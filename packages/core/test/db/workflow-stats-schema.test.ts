import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';

test('workflow_stats table exists with expected columns after migrate', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const row = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_stats'")
    .get() as { name: string } | undefined;
  expect(row?.name).toBe('workflow_stats');

  const cols = db
    .query("PRAGMA table_info('workflow_stats')")
    .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
  const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

  expect(colMap.workflow_name?.type).toBe('TEXT');
  expect(colMap.workflow_name?.pk).toBe(1);
  expect(colMap.samples?.type).toBe('INTEGER');
  expect(colMap.successes?.type).toBe('INTEGER');
  expect(colMap.failures?.type).toBe('INTEGER');
  expect(colMap.avg_latency_ms?.type).toBe('INTEGER');
  expect(colMap.last_run_at?.type).toBe('TEXT');
  expect(colMap.last_failure_at?.type).toBe('TEXT');
  expect(colMap.last_failure_reason?.type).toBe('TEXT');
  expect(colMap.consecutive_failures?.type).toBe('INTEGER');
  expect(colMap.quarantined?.type).toBe('INTEGER');
  expect(colMap.quarantine_reason?.type).toBe('TEXT');
});

test('schema_version is 9 after migrate', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const row = db
    .query("SELECT value FROM db_meta WHERE key='schema_version'")
    .get() as { value: string };
  expect(row.value).toBe('9');
});

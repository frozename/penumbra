import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { SCHEMA_VERSION } from '../../src/db/schema.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded in this process
}

test('migrate applies schema and records version on a fresh db', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const v = db
    .query<{ value: string }, [string]>('SELECT value FROM db_meta WHERE key=?')
    .get('schema_version');
  expect(v?.value).toBe(String(SCHEMA_VERSION));
});

test('migrate is idempotent', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  migrate(db, { embeddingDim: 384 });
  const tables = db
    .query<{ name: string }, [string]>('SELECT name FROM sqlite_master WHERE type=?')
    .all('table').length;
  expect(tables).toBeGreaterThan(5);
});

test('migrate rejects a mismatched embedding dim on a non-empty db', () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  expect(() => migrate(db, { embeddingDim: 1536 })).toThrow(/embedding_dim/);
});

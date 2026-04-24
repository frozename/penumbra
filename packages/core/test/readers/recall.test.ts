import { expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { TestEmbedder } from '../../src/embedder/test-embedder.js';
import { RecallReader } from '../../src/readers/recall.js';

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

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

async function seedT1(rollupId: string, text: string, createdAt: string) {
  const embedder = new TestEmbedder({ dim: 384 });
  const [vec] = await embedder.embed([text]);
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                            n_events, last_response_excerpt, first_prompt_excerpt)
     VALUES (?, ?, 'u', ?, ?, ?, 1, ?, ?)`,
    [rollupId, 'p1', rollupId, createdAt, createdAt, text, text],
  );
  const rowid = db
    .query<{ rowid: number }, [string]>('SELECT rowid FROM t1_rollups WHERE rollup_id=?')
    .get(rollupId)!.rowid;
  db.run('INSERT INTO t1_vec(rowid, embedding) VALUES(?, ?)', [rowid, vec!]);
}

test('returns T1 rollups ranked by vector similarity', async () => {
  await seedT1('a', 'the quick brown fox', '2026-04-20T00:00:00Z');
  await seedT1('b', 'penguins march in the antarctic', '2026-04-21T00:00:00Z');

  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: 'the quick brown fox',
    project_id: 'p1',
    limit: 10,
    include_raw: false,
    min_score: 0,
  });
  expect(results[0]!.id).toBe('a');
  expect(results[0]!.tier).toBe('t1');
});

test('honors project_id filter', async () => {
  await seedT1('a', 'x', '2026-04-20T00:00:00Z');
  db.run("UPDATE t1_rollups SET project_id='other' WHERE rollup_id='a'");
  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: 'x', project_id: 'p1', limit: 10, include_raw: false, min_score: 0,
  });
  expect(results.length).toBe(0);
});

test('empty DB returns empty array', async () => {
  const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  const results = await reader.recall({
    query: 'x', project_id: null, limit: 10, include_raw: false, min_score: 0,
  });
  expect(results).toEqual([]);
});

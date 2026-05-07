import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec, migrate } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { runMemorySearchSource } from '../src/recall-sources/memory.js';

function setupT1Tables(db: Database) {
  db.exec(`
    CREATE TABLE t1_memories (
      memory_id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_session_ids TEXT NOT NULL DEFAULT '[]',
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function insertT2Memory(db: Database, id: string, ts: string, body: string) {
  db.prepare(`
    INSERT INTO t2_memories (
      memory_id, project_id, user_id, kind,
      source_session_ids, window_start, window_end,
      title, body, metadata_json, created_at, updated_at,
      obs_type, concepts, severity, origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    'demo',
    'u1',
    'observation',
    JSON.stringify([id]),
    ts,
    ts,
    body,
    body,
    '{}',
    ts,
    ts,
    'session',
    JSON.stringify(['x']),
    'low',
    'dispatch',
  );
}

function insertT1Memory(db: Database, id: string, ts: string, body: string) {
  db.prepare(`
    INSERT INTO t1_memories (
      memory_id, project_id, user_id, kind,
      source_session_ids, window_start, window_end,
      title, body, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    'demo',
    'u1',
    'observation',
    JSON.stringify([id]),
    ts,
    ts,
    body,
    body,
    '{}',
    ts,
    ts,
  );
  db.prepare(`
    INSERT INTO t1_fts (rowid, first_prompt_excerpt, last_response_excerpt, tool_calls_summary)
    VALUES (
      (SELECT rowid FROM t1_memories WHERE memory_id = ?),
      ?,
      ?,
      ?
    )
  `).run(id, body, body, body);
}

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  setupT1Tables(db);
  return db;
}

test('memory.search tiers=t1+t2 returns both tiers', async () => {
  const db = freshDb();
  const ts = '2026-05-05T10:00:00Z';
  insertT1Memory(db, 'm1', ts, 'x from t1');
  insertT2Memory(db, 'm2', ts, 'x from t2');

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: 'x', dateStart: '2026-05-05T00:00:00Z', tiers: ['t1', 't2'], limit: 10 },
  });

  expect(out.hits.map((h) => h.id).sort()).toEqual(['t1:m1', 't2:m2']);
});

test('memory.search tiers=t2 returns only t2 rows', async () => {
  const db = freshDb();
  const ts = '2026-05-05T10:00:00Z';
  insertT1Memory(db, 'm1', ts, 'x from t1');
  insertT2Memory(db, 'm2', ts, 'x from t2');

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: 'x', dateStart: '2026-05-05T00:00:00Z', tiers: ['t2'], limit: 10 },
  });

  expect(out.hits.map((h) => h.id)).toEqual(['t2:m2']);
});

test('memory.search without tiers returns only t2 rows', async () => {
  const db = freshDb();
  const ts = '2026-05-05T10:00:00Z';
  insertT1Memory(db, 'm1', ts, 'x from t1');
  insertT2Memory(db, 'm2', ts, 'x from t2');

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: 'x', dateStart: '2026-05-05T00:00:00Z', limit: 10 },
  });

  expect(out.hits.map((h) => h.id)).toEqual(['t2:m2']);
});

test('memory.search tiers=t1 returns only t1 rows', async () => {
  const db = freshDb();
  const ts = '2026-05-05T10:00:00Z';
  insertT1Memory(db, 'm1', ts, 'x from t1');
  insertT2Memory(db, 'm2', ts, 'x from t2');

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: 'x', dateStart: '2026-05-05T00:00:00Z', tiers: ['t1'], limit: 10 },
  });

  expect(out.hits.map((h) => h.id)).toEqual(['t1:m1']);
});

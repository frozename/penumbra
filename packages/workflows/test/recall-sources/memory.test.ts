import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec, migrate } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { runMemorySearchSource } from '../../src/recall-sources/memory.js';

function insertMemory(
  db: Database,
  id: string,
  projectId: string | null,
  body: string,
  ts: string,
) {
  db.prepare(`
    INSERT INTO t2_memories (
      memory_id, project_id, user_id, kind,
      source_session_ids, window_start, window_end,
      title, body, metadata_json, created_at, updated_at,
      obs_type, concepts, severity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, projectId, 'u1', 'observation',
    JSON.stringify([id]), ts, ts,
    body, body, '{}', ts, ts,
    'note', JSON.stringify([]), 'low',
  );
}

test('memory.search project filter matches rows with matching, NULL, or empty project_id (FTS path)', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, 'm-match',  'penumbra', 'hello penumbra match',     '2026-05-05T01:00:00Z');
  insertMemory(db, 'm-null',   null,       'hello null project',       '2026-05-05T02:00:00Z');
  insertMemory(db, 'm-empty',  '',         'hello empty project',      '2026-05-05T03:00:00Z');
  insertMemory(db, 'm-other',  'someone-else', 'hello someone else',   '2026-05-05T04:00:00Z');

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { query: 'hello', project: 'penumbra', limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(['t2:m-empty', 't2:m-match', 't2:m-null']);
});

test('memory.search project filter matches NULL/empty in non-FTS branch', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, 'm-match',  'penumbra', 'fact a', '2026-05-05T01:00:00Z');
  insertMemory(db, 'm-null',   null,       'fact b', '2026-05-05T02:00:00Z');
  insertMemory(db, 'm-empty',  '',         'fact c', '2026-05-05T03:00:00Z');
  insertMemory(db, 'm-other',  'someone-else', 'fact d', '2026-05-05T04:00:00Z');

  const out = await runMemorySearchSource({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    args: { project: 'penumbra', dateStart: '2026-05-05T00:00:00Z', limit: 10 },
  });
  const ids = out.hits.map((h) => h.id).sort();
  expect(ids).toEqual(['t2:m-empty', 't2:m-match', 't2:m-null']);
});

test('memory.search returns hit list shape from real sqlite', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const embedder = new TestEmbedder({ dim: 384 });
  const t2Insert = db.prepare(`
    INSERT INTO t2_memories (
      memory_id, project_id, user_id, kind,
      source_session_ids, window_start, window_end,
      title, body, metadata_json, created_at, updated_at,
      obs_type, concepts, severity
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ts1 = '2026-05-04T10:00:00Z';
  const ts2 = '2026-05-04T11:00:00Z';
  t2Insert.run(
    'm1', 'demo', 'u1', 'observation',
    JSON.stringify(['s1']), ts1, ts1,
    'Fixed authentication bug', 'Fixed authentication bug in JWT path', '{}', ts1, ts1,
    'bugfix', JSON.stringify(['auth']), 'medium',
  );
  t2Insert.run(
    'm2', 'demo', 'u1', 'observation',
    JSON.stringify(['s2']), ts2, ts2,
    'Added JWT verification', 'Added JWT verification middleware', '{}', ts2, ts2,
    'feature', JSON.stringify(['auth']), 'low',
  );

  const out = await runMemorySearchSource({
    db,
    embedder,
    args: { query: 'authentication', project: 'demo', limit: 10 },
  });

  expect(out.hits.length).toBeGreaterThanOrEqual(1);
  const titles = out.hits.map((h) => h.title);
  expect(titles.some((t) => t.includes('authentication') || t.includes('JWT'))).toBe(true);
  expect(out.warnings).toEqual([]);
});

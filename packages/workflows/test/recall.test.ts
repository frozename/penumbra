import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { loadSqliteVec, migrate } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { composeRecall } from '../src/recall.js';

function insertMemory(
  db: Database,
  row: {
    memory_id: string;
    project_id: string;
    title: string;
    body: string;
    created_at: string;
    obs_type?: string;
  },
): void {
  const stmt = db.prepare(`
    INSERT INTO t2_memories (
      memory_id, project_id, user_id, kind,
      source_session_ids, window_start, window_end,
      title, body, metadata_json, created_at, updated_at,
      obs_type, concepts, severity
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    row.memory_id, row.project_id, 'u1', 'observation',
    JSON.stringify(['s1']), row.created_at, row.created_at,
    row.title, row.body, '{}', row.created_at, row.created_at,
    row.obs_type ?? 'note', JSON.stringify([]), 'low',
  );
}

test('composes bundle from multiple sources, partial failures captured as warnings', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertMemory(db, {
    memory_id: 'm1',
    project_id: 'demo',
    title: 'Fix bug',
    body: 'Fixed a bug in login flow',
    created_at: '2026-05-04T10:00:00Z',
    obs_type: 'bugfix',
  });

  db.exec(`
    INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
    VALUES (1, 'h1', 'worker', 'dispatch.start', '2026-05-04T11:00:00Z', '{}');
  `);

  db.exec(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
    VALUES ('h1', '2026-05-04T11:00:00Z', 'c1', 'a', 'b', 'pending message', 'pending');
  `);

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: '/nonexistent-path-for-git-failure-test',
    project: 'demo',
    sources: [
      { source: 'memory.search', args: { query: 'bug', project: 'demo', limit: 10 } },
      { source: 'dispatch_events', args: { since: '2026-05-04T10:00:00Z' } },
      { source: 'handoff.list_pending' },
      { source: 'git.log', args: { range: 'HEAD' } },
    ],
    budgetTokens: 8000,
  });

  expect(bundle.byKey['memory.search']).toBeDefined();
  expect(bundle.byKey['dispatch_events']).toBeDefined();
  expect(bundle.byKey['handoff.list_pending']).toBeDefined();
  expect(bundle.byKey['git.log']).toBeDefined();
  expect(bundle.warnings.some((w) => w.includes('git.log'))).toBe(true);
});

test('budget trim drops oldest items first', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  for (let i = 0; i < 50; i++) {
    const day = String(i + 1).padStart(2, '0');
    insertMemory(db, {
      memory_id: `m${i}`,
      project_id: 'demo',
      title: `Memory ${i}`,
      body: `Body of memory number ${i} with some additional padding text to consume tokens`,
      created_at: `2026-03-${day}T10:00:00Z`,
    });
  }

  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: '.',
    project: 'demo',
    sources: [
      { source: 'memory.search', args: { project: 'demo', limit: 50, dateStart: '2026-03-01' } },
    ],
    budgetTokens: 200,
  });

  expect(bundle.estimatedTokens).toBeLessThanOrEqual(200);
  expect(bundle.warnings.some((w) => w.includes('budget'))).toBe(true);
});

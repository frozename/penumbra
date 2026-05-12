import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../src/db/sqlite-vec.js';
import { applySchema } from '../src/db/schema.js';
import { search } from '../src/readers/search.js';
import { verifyMemory } from '../src/writers/t2.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded in this process
}

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

function insertT2(db: Database, memoryId: string, createdAt: string): void {
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids,
      window_start, window_end, title, body, metadata_json,
      compressed_from, created_at, updated_at, last_verified_at,
      obs_type, concepts, severity, file_paths
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memoryId,
      null,
      'u1',
      'fact',
      '[]',
      createdAt,
      createdAt,
      memoryId,
      `body for ${memoryId}`,
      '{}',
      null,
      createdAt,
      createdAt,
      null,
      'feature',
      '[]',
      null,
      '[]',
    ],
  );
}

test('verifyMemory updates freshness and search surfaces it', () => {
  const db = freshDb();
  const now = new Date('2026-05-12T12:00:00.000Z');
  const oldCreatedAt = new Date(now.getTime() - 45 * 86_400_000).toISOString();
  const staleCreatedAt = new Date(now.getTime() - 60 * 86_400_000).toISOString();

  insertT2(db, 'memory-fresh', oldCreatedAt);

  const verified = verifyMemory(db, 'memory-fresh');
  expect(verified.memory_id).toBe('memory-fresh');
  expect(verified.last_verified_at).toBeTruthy();

  const freshHits = search(db, { query: 'memory-fresh', project_id: null, limit: 5, tiers: ['t2'] });
  expect(freshHits).toHaveLength(1);
  expect(freshHits[0]).toMatchObject({
    id: 'memory-fresh',
    last_verified_at: verified.last_verified_at,
    stale: false,
  });
  expect(freshHits[0]!.age_days).toBeLessThanOrEqual(1);

  insertT2(db, 'memory-stale', staleCreatedAt);

  const staleHits = search(db, { query: 'memory-stale', project_id: null, limit: 5, tiers: ['t2'] });
  expect(staleHits).toHaveLength(1);
  expect(staleHits[0]!.age_days).toBeGreaterThanOrEqual(30);
  expect(staleHits[0]!.stale).toBe(true);
});

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

test('verifyMemory provenance is surfaced by search', () => {
  const db = freshDb();
  const createdAt = new Date('2026-05-12T12:00:00.000Z').toISOString();
  insertT2(db, 'memory-provenance', createdAt);

  const verified = verifyMemory(db, 'memory-provenance', {
    verifierActor: 'machine-1',
    claimedBy: 'maestro',
    reason: 'manual-spot-check',
    sessionId: 'sess-xyz',
    uuid: () => 'evt-1',
  });
  expect(verified).not.toBeNull();

  const hits = search(db, { query: 'memory-provenance', project_id: null, limit: 5, tiers: ['t2'] });
  const hit = hits.find((row) => row.id === 'memory-provenance');
  expect(hit).toBeTruthy();
  expect(hit).toMatchObject({
    last_verified_at: verified!.last_verified_at,
    last_verified_by: 'maestro',
    last_verified_reason: 'manual-spot-check',
    last_verified_session_id: 'sess-xyz',
  });
});

test('verifyMemory defaults provenance fields to null', () => {
  const db = freshDb();
  const createdAt = new Date('2026-05-12T12:00:00.000Z').toISOString();
  insertT2(db, 'memory-defaults', createdAt);

  const verified = verifyMemory(db, 'memory-defaults', {
    verifierActor: 'machine-1',
    uuid: () => 'evt-1',
  });
  expect(verified).toMatchObject({
    last_verified_by: null,
    last_verified_actor: 'machine-1',
    last_verified_reason: null,
    last_verified_session_id: null,
  });

  const hits = search(db, { query: 'memory-defaults', project_id: null, limit: 5, tiers: ['t2'] });
  const hit = hits.find((row) => row.id === 'memory-defaults');
  expect(hit).toMatchObject({
    last_verified_by: null,
    last_verified_reason: null,
    last_verified_session_id: null,
  });
});

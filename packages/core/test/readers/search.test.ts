import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { search } from '../../src/readers/search.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded
}

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 4 });
  return db;
}

function insertT2(
  db: Database,
  id: string,
  opts: { title?: string; body?: string; obs_type?: string | null; concepts?: string[]; created_at?: string; project_id?: string | null } = {},
): void {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                             window_start, window_end, title, body, metadata_json,
                             created_at, updated_at, obs_type, concepts, file_paths)
     VALUES (?, ?, 'u', 'rollup', '[]', ?, ?, ?, ?, '{}', ?, ?, ?, ?, '[]')`,
    [
      id,
      opts.project_id ?? null,
      opts.created_at ?? '2026-05-03',
      opts.created_at ?? '2026-05-03',
      opts.title ?? '',
      opts.body ?? '',
      opts.created_at ?? '2026-05-03',
      opts.created_at ?? '2026-05-03',
      opts.obs_type ?? null,
      JSON.stringify(opts.concepts ?? []),
    ],
  );
}

describe('search (compact index)', () => {
  test('returns id, tier, ts, type, title, snippet for t2 hits', () => {
    const db = freshDb();
    insertT2(db, 'm1', {
      title: 'codex-acp tool wiring',
      body: 'fs/terminal caps wired',
      obs_type: 'feature',
      concepts: ['acp', 'codex'],
      project_id: 'penumbra',
    });
    const out = search(db, { query: 'codex', project_id: null, limit: 5, offset: 0, tiers: ['t2'] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'm1',
      tier: 't2',
      obs_type: 'feature',
      title: 'codex-acp tool wiring',
    });
    expect(typeof out[0]!.snippet).toBe('string');
    expect(out[0]!.snippet.length).toBeGreaterThan(0);
    expect(out[0]!.snippet.length).toBeLessThan(200);
  });

  test('obs_type filter narrows results', () => {
    const db = freshDb();
    insertT2(db, 'a', { title: 'fix codex', body: 'fix codex', obs_type: 'bugfix' });
    insertT2(db, 'b', { title: 'add codex', body: 'add codex', obs_type: 'feature' });
    const out = search(db, { query: 'codex', project_id: null, limit: 10, offset: 0, obs_type: 'bugfix', tiers: ['t2'] });
    expect(out.map((r) => r.id)).toEqual(['a']);
  });

  test('date range narrows results', () => {
    const db = freshDb();
    insertT2(db, 'm_old', { title: 'old hit', body: 'old hit', created_at: '2026-04-01T00:00:00Z' });
    insertT2(db, 'm_new', { title: 'new hit', body: 'new hit', created_at: '2026-05-01T00:00:00Z' });
    const out = search(db, { query: 'hit', project_id: null, limit: 10, offset: 0, dateStart: '2026-05-01', tiers: ['t2'] });
    expect(out.map((r) => r.id)).toEqual(['m_new']);
  });

  test('concept filter narrows results via JSON LIKE', () => {
    const db = freshDb();
    insertT2(db, 'a', { title: 'codex acp wiring', body: 'codex acp wiring', concepts: ['acp', 'codex'] });
    insertT2(db, 'b', { title: 'codex other', body: 'codex other', concepts: ['unrelated'] });
    const out = search(db, { query: 'codex', project_id: null, limit: 10, offset: 0, concept: 'acp', tiers: ['t2'] });
    expect(out.map((r) => r.id)).toEqual(['a']);
  });
});

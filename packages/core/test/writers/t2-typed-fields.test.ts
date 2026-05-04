// packages/core/test/writers/t2-typed-fields.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
// macOS preamble (see Pre-flight "Test file boilerplate")
try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}
import { writeT2Memory } from '../../src/writers/t2.js';

describe('T2 writer typed-fields support', () => {
  test('explicit obs_type/concepts/severity/file_paths land on the row', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    await writeT2Memory(db, {
      memory_id: 'm1',
      project_id: 'penumbra',
      user_id: 'u',
      kind: 'rollup',
      source_session_ids: [],
      window_start: '2026-05-03T00:00:00Z',
      window_end:   '2026-05-03T00:00:00Z',
      title: 'codex-acp tool wiring',
      body: 'fs/terminal caps wired',
      embedding: new Float32Array([0, 0, 0, 1]),
      obs_type: 'feature',
      concepts: ['acp', 'codex'],
      severity: null,
      file_paths: ['agentchat.yaml'],
    });
    const row = db
      .query<{ obs_type: string; concepts: string; severity: string | null; file_paths: string }, [string]>(
        `SELECT obs_type, concepts, severity, file_paths FROM t2_memories WHERE memory_id=?`,
      )
      .get('m1');
    expect(row?.obs_type).toBe('feature');
    expect(JSON.parse(row!.concepts)).toEqual(['acp', 'codex']);
    expect(row?.severity).toBeNull();
    expect(JSON.parse(row!.file_paths)).toEqual(['agentchat.yaml']);
  });

  test('omitted typed fields fall back to NULL / [] without throwing', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    await writeT2Memory(db, {
      memory_id: 'm2',
      project_id: null,
      user_id: 'u',
      kind: 'rollup',
      source_session_ids: [],
      window_start: '2026-05-03T00:00:00Z',
      window_end:   '2026-05-03T00:00:00Z',
      title: 't',
      body: 'b',
      embedding: new Float32Array([0, 0, 0, 1]),
    });
    const row = db
      .query<{ obs_type: string | null; concepts: string | null; severity: string | null; file_paths: string | null }, [string]>(
        `SELECT obs_type, concepts, severity, file_paths FROM t2_memories WHERE memory_id=?`,
      )
      .get('m2');
    expect(row?.obs_type).toBeNull();
    expect(JSON.parse(row?.concepts ?? '[]')).toEqual([]);
    expect(row?.severity).toBeNull();
    expect(JSON.parse(row?.file_paths ?? '[]')).toEqual([]);
  });
});

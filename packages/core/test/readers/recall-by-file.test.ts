import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec } from '../../src/db/sqlite-vec.js';
import { migrate } from '../../src/db/migrations.js';
import { RecallReader } from '../../src/readers/recall.js';
import { TestEmbedder } from '../../src/embedder/test-embedder.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded
}

describe('RecallReader by-file scoping', () => {
  test('file_path filter restricts t0 hits to events that touched that path', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    const insert = (id: string, file: string | null, content: string) =>
      db.run(
        `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, payload_json)
         VALUES (?, '2026-05-03', '2026-05-03', 'claude-code', 'u', 'm', 'tool_use', 'tool', ?)`,
        [id, JSON.stringify(file ? { tool_input: { file_path: file }, text: content } : { text: content })],
      );

    insert('e1', 'agentchat.yaml', 'edited haiku entry agentchat');
    insert('e2', 'README.md', 'edited readme agentchat');
    insert('e3', null, 'unrelated thought agentchat');

    const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
    const out = await reader.recall({
      query: 'agentchat',
      project_id: null,
      limit: 10,
      include_raw: true,
      sources: ['t0'],
      min_score: 0,
      fusedScore: 0,
      file_path: 'agentchat.yaml',
    } as never);

    const ids = out.map((r) => r.id);
    expect(ids).toContain('e1');
    expect(ids).not.toContain('e2');
    expect(ids).not.toContain('e3');
  });

  test('omitting file_path returns hits regardless of file scope', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, payload_json)
       VALUES ('e1', '2026-05-03', '2026-05-03', 'claude-code', 'u', 'm', 'tool_use', 'tool', ?)`,
      [JSON.stringify({ tool_input: { file_path: 'agentchat.yaml' }, text: 'foo bar' })],
    );
    db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, payload_json)
       VALUES ('e2', '2026-05-03', '2026-05-03', 'claude-code', 'u', 'm', 'tool_use', 'tool', ?)`,
      [JSON.stringify({ text: 'foo bar' })],
    );

    const reader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
    const out = await reader.recall({
      query: 'foo',
      project_id: null,
      limit: 10,
      include_raw: true,
      sources: ['t0'],
      min_score: 0,
      fusedScore: 0,
    } as never);

    const ids = out.map((r) => r.id);
    expect(ids).toContain('e1');
    expect(ids).toContain('e2');
  });
});

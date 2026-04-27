import { expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded in this process
}
import { loadSqliteVec, migrate } from '../../src/index.js';
import { TestEmbedder } from '../../src/testing/index.js';
import { T2Promotion } from '../../src/writers/t2.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

function seedT1(rollupId: string, sessionId: string, endedAt: string) {
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                             n_events, lane_breakdown_json, provider_breakdown_json)
     VALUES (?, 'p1', 'u1', ?, '2026-04-27T10:00:00Z', ?, 5, '{}', '{}')`,
    [rollupId, sessionId, endedAt],
  );
  // Add transcript events
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-prompt', 'local', '{}', ?)`,
    [`e-${sessionId}-1`, '2026-04-27T10:00:00Z', '2026-04-27T10:00:00Z', sessionId, 'Tell me about the project'],
  );
  db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-response', 'local', '{}', ?)`,
    [`e-${sessionId}-2`, '2026-04-27T10:05:00Z', '2026-04-27T10:05:00Z', sessionId, 'The project is called Penumbra'],
  );
}

test('promoteRollup extracts memories and marks as promoted', async () => {
  seedT1('r1', 's1', '2026-04-27T10:05:00Z');
  
  const llm = async (transcript: string) => {
    expect(transcript).toContain('Tell me about the project');
    expect(transcript).toContain('Penumbra');
    return [
      { title: 'Project Name', body: 'The project is called Penumbra', kind: 'fact' }
    ];
  };

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-27T15:00:00Z'),
    uuid: () => 'm1',
    llm,
  });

  const count = await prom.promoteRollup('r1');
  expect(count).toBe(1);

  const memories = db.query('SELECT * FROM t2_memories', []).all();
  expect(memories.length).toBe(1);
  expect((memories[0] as any).title).toBe('Project Name');

  const rollup = db.query('SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id = "r1"', []).get() as any;
  expect(rollup.t2_promoted_at).toBe('2026-04-27T15:00:00.000Z');
});

test('promoteRollup handles empty transcript gracefully', async () => {
  // Seed rollup but no events
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                             n_events, lane_breakdown_json, provider_breakdown_json)
     VALUES (?, 'p1', 'u1', ?, '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z', 5, '{}', '{}')`,
    ['r-empty', 's-empty'],
  );

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-27T15:00:00Z'),
    uuid: () => 'u',
    llm: async () => [{ title: 'X', body: 'Y', kind: 'fact' }],
  });

  const count = await prom.promoteRollup('r-empty');
  expect(count).toBe(0);
  
  const rollup = db.query('SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id = "r-empty"', []).get() as any;
  expect(rollup.t2_promoted_at).toBe('2026-04-27T15:00:00.000Z');
});

test('detectEligibleRollups finds rollups past delay', () => {
  seedT1('r-old', 's-old', '2026-04-26T10:00:00Z'); // 29 hours ago
  seedT1('r-new', 's-new', '2026-04-27T14:30:00Z'); // 30 mins ago
  
  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-27T15:00:00Z'),
    uuid: () => 'u',
    llm: async () => [],
  });

  const eligible = prom.detectEligibleRollups(24, new Date('2026-04-27T15:00:00Z'));
  expect(eligible).toContain('r-old');
  expect(eligible).not.toContain('r-new');
});

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
import { T2Promotion, verifyMemory } from '../../src/writers/t2.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

function seedT1(rollupId: string, sessionId: string, endedAt: string, origin: string | null = null) {
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                             n_events, lane_breakdown_json, provider_breakdown_json, origin)
     VALUES (?, 'p1', 'u1', ?, '2026-04-27T10:00:00Z', ?, 5, '{}', '{}', ?)`,
    [rollupId, sessionId, endedAt, origin],
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
    minTranscriptChars: 0,
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

test('promoteRollup inherits origin from t1_rollup onto t2_memory', async () => {
  seedT1('r-orig', 's-orig', '2026-04-27T10:05:00Z', 'maestro');

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-27T15:00:00Z'),
    uuid: () => 'm-orig',
    llm: async () => [{ title: 'T', body: 'B', kind: 'fact' }],
    minTranscriptChars: 0,
  });

  await prom.promoteRollup('r-orig');
  const row = db.query<{ origin: string | null }, [string]>('SELECT origin FROM t2_memories WHERE memory_id=?').get('m-orig')!;
  expect(row.origin).toBe('maestro');
});

test('promoteRollup carries NULL origin through to t2_memory (legacy rollup)', async () => {
  seedT1('r-legacy', 's-legacy', '2026-04-27T10:05:00Z', null);

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-27T15:00:00Z'),
    uuid: () => 'm-legacy',
    llm: async () => [{ title: 'T', body: 'B', kind: 'fact' }],
    minTranscriptChars: 0,
  });

  await prom.promoteRollup('r-legacy');
  const row = db.query<{ origin: string | null }, [string]>('SELECT origin FROM t2_memories WHERE memory_id=?').get('m-legacy')!;
  expect(row.origin).toBeNull();
});

test('verifyMemory treats duplicate memory/session verification as idempotent', () => {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                             window_start, window_end, title, body, metadata_json,
                             compressed_from, created_at, updated_at)
     VALUES ('m-dup', NULL, 'u1', 'fact', '[]', '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z',
             'T', 'B', '{}', NULL, '2026-04-27T10:05:00Z', '2026-04-27T10:05:00Z')`,
  );

  const first = verifyMemory(db, 'm-dup', {
    verifierActor: 'auto-lane-close',
    claimedBy: 'agent-1',
    reason: 'lane closed passed: passed',
    sessionId: 'h-dup',
    uuid: () => 'evt-1',
  });
  const second = verifyMemory(db, 'm-dup', {
    verifierActor: 'auto-lane-close',
    claimedBy: 'agent-1',
    reason: 'lane closed passed: passed',
    sessionId: 'h-dup',
    uuid: () => 'evt-2',
  });

  expect(first?.written).toBe(true);
  expect(second?.written).toBe(false);
  const count = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memory_verification_events`).get();
  expect(count?.c).toBe(1);
});

test('verifyMemory defaults basis fields to null when omitted', () => {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                             window_start, window_end, title, body, metadata_json,
                             compressed_from, created_at, updated_at)
     VALUES ('m-basis-default', NULL, 'u1', 'fact', '[]', '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z',
             'T', 'B', '{}', NULL, '2026-04-27T10:05:00Z', '2026-04-27T10:05:00Z')`,
  );

  verifyMemory(db, 'm-basis-default', {
    verifierActor: 'auto-lane-close',
    claimedBy: 'agent-1',
    reason: 'lane closed passed: passed',
    sessionId: 'h-basis-default',
    uuid: () => 'evt-basis-default',
  });

  const row = db.query<{
    basis: string | null;
    basis_type: string | null;
    basis_detail: string | null;
  }, [string]>(
    `SELECT basis, basis_type, basis_detail FROM t2_memory_verification_events WHERE memory_id = ?`,
  ).get('m-basis-default');
  expect(row).toEqual({
    basis: null,
    basis_type: null,
    basis_detail: null,
  });
});

test('verifyMemory persists provided basis fields', () => {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                             window_start, window_end, title, body, metadata_json,
                             compressed_from, created_at, updated_at)
     VALUES ('m-basis-populated', NULL, 'u1', 'fact', '[]', '2026-04-27T10:00:00Z', '2026-04-27T10:05:00Z',
             'T', 'B', '{}', NULL, '2026-04-27T10:05:00Z', '2026-04-27T10:05:00Z')`,
  );

  verifyMemory(db, 'm-basis-populated', {
    verifierActor: 'auto-lane-close',
    claimedBy: 'agent-1',
    reason: 'lane closed passed: passed',
    sessionId: 'h-basis-populated',
    basis: {
      type: 'lane_close',
      detail: 'passed',
      basis: 'dispatch verdict',
    },
    uuid: () => 'evt-basis-populated',
  });

  const row = db.query<{
    basis: string | null;
    basis_type: string | null;
    basis_detail: string | null;
  }, [string]>(
    `SELECT basis, basis_type, basis_detail FROM t2_memory_verification_events WHERE memory_id = ?`,
  ).get('m-basis-populated');
  expect(row).toEqual({
    basis: 'dispatch verdict',
    basis_type: 'lane_close',
    basis_detail: 'passed',
  });
});

test('detectEligibleRollups respects minEvents threshold', () => {
  seedT1('r-eligible', 's-eligible', '2026-04-26T10:00:00Z'); // n_events = 5
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                             n_events, lane_breakdown_json, provider_breakdown_json)
     VALUES (?, 'p1', 'u1', ?, '2026-04-26T10:00:00Z', '2026-04-26T10:05:00Z', 4, '{}', '{}')`,
    ['r-ineligible', 's-ineligible'],
  );
  
  const prom = new T2Promotion({
    db, embedder: new TestEmbedder({ dim: 384 }), clock: () => new Date('2026-04-27T15:00:00Z'), uuid: () => 'u', llm: async () => [],
    minEvents: 5,
  });

  const eligible = prom.detectEligibleRollups(24, new Date('2026-04-27T15:00:00Z'));
  expect(eligible).toContain('r-eligible');
  expect(eligible).not.toContain('r-ineligible');
});

test('promoteRollup replaces orphaned t2_vec rowids', async () => {
  seedT1('r-orphan', 's-orphan', '2026-04-27T10:05:00Z');
  db.run(`INSERT INTO t2_vec(rowid, embedding) VALUES (?, ?)`, [1, new Float32Array(384)]);

  const prom = new T2Promotion({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-27T15:00:00Z'),
    uuid: () => 'm-orphan',
    llm: async () => [{ title: 'T', body: 'B', kind: 'fact' }],
    minTranscriptChars: 0,
  });

  const count = await prom.promoteRollup('r-orphan');
  expect(count).toBe(1);

  const memories = db.query('SELECT COUNT(*) c FROM t2_memories', []).get() as any;
  expect(memories.c).toBe(1);
  const vectors = db.query('SELECT COUNT(*) c FROM t2_vec', []).get() as any;
  expect(vectors.c).toBe(1);
});

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
import { T1Rollup } from '../../src/writers/t1.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

function seed(sessionId: string, n: number, lane = 'local') {
  for (let i = 0; i < n; i++) {
    db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
        session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
        request_id, payload_json, payload_summary)
       VALUES(?, ?, ?, 'mcp', null, 'p1', 'u', 'm', ?, 'agent-tool-use', ?, null, null, null, null, null, null, null, '{}', ?)`,
      [
        `e-${sessionId}-${i}`,
        `2026-04-23T12:0${i}:00Z`,
        `2026-04-23T12:0${i}:00Z`,
        sessionId,
        lane,
        `event ${i}`,
      ],
    );
  }
}

test('rollupSession produces a rollup + vec row with correct counts', async () => {
  seed('s1', 3);
  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-23T12:30:00Z'),
    uuid: () => 'rollup-1',
  });
  const written = await roll.rollupSession('s1');
  expect(written).not.toBeNull();
  const row = db
    .query<{ n_events: number; lane_breakdown_json: string }, [string]>(
      'SELECT n_events, lane_breakdown_json FROM t1_rollups WHERE rollup_id=?',
    )
    .get('rollup-1')!;
  expect(row.n_events).toBe(3);
  expect(JSON.parse(row.lane_breakdown_json)).toEqual({ local: 3 });
  expect(
    db.query<{ c: number }, []>('SELECT COUNT(*) c FROM t1_vec').get()!.c,
  ).toBe(1);
});

test('rollupSession returns null if session has zero events', async () => {
  const roll = new T1Rollup({
    db, embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-23T12:30:00Z'),
    uuid: () => 'r',
  });
  expect(await roll.rollupSession('nonexistent')).toBeNull();
});

test('rollupSession is idempotent — re-running for same session is a no-op', async () => {
  seed('s1', 2);
  const roll = new T1Rollup({
    db, embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-23T12:30:00Z'),
    uuid: (() => { let i = 0; return () => `r-${++i}`; })(),
  });
  await roll.rollupSession('s1');
  const second = await roll.rollupSession('s1');
  expect(second).toBeNull();
  expect(
    db.query<{ c: number }, []>('SELECT COUNT(*) c FROM t1_rollups').get()!.c,
  ).toBe(1);
});

test('rollupSession is concurrency-safe — racing calls fold to one row', async () => {
  seed('sR', 3);
  let uuidIdx = 0;
  const roll = new T1Rollup({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-23T12:30:00Z'),
    uuid: () => `race-${++uuidIdx}`,
  });
  const [a, b] = await Promise.all([roll.rollupSession('sR'), roll.rollupSession('sR')]);
  // One call did the work, the other returned null. We don't care which.
  const winners = [a, b].filter((x): x is string => typeof x === 'string');
  const losers = [a, b].filter((x) => x === null);
  expect(winners.length).toBe(1);
  expect(losers.length).toBe(1);
  const count = db
    .query<{ c: number }, [string]>('SELECT COUNT(*) c FROM t1_rollups WHERE session_id=?')
    .get('sR');
  expect(count?.c).toBe(1);
});

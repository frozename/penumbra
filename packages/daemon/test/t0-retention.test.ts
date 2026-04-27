import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';
import { createT0RetentionWorker } from '../src/workers/t0-retention.js';

function insertEvent(d: ReturnType<typeof makeTempDaemon>, id: string, ts: string, session: string) {
  d.services.db.run(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, project_id, user_id, machine_id, session_id, event_type, lane, payload_json)
     VALUES(?, ?, ?, 'mcp', 'pA', 'u', 'm', ?, 'agent-prompt', 'local', '{}')`,
    [id, ts, ts, session]
  );
}

function insertRollup(d: ReturnType<typeof makeTempDaemon>, session: string, endedAt: string | null) {
  d.services.db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
     VALUES(?, 'pA', 'u', ?, '2026-01-01T00:00:00Z', ?, 1, '{}', '{}')`,
    ['r_' + session, session, endedAt]
  );
}

test('t0 retention worker prunes old events covered by t1_rollup', async () => {
  const d = makeTempDaemon();
  try {
    const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    insertEvent(d, 'e1', oldTs, 's1');
    insertRollup(d, 's1', oldTs); // has ended_at

    const worker = createT0RetentionWorker({ services: d.services, retentionDays: 30 });
    await worker.tick();

    const count = d.services.db.query<{ c: number }, []>('SELECT COUNT(*) c FROM t0_events').get()!.c;
    expect(count).toBe(0); // e1 pruned
  } finally { d.stop(); }
});

test('t0 retention worker skips old events without ended t1_rollup', async () => {
  const d = makeTempDaemon();
  try {
    const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    insertEvent(d, 'e2', oldTs, 's2');
    // no rollup inserted

    const worker = createT0RetentionWorker({ services: d.services, retentionDays: 30 });
    await worker.tick();

    const count = d.services.db.query<{ c: number }, []>('SELECT COUNT(*) c FROM t0_events').get()!.c;
    expect(count).toBe(1); // e2 kept
  } finally { d.stop(); }
});

test('t0 retention worker skips recent events', async () => {
  const d = makeTempDaemon();
  try {
    const recentTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    insertEvent(d, 'e3', recentTs, 's3');
    insertRollup(d, 's3', recentTs);

    const worker = createT0RetentionWorker({ services: d.services, retentionDays: 30 });
    await worker.tick();

    const count = d.services.db.query<{ c: number }, []>('SELECT COUNT(*) c FROM t0_events').get()!.c;
    expect(count).toBe(1); // e3 kept
  } finally { d.stop(); }
});

test('t0 retention worker skips old events with active t1_rollup (ended_at IS NULL)', async () => {
  const d = makeTempDaemon();
  try {
    const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    insertEvent(d, 'e4', oldTs, 's4');
    insertRollup(d, 's4', null); // ended_at is NULL (active)

    const worker = createT0RetentionWorker({ services: d.services, retentionDays: 30 });
    await worker.tick();

    const count = d.services.db.query<{ c: number }, []>('SELECT COUNT(*) c FROM t0_events').get()!.c;
    expect(count).toBe(1); // e4 kept
  } finally { d.stop(); }
});

test('t0 retention worker invokes deleteBatch once per batch when rows exceed batchSize', async () => {
  const d = makeTempDaemon();
  try {
    const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 5; i++) {
      insertEvent(d, `e_yield_${i}`, oldTs, 's_yield');
    }
    insertRollup(d, 's_yield', oldTs);

    let batchInvocations = 0;
    const originalTransaction = d.services.db.transaction.bind(d.services.db);
    d.services.db.transaction = (fn: any) => {
      const wrapped = originalTransaction(fn);
      return ((...args: any[]) => {
        batchInvocations += 1;
        return wrapped(...args);
      }) as typeof wrapped;
    };

    const worker = createT0RetentionWorker({ services: d.services, retentionDays: 30, batchSize: 2 });
    await worker.tick();

    // 5 rows, batchSize 2 -> deletions are 2, 2, 1 -> 3 batch invocations.
    expect(batchInvocations).toBe(3);
    const count = d.services.db.query<{ c: number }, [string]>('SELECT COUNT(*) c FROM t0_events WHERE session_id = ?1').get('s_yield')!.c;
    expect(count).toBe(0);
  } finally { d.stop(); }
});

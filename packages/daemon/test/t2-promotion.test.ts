import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';
import { createT2PromotionWorker } from '../src/workers/t2-promotion.js';

test('t2 promotion worker is a no-op when no LLM judge is configured (no PENUMBRA_SIRIUS_BASE_URL)', async () => {
  const d = makeTempDaemon();
  d.services.supervisor.stopAll();
  const oldEnv = { sirius: process.env.PENUMBRA_SIRIUS_BASE_URL, sirius2: process.env.SIRIUS_URL };
  delete process.env.PENUMBRA_SIRIUS_BASE_URL;
  delete process.env.SIRIUS_URL;
  try {
    const oldTs = '2026-04-20T00:00:00.000Z';
    d.services.db.run(
      `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
       VALUES ('rno', 'p1', 'u1', 'sno', ?, ?, 5, '{}', '{}')`,
      [oldTs, oldTs]
    );
    d.services.clock = () => new Date('2026-04-27T10:00:00Z');

    // No `llm` opt — exercises createDefaultLLMJudge which returns null when env unset.
    const worker = createT2PromotionWorker({ services: d.services, delayHours: 24 });
    await worker.tick();

    // Rollup is untouched: not promoted, no failure counter increment.
    const row = d.services.db.query(`SELECT t2_promoted_at, failed_promotion_attempts FROM t1_rollups WHERE rollup_id='rno'`, []).get() as any;
    expect(row.t2_promoted_at).toBeNull();
    expect(row.failed_promotion_attempts).toBe(0);
  } finally {
    if (oldEnv.sirius) process.env.PENUMBRA_SIRIUS_BASE_URL = oldEnv.sirius;
    if (oldEnv.sirius2) process.env.SIRIUS_URL = oldEnv.sirius2;
    d.stop();
  }
});

test('t2 promotion worker short-circuits the cycle when judge is unreachable', async () => {
  const d = makeTempDaemon();
  d.services.supervisor.stopAll();
  d.services.clock = () => new Date('2026-04-27T10:00:00Z');
  try {
    const oldTs = '2026-04-20T00:00:00.000Z';
    // Three eligible rollups; first call should fail unreachable and remaining should be skipped.
    for (const id of ['ru1', 'ru2', 'ru3']) {
      d.services.db.run(
        `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
         VALUES (?, 'p1', 'u1', ?, ?, ?, 5, '{}', '{}')`,
        [id, `s_${id}`, oldTs, oldTs]
      );
      d.services.db.run(
        `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
         VALUES (?, ?, ?, 'mcp', 'u1', 'm1', ?, 'agent-prompt', 'local', '{}', 'hello')`,
        [`e_${id}`, oldTs, oldTs, `s_${id}`]
      );
    }

    let callCount = 0;
    const worker = createT2PromotionWorker({
      services: d.services,
      delayHours: 24,
      llm: async () => {
        callCount++;
        throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:3030');
      },
    });

    await worker.tick();
    // Only the first rollup attempt should hit the judge — remaining two are short-circuited.
    expect(callCount).toBe(1);
  } finally { d.stop(); }
});

test('t2 promotion worker skips on LLM failure but retries next tick', async () => {
  const d = makeTempDaemon();
  // Fixed clock for deterministic eligibility
  const now = new Date('2026-04-27T10:00:00Z');
  d.services.clock = () => now;
  // Stop background workers to avoid interference
  d.services.supervisor.stopAll();
  
  try {
     // Seed a rollup that is eligible for promotion
     const oldTs = '2026-04-20T00:00:00.000Z';
     d.services.db.run(
       `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 5, '{}', '{}')`,
       [oldTs, oldTs]
     );
     // Add events so transcript is not empty
     d.services.db.run(
       `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', 'hello')`,
       [oldTs, oldTs]
     );

     let callCount = 0;
     const worker = createT2PromotionWorker({
       services: d.services,
       delayHours: 24,
       llm: async () => {
         callCount++;
         throw new Error('LLM down');
       }
     });

     await worker.tick();
     expect(callCount).toBe(1);
     
     // Should not be promoted
     const promoted = d.services.db.query('SELECT t2_promoted_at, failed_promotion_attempts FROM t1_rollups WHERE rollup_id="r1"', []).get() as any;
     expect(promoted.t2_promoted_at).toBeNull();
     expect(promoted.failed_promotion_attempts).toBe(1);

     // Retry
     await worker.tick();
     expect(callCount).toBe(2);
     const promoted2 = d.services.db.query('SELECT failed_promotion_attempts FROM t1_rollups WHERE rollup_id="r1"', []).get() as any;
     expect(promoted2.failed_promotion_attempts).toBe(2);
  } finally { d.stop(); }
});

test('t2 promotion worker promotes eligible rollups', async () => {
  const d = makeTempDaemon();
  const now = new Date('2026-04-27T10:00:00Z');
  d.services.clock = () => now;
  d.services.supervisor.stopAll();

  try {
     const oldTs = '2026-04-20T00:00:00.000Z';
     d.services.db.run(
       `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 5, '{}', '{}')`,
       [oldTs, oldTs]
     );
     // Add events so transcript is not empty
     d.services.db.run(
       `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', 'hello')`,
       [oldTs, oldTs]
     );

     const worker = createT2PromotionWorker({
       services: d.services,
       delayHours: 24,
       llm: async () => [
         { title: 'Greet', body: 'User said hello', kind: 'fact' }
       ]
     });

     await worker.tick();
     
     const count = d.services.db.query('SELECT COUNT(*) c FROM t2_memories', []).get() as any;
     expect(count.c).toBe(1);

     const promoted = d.services.db.query('SELECT t2_promoted_at, failed_promotion_attempts FROM t1_rollups WHERE rollup_id="r1"', []).get() as any;
     expect(promoted.t2_promoted_at).not.toBeNull();
     expect(promoted.failed_promotion_attempts).toBe(0);
  } finally { d.stop(); }
});

test('t2 promotion worker handles empty transcripts by marking as promoted', async () => {
  const d = makeTempDaemon();
  const now = new Date('2026-04-27T10:00:00Z');
  d.services.clock = () => now;
  d.services.supervisor.stopAll();

  try {
     const oldTs = '2026-04-20T00:00:00.000Z';
     d.services.db.run(
       `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 5, '{}', '{}')`,
       [oldTs, oldTs]
     );
     // No events or only whitespace events
     d.services.db.run(
       `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', '   ')`,
       [oldTs, oldTs]
     );

     const worker = createT2PromotionWorker({
       services: d.services,
       delayHours: 24,
       llm: async () => { throw new Error('Should not be called'); }
     });

     await worker.tick();
     
     const count = d.services.db.query('SELECT COUNT(*) c FROM t2_memories', []).get() as any;
     expect(count.c).toBe(0);

     const promoted = d.services.db.query('SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id="r1"', []).get() as any;
     expect(promoted.t2_promoted_at).not.toBeNull();
  } finally { d.stop(); }
});

test('t2 promotion worker fails on malformed LLM response and increments counter', async () => {
  const d = makeTempDaemon();
  const now = new Date('2026-04-27T10:00:00Z');
  d.services.clock = () => now;
  d.services.supervisor.stopAll();

  try {
     const oldTs = '2026-04-20T00:00:00.000Z';
     d.services.db.run(
       `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 5, '{}', '{}')`,
       [oldTs, oldTs]
     );
     d.services.db.run(
       `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', 'hello')`,
       [oldTs, oldTs]
     );

     const worker = createT2PromotionWorker({
       services: d.services,
       delayHours: 24,
       llm: async () => [
         { title: '', body: 'missing title', kind: 'fact' } as any // title empty fails min(1)
       ]
     });

     await worker.tick();
     
     const count = d.services.db.query('SELECT COUNT(*) c FROM t2_memories', []).get() as any;
     expect(count.c).toBe(0);

     const promoted = d.services.db.query('SELECT t2_promoted_at, failed_promotion_attempts FROM t1_rollups WHERE rollup_id="r1"', []).get() as any;
     expect(promoted.t2_promoted_at).toBeNull();
     expect(promoted.failed_promotion_attempts).toBe(1);
  } finally { d.stop(); }
});

test('t2 promotion worker stops retrying after limit', async () => {
  const d = makeTempDaemon();
  const now = new Date('2026-04-27T10:00:00Z');
  d.services.clock = () => now;
  d.services.supervisor.stopAll();

  try {
     const oldTs = '2026-04-20T00:00:00.000Z';
     d.services.db.run(
       `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json, failed_promotion_attempts)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 1, '{}', '{}', 5)`,
       [oldTs, oldTs]
     );
     d.services.db.run(
       `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', 'hello')`,
       [oldTs, oldTs]
     );

     let callCount = 0;
     const worker = createT2PromotionWorker({
       services: d.services,
       delayHours: 24,
       llm: async () => {
         callCount++;
         return [];
       }
     });

     await worker.tick();
     // Should skip because attempts=5
     expect(callCount).toBe(0);
  } finally { d.stop(); }
});

test('t2 promotion worker re-reads MEMORY_PROMOTION_MIN_EVENTS per tick', async () => {
  const d = makeTempDaemon();
  const now = new Date('2026-04-27T10:00:00Z');
  d.services.clock = () => now;
  d.services.supervisor.stopAll();

  try {
     const oldTs = '2026-04-20T00:00:00.000Z';
     // Rollup with 3 events
     d.services.db.run(
       `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 3, '{}', '{}')`,
       [oldTs, oldTs]
     );
     d.services.db.run(
       `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', 'hello')`,
       [oldTs, oldTs]
     );

     let callCount = 0;
     const worker = createT2PromotionWorker({
       services: d.services,
       delayHours: 24,
       llm: async () => {
         callCount++;
         return [{ title: 'Fact', body: 'Fact', kind: 'fact' }];
       }
     });

     // 1. First tick - default behavior (minEvents=5), r1 has 3, should be skipped
     await worker.tick();
     expect(callCount).toBe(0);

     // 2. Set env to 2 - r1 (n_events=3) should now be eligible
     process.env.MEMORY_PROMOTION_MIN_EVENTS = '2';
     await worker.tick();
     expect(callCount).toBe(1);
     
     const count = d.services.db.query('SELECT COUNT(*) c FROM t2_memories', []).get() as any;
     expect(count.c).toBe(1);

     // 3. Unset env - back to 5. (Already promoted so it wouldn't be picked up anyway, but let's add r2)
     delete process.env.MEMORY_PROMOTION_MIN_EVENTS;
     d.services.db.run(
       `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r2', 'p1', 'u1', 's2', ?, ?, 3, '{}', '{}')`,
       [oldTs, oldTs]
     );
     d.services.db.run(
       `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e2', ?, ?, 'mcp', 'u1', 'm1', 's2', 'agent-prompt', 'local', '{}', 'world')`,
       [oldTs, oldTs]
     );
     await worker.tick();
     expect(callCount).toBe(1); // Still 1, r2 skipped

  } finally {
    delete process.env.MEMORY_PROMOTION_MIN_EVENTS;
    d.stop();
  }
});

test('t2 promotion worker opts take precedence over MEMORY_PROMOTION_MIN_EVENTS env', async () => {
  const d = makeTempDaemon();
  const now = new Date('2026-04-27T10:00:00Z');
  d.services.clock = () => now;
  d.services.supervisor.stopAll();

  try {
     const oldTs = '2026-04-20T00:00:00.000Z';
     // Rollup with 3 events
     d.services.db.run(
       `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at, n_events, lane_breakdown_json, provider_breakdown_json)
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 3, '{}', '{}')`,
       [oldTs, oldTs]
     );
     d.services.db.run(
       `INSERT INTO t0_events(event_id, ts, ingest_ts, source, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
        VALUES ('e1', ?, ?, 'mcp', 'u1', 'm1', 's1', 'agent-prompt', 'local', '{}', 'hello')`,
       [oldTs, oldTs]
     );

     process.env.MEMORY_PROMOTION_MIN_EVENTS = '2';
     // Opts set to 5 should win over env=2
     const worker = createT2PromotionWorker({
       services: d.services,
       delayHours: 24,
       minEvents: 5,
       llm: async () => [{ title: 'Fact', body: 'Fact', kind: 'fact' }]
     });

     await worker.tick();
     // Should skip because opts.minEvents=5 wins
     const count = d.services.db.query('SELECT COUNT(*) c FROM t2_memories', []).get() as any;
     expect(count.c).toBe(0);

  } finally {
    delete process.env.MEMORY_PROMOTION_MIN_EVENTS;
    d.stop();
  }
});

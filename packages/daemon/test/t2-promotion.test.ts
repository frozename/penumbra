import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';
import { createT2PromotionWorker } from '../src/workers/t2-promotion.js';

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
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 1, '{}', '{}')`,
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
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 1, '{}', '{}')`,
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
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 1, '{}', '{}')`,
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
        VALUES ('r1', 'p1', 'u1', 's1', ?, ?, 1, '{}', '{}')`,
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

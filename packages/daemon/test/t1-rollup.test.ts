import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';
import { createRollupWorker } from '../src/workers/t1-rollup.js';

test('rollup worker rolls idle sessions and rewrites the context file', async () => {
  const d = makeTempDaemon();
  try {
    // Seed a T0 event in an old session (past idle threshold).
    const oldTs = '2026-04-22T00:00:00Z';
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
        session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
        request_id, payload_json, payload_summary)
       VALUES(?, ?, ?, 'mcp', null, 'pA', 'u', 'm', ?, 'agent-prompt', 'local', null, null, null, null, null, null, null, '{}', ?)`,
      ['e1', oldTs, oldTs, 'old-session', 'hello'],
    );

    const worker = createRollupWorker({
      services: d.services,
      idleMinutes: 5,
    });
    await worker.tick();

    const count = d.services.db
      .query<{ c: number }, []>('SELECT COUNT(*) c FROM t1_rollups')
      .get()!.c;
    expect(count).toBe(1);

    const ctx = Bun.file(`${d.dir}/context/pA/latest.md`);
    expect(await ctx.exists()).toBe(true);
  } finally { d.stop(); }
});

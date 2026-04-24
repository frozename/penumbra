import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';

test('POST /sessions/end triggers an immediate rollup for that session', async () => {
  const d = makeTempDaemon();
  try {
    // Seed one event under session 'sX'.
    d.services.db.run(
      `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id,
        session_id, event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms,
        request_id, payload_json, payload_summary)
       VALUES('e1', '2026-04-23T12:00:00Z', '2026-04-23T12:00:00Z', 'mcp', null, 'pX', 'u', 'm',
              'sX', 'agent-prompt', 'local', null, null, null, null, null, null, null, '{}', 'hello')`,
    );
    const res = await fetch(`${d.url}/sessions/end`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sX' }),
    });
    expect(res.status).toBe(200);
    const count = d.services.db
      .query<{ c: number }, [string]>('SELECT COUNT(*) c FROM t1_rollups WHERE session_id=?')
      .get('sX');
    expect(count?.c).toBe(1);
    // Deviation #22: also verify project linkage
    const row = d.services.db
      .query<{ project_id: string | null }, [string]>(
        'SELECT project_id FROM t1_rollups WHERE session_id=?',
      )
      .get('sX');
    expect(row?.project_id).toBe('pX');
  } finally { d.stop(); }
});

test('POST /sessions/end with missing session_id returns 400', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/sessions/end`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  } finally { d.stop(); }
});

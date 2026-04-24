import { expect, test } from 'bun:test';
import { makeTempDaemon } from './helpers.js';

test('POST /observations writes a T0 row and returns event_id', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/observations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ts: '2026-04-23T11:59:59Z',
        source: 'mcp',
        source_detail: 'claude-code',
        session_id: 's1',
        user_id: 'ignored',       // overridden by ctx.userId
        machine_id: 'ignored',    // overridden by ctx.machineId
        event_type: 'agent-prompt',
        lane: 'local',
        payload_json: { prompt: 'hi' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { event_id?: string };
    expect(body.event_id).toBeDefined();
    const count = d.services.db
      .query<{ c: number }, []>('SELECT COUNT(*) c FROM t0_events').get();
    expect(count?.c).toBe(1);
  } finally { d.stop(); }
});

test('POST /observations returns 400 on Zod failure', async () => {
  const d = makeTempDaemon();
  try {
    const res = await fetch(`${d.url}/observations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ts: 'x', source: 'bogus', payload_json: {} }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
  } finally { d.stop(); }
});

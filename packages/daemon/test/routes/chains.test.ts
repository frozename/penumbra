import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { chainsStartRoute } from '../../src/routes/chains.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  return buildServices({
    env: {}, input: {}, storageRoot: '/tmp/chains-test', db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });
}

test('POST /chains/start writes user-prompt event + approved handoff and returns ids', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', project_id: 'auth-svc', max_hops: 5, trust_mode: 'all' }) }),
    services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.conversation_id).toBe('string');
  expect(typeof body.handoff_id).toBe('string');

  const t0Row = services.db.query<any, [string]>(`SELECT * FROM t0_events WHERE event_id=?`).get(body.handoff_id) ?? null;
  // The user-prompt event_id is body.handoff_id's predecessor — we wrote both in one tx.
  // Check counts instead.
  const events = services.db.query<{ event_type: string }, []>(`SELECT event_type FROM t0_events`).all();
  expect(events.find((e) => e.event_type === 'user-prompt')).toBeDefined();

  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.status).toBe('approved');
  expect(handoff.from_agent).toBe('user');
  expect(handoff.to_agent).toBe('planner');
  expect(handoff.resolved_by).toBe('chain-start');
  expect(handoff.chain_max_hops).toBe(5);
  expect(handoff.chain_trust_mode).toBe('all');
  expect(handoff.conversation_id).toBe(body.conversation_id);
});

test('POST /chains/start honors caller-supplied conversation_id', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', conversation_id: 'conv-mine' }) }),
    services);
  const body = await res.json();
  expect(body.conversation_id).toBe('conv-mine');
});

test('POST /chains/start returns 400 for invalid body', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ message: 'hi' }) }), services);
  expect(res.status).toBe(400);
});

test('POST /chains/start emits exactly one handoff-events event for the new approved row', async () => {
  const services = tempServices();
  const seen: any[] = [];
  services.handoffEvents.subscribe((row) => seen.push(row));

  await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi' }) }), services);

  expect(seen.length).toBe(1);
  expect(seen[0].status).toBe('approved');
});
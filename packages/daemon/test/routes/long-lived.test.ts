import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { reconcileLongLivedAgents } from '../../src/long-lived/reconciler.js';
import { longLivedGetRoute, longLivedListRoute } from '../../src/routes/long-lived.js';
import { createDaemonFetchHandler } from '../../src/serve.js';

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: '/tmp/long-lived-test',
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-05-10T00:00:00.000Z'),
    uuid: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  });
}

function seedAgent(services: Services): void {
  reconcileLongLivedAgents(services.db, [
    {
      name: 'home-mgmt',
      display_name: 'Home Mgmt',
      long_lived: true,
      long_lived_config: {
        schedule_cron: '*/15 * * * *',
        subscriptions: [{ server: 'ha', event: 'state_changed' }],
        mcp_allowlist: ['ha:state.*'],
        bounds: { wall_clock_ms: 180000, cost_cents: 50, max_sub_dispatches: 1 },
        circuit_breaker_threshold: 3,
        standing_brief: 'watch home state',
      },
    } as any,
  ], { now: Date.parse('2026-05-10T00:00:00.000Z') });
}

test('GET /long-lived lists reconciled agents', async () => {
  const services = tempServices();
  seedAgent(services);

  const res = await longLivedListRoute(new Request('http://x/long-lived'), services);
  expect(res.status).toBe(200);
  const body = await res.json() as { agents: Array<{ id: string; display_name: string; status: string }> };
  expect(body.agents).toHaveLength(1);
  expect(body.agents[0]).toMatchObject({
    id: 'home-mgmt',
    display_name: 'Home Mgmt',
    status: 'active',
  });
});

test('GET /long-lived/:id returns agent detail with related rows', async () => {
  const services = tempServices();
  seedAgent(services);

  services.db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
      completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'tick-1',
    'home-mgmt',
    'chain-1',
    'cron',
    JSON.stringify({ scheduled: true }),
    'check the house',
    1000,
    2000,
    'success',
    12,
    null,
    JSON.stringify({}),
  );

  services.db.query(
    `INSERT INTO long_lived_pending_actions (
      id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
      status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'action-1',
    'home-mgmt',
    'tick-1',
    'notify',
    'ha:state',
    JSON.stringify({ message: 'ping' }),
    'needs attention',
    'pending',
    999999,
    null,
    null,
    null,
    1500,
  );

  services.db.query(
    `INSERT INTO long_lived_action_audit (
      agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'home-mgmt',
    'tick-1',
    'action-1',
    'notify',
    'ha:state',
    'approved',
    null,
    1600,
  );

  const res = await longLivedGetRoute(new Request('http://x/long-lived/home-mgmt'), 'home-mgmt', services);
  expect(res.status).toBe(200);
  const body = await res.json() as {
    agent: { id: string; display_name: string; working_memory: { version: number } };
    recent_ticks: Array<{ id: string; trigger_payload: { scheduled: boolean } }>;
    pending_actions: Array<{ id: string; payload: { message: string } }>;
    recent_audit: Array<{ pending_action_id: string | null; decision: string }>;
  };
  expect(body.agent.id).toBe('home-mgmt');
  expect(body.agent.display_name).toBe('Home Mgmt');
  expect(body.agent.working_memory.version).toBe(1);
  expect(body.recent_ticks).toHaveLength(1);
  expect(body.recent_ticks[0].trigger_payload).toEqual({ scheduled: true });
  expect(body.pending_actions).toHaveLength(1);
  expect(body.pending_actions[0].payload).toEqual({ message: 'ping' });
  expect(body.recent_audit).toHaveLength(1);
  expect(body.recent_audit[0].decision).toBe('approved');
});

test('serve.ts wires GET /long-lived and GET /long-lived/:id', async () => {
  const services = tempServices();
  seedAgent(services);
  const handler = createDaemonFetchHandler({ services, token: 'tok' });

  const listRes = await handler(new Request('http://x/long-lived', {
    headers: { authorization: 'Bearer tok' },
  }));
  expect(listRes.status).toBe(200);

  const getRes = await handler(new Request('http://x/long-lived/home-mgmt', {
    headers: { authorization: 'Bearer tok' },
  }));
  expect(getRes.status).toBe(200);
});

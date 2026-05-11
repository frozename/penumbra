import { expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { longLivedFederationToolsRoute } from '../../src/routes/long-lived-federation-tools.js';

function makeServices(db: Database): Services {
  return {
    db,
    settings: {},
    storageRoot: '/tmp/penumbra-test',
    dbMeta: {} as any,
    machineId: { get: () => 'machine-test' } as any,
    projectCache: {} as any,
    redactor: {} as any,
    t0Writer: {} as any,
    handoffWriter: {} as any,
    recallReader: {} as any,
    handoffReader: {} as any,
    chainReader: {} as any,
    handoffEvents: {} as any,
    permissionWriter: {} as any,
    permissionReader: {} as any,
    permissionEvents: {} as any,
    dispatchEventLog: {} as any,
    dispatchEvents: {} as any,
    conversationStream: {} as any,
    workerControl: {} as any,
    worktreeManager: {} as any,
    watchdog: {} as any,
    supervisor: {} as any,
    pidRegistry: {} as any,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-05-11T00:00:00.000Z'),
    uuid: (() => {
      let n = 0;
      return () => `evt-${++n}`;
    })(),
    log: { info: () => {}, warn: mock(() => {}), error: () => {} } as any,
    agentRegistry: null,
    agentRouting: null,
    providerQuotas: [],
    subscriptionPressureCache: {} as any,
    planWriter: {} as any,
  } as Services;
}

function seedAgent(db: Database, allowlist: string[]): void {
  db.query(
    `INSERT INTO long_lived_agents (
      id, display_name, status, degraded_reason, consecutive_failures, circuit_breaker_threshold,
      schedule_cron, subscriptions_json, mcp_allowlist_json, approval_required_globs_json,
      cooldown_overrides_json, bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
      working_memory_json, standing_brief, last_tick_started_at, last_tick_completed_at,
      last_tick_outcome, last_intent_summary, retired_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'agent-1',
    'Agent 1',
    'active',
    null,
    0,
    3,
    null,
    '[]',
    JSON.stringify(allowlist),
    '[]',
    '{}',
    null,
    null,
    null,
    '{}',
    'brief',
    null,
    null,
    null,
    null,
    null,
    1,
    1,
  );
}

test('GET /long-lived/agents/:id/federation-tools returns 404 for unknown agent', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await longLivedFederationToolsRoute(new Request('http://x/long-lived/agents/missing/federation-tools'), services, 'missing');
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: 'agent_not_found' });
});

test('GET /long-lived/agents/:id/federation-tools returns empty tools without mcpPool', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ['ha:state_get']);
  const services = makeServices(db);
  const res = await longLivedFederationToolsRoute(new Request('http://x/long-lived/agents/agent-1/federation-tools'), services, 'agent-1');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ tools: [] });
});

test('GET /long-lived/agents/:id/federation-tools filters a single server', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ['ha:state_get', 'ha:state_set']);
  const listTools = mock(async () => ([
    { name: 'state_get', description: 'get state' },
    { name: 'state_set', description: 'set state' },
    { name: 'ignored', description: 'nope' },
  ]));
  const services = makeServices(db);
  services.mcpPool = { listTools } as any;
  const res = await longLivedFederationToolsRoute(new Request('http://x/long-lived/agents/agent-1/federation-tools'), services, 'agent-1');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    tools: [
      { name: 'ha:state_get', description: 'get state', inputSchema: undefined },
      { name: 'ha:state_set', description: 'set state', inputSchema: undefined },
    ],
  });
});

test('GET /long-lived/agents/:id/federation-tools matches glob allowlist entries', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ['ha:ha_*']);
  const listTools = mock(async () => ([
    { name: 'ha_get_state', description: 'get state' },
    { name: 'ha_call_service', description: 'call service' },
  ]));
  const services = makeServices(db);
  services.mcpPool = { listTools } as any;
  const res = await longLivedFederationToolsRoute(new Request('http://x/long-lived/agents/agent-1/federation-tools'), services, 'agent-1');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    tools: [
      { name: 'ha:ha_get_state', description: 'get state', inputSchema: undefined },
      { name: 'ha:ha_call_service', description: 'call service', inputSchema: undefined },
    ],
  });
});

test('GET /long-lived/agents/:id/federation-tools warns and skips malformed allowlist entries', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ['invalid-no-colon', 'ha:state_get']);
  const warn = mock(() => {});
  const listTools = mock(async () => ([{ name: 'state_get' }]));
  const services = makeServices(db);
  services.log = { info: () => {}, warn, error: () => {} } as any;
  services.mcpPool = { listTools } as any;
  const res = await longLivedFederationToolsRoute(new Request('http://x/long-lived/agents/agent-1/federation-tools'), services, 'agent-1');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    tools: [{ name: 'ha:state_get', description: undefined, inputSchema: undefined }],
  });
  expect(warn).toHaveBeenCalled();
});

test('GET /long-lived/agents/:id/federation-tools returns empty tools for malformed json', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  db.query(
    `INSERT INTO long_lived_agents (
      id, display_name, status, degraded_reason, consecutive_failures, circuit_breaker_threshold,
      schedule_cron, subscriptions_json, mcp_allowlist_json, approval_required_globs_json,
      cooldown_overrides_json, bounds_wall_clock_ms, bounds_cost_cents, bounds_max_sub_dispatches,
      working_memory_json, standing_brief, last_tick_started_at, last_tick_completed_at,
      last_tick_outcome, last_intent_summary, retired_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'agent-1',
    'Agent 1',
    'active',
    null,
    0,
    3,
    null,
    '[]',
    'not valid json',
    '[]',
    '{}',
    null,
    null,
    null,
    '{}',
    'brief',
    null,
    null,
    null,
    null,
    null,
    1,
    1,
  );
  const warn = mock(() => {});
  const services = makeServices(db);
  services.log = { info: () => {}, warn, error: () => {} } as any;
  services.mcpPool = { listTools: mock(async () => { throw new Error('should not call'); }) } as any;
  const res = await longLivedFederationToolsRoute(new Request('http://x/long-lived/agents/agent-1/federation-tools'), services, 'agent-1');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ tools: [] });
  expect(warn).toHaveBeenCalled();
});

test('GET /long-lived/agents/:id/federation-tools merges multiple servers and skips list failures', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ['ha:state_get', 'x:do_it', 'y:run']);
  const warn = mock(() => {});
  const listTools = mock(async (server: string) => {
    if (server === 'ha') return [{ name: 'state_get' }, { name: 'state_set' }];
    if (server === 'x') throw new Error('boom');
    return [{ name: 'run' }];
  });
  const services = makeServices(db);
  services.log = { info: () => {}, warn, error: () => {} } as any;
  services.mcpPool = { listTools } as any;
  const res = await longLivedFederationToolsRoute(new Request('http://x/long-lived/agents/agent-1/federation-tools'), services, 'agent-1');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    tools: [
      { name: 'ha:state_get', description: undefined, inputSchema: undefined },
      { name: 'y:run', description: undefined, inputSchema: undefined },
    ],
  });
  expect(warn).toHaveBeenCalled();
});

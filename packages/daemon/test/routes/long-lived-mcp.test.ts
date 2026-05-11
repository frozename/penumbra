import { expect, test, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { longLivedMcpCallRoute } from '../../src/routes/long-lived-mcp.js';

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
    log: { info: () => {}, warn: () => {}, error: () => {} } as any,
    agentRegistry: null,
    agentRouting: null,
    providerQuotas: [],
    subscriptionPressureCache: {} as any,
    planWriter: {} as any,
  } as Services;
}

function withToken<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PENUMBRA_TOKEN;
  process.env.PENUMBRA_TOKEN = token;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.PENUMBRA_TOKEN;
    else process.env.PENUMBRA_TOKEN = prev;
  });
}

function authHeaders(token = 'tok'): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function seedRunningIdentity(db: Database): void {
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
    '[]',
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
  db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
      completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('tick-1', 'agent-1', null, 'manual', null, null, 1, null, null, null, null, null);
}

test('POST /long-lived/mcp/call returns 400 for malformed body', async () => {
  await withToken('tok', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const services = makeServices(db);
    const res = await longLivedMcpCallRoute(new Request('http://x/long-lived/mcp/call', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent_id: 'agent-1', tick_id: 'tick-1', tool: 'bad-tool' }),
    }), services);
    expect(res.status).toBe(400);
  });
});

test('POST /long-lived/mcp/call accepts dotted tool ids like ha:light.toggle', async () => {
  await withToken('tok', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock(async () => ({ kind: 'executed', result: 'ok', tier: 1 as const }));
    const services = makeServices(db);
    services.actionGate = { handleCall } as any;

    const res = await longLivedMcpCallRoute(new Request('http://x/long-lived/mcp/call', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent_id: 'agent-1', tick_id: 'tick-1', tool: 'ha:light.toggle' }),
    }), services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action_status: 'executed', result: 'ok' });
  });
});

test('POST /long-lived/mcp/call rejects payloads larger than 1 MiB', async () => {
  await withToken('tok', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const services = makeServices(db);
    const res = await longLivedMcpCallRoute(new Request('http://x/long-lived/mcp/call', {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'content-length': '2000000',
      },
      body: JSON.stringify({ agent_id: 'agent-1', tick_id: 'tick-1', tool: 'ha:state_get' }),
    }), services);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });
});

test('POST /long-lived/mcp/call returns 403 when identity does not match', async () => {
  await withToken('tok', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const services = makeServices(db);
    const res = await longLivedMcpCallRoute(new Request('http://x/long-lived/mcp/call', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent_id: 'agent-1', tick_id: 'tick-1', tool: 'ha:state_get' }),
    }), services);
    expect(res.status).toBe(403);
  });
});

test('POST /long-lived/mcp/call returns 503 when the action gate is missing', async () => {
  await withToken('tok', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const services = makeServices(db);
    const res = await longLivedMcpCallRoute(new Request('http://x/long-lived/mcp/call', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent_id: 'agent-1', tick_id: 'tick-1', tool: 'ha:state_get' }),
    }), services);
    expect(res.status).toBe(503);
  });
});

test('POST /long-lived/mcp/call normalizes executed gate results', async () => {
  await withToken('tok', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock(async () => ({ kind: 'executed', result: { x: 1 }, tier: 1 as const }));
    const services = makeServices(db);
    services.actionGate = { handleCall } as any;

    const res = await longLivedMcpCallRoute(new Request('http://x/long-lived/mcp/call', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent_id: 'agent-1', tick_id: 'tick-1', tool: 'ha:state_get' }),
    }), services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action_status: 'executed', result: { x: 1 } });
  });
});

test('POST /long-lived/mcp/call normalizes queued gate results', async () => {
  await withToken('tok', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock(async () => ({ kind: 'queued', pending_action_id: 'abc' }));
    const services = makeServices(db);
    services.actionGate = { handleCall } as any;

    const res = await longLivedMcpCallRoute(new Request('http://x/long-lived/mcp/call', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent_id: 'agent-1', tick_id: 'tick-1', tool: 'ha:state_get' }),
    }), services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      action_status: 'queued',
      pending_action_id: 'abc',
      message: 'Action requires operator approval. Record an open_thread referencing pending_action_id.',
    });
  });
});

test('POST /long-lived/mcp/call normalizes rejected gate results without details', async () => {
  await withToken('tok', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock(async () => ({ kind: 'rejected', error: 'not_in_allowlist' }));
    const services = makeServices(db);
    services.actionGate = { handleCall } as any;

    const res = await longLivedMcpCallRoute(new Request('http://x/long-lived/mcp/call', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent_id: 'agent-1', tick_id: 'tick-1', tool: 'ha:state_get' }),
    }), services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action_status: 'rejected', error: 'not_in_allowlist' });
  });
});

test('POST /long-lived/mcp/call normalizes rejected gate results with details', async () => {
  await withToken('tok', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock(async () => ({ kind: 'rejected', error: 'mcp_call_timeout', details: { timeout_ms: 30000 } }));
    const services = makeServices(db);
    services.actionGate = { handleCall } as any;

    const res = await longLivedMcpCallRoute(new Request('http://x/long-lived/mcp/call', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent_id: 'agent-1', tick_id: 'tick-1', tool: 'ha:state_get' }),
    }), services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      action_status: 'rejected',
      error: 'mcp_call_timeout',
      details: { timeout_ms: 30000 },
    });
  });
});

test('POST /long-lived/mcp/call accepts a verified running identity', async () => {
  await withToken('tok', async () => {
    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock(async () => ({ kind: 'executed', result: { ok: true }, tier: 1 as const }));
    const services = makeServices(db);
    services.actionGate = { handleCall } as any;

    const res = await longLivedMcpCallRoute(new Request('http://x/long-lived/mcp/call', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ agent_id: 'agent-1', tick_id: 'tick-1', tool: 'ha:state_get', args: { a: 1 } }),
    }), services);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action_status: 'executed', result: { ok: true } });
    expect(handleCall).toHaveBeenCalledWith({
      agent_id: 'agent-1',
      tick_id: 'tick-1',
      tool: 'ha:state_get',
      args: { a: 1 },
    });
  });
});

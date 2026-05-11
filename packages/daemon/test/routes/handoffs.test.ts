import { expect, test } from 'bun:test';
import {
  handoffsCreateRoute,
  handoffsListPendingRoute,
  handoffsLatestRoute,
  handoffsApproveRoute,
  handoffsClaimRoute,
  handoffsCompleteRoute,
  handoffsFailRoute,
  handoffsGetRoute,
} from '../../src/routes/handoffs.js';
import { type Services, migrate, loadSqliteVec, HandoffWriter, HandoffReader, AgentPerformanceWriter, DispatchEventLog } from '@penumbra/core';
import { Database } from 'bun:sqlite';
import { reconcileLongLivedAgents } from '../../src/long-lived/reconciler.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch { /* already loaded */ }

function makeServices(db: Database): Services {
  const writer = new HandoffWriter({ db });
  const reader = new HandoffReader({ db });
  return {
    db,
    handoffWriter: writer,
    handoffReader: reader,
    dispatchEventLog: new DispatchEventLog(db),
    machineId: { get: () => 'machine-test' },
    uuid: (() => { let n = 0; return () => `evt-${++n}`; })(),
    clock: () => new Date('2026-04-25T20:00:00.000Z'),
    t0Writer: { write: () => {} },
    redactor: { redact: (s: unknown) => s },
    log: { info: () => {}, warn: () => {} },
  } as unknown as Services;
}

function seedPerformance(db: Database, input: {
  performance_id: string;
  handoff_id: string;
  agent_name: string;
  outcome: 'merged' | 'failed';
}) {
  new AgentPerformanceWriter(db).upsert({
    performance_id: input.performance_id,
    ts: '2026-04-25T19:00:00.000Z',
    handoff_id: input.handoff_id,
    conversation_id: 'conv-ledger',
    project_id: null,
    agent_name: input.agent_name,
    task_type: 'implement_small',
    outcome: input.outcome,
    rounds: input.outcome === 'merged' ? 1 : 4,
    smoke_pass: input.outcome === 'merged' ? 'y' : 'n',
    reviewer_findings: null,
    maestro_score: 5,
    cost_usd: null,
    tokens_used: null,
    latency_ms: null,
    source: 'manual_seed',
    notes: null,
    metadata_json: '{}',
  });
}

test('POST /handoffs creates a pending handoff and returns the id', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const req = new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude',
      to: 'gemini',
      to_role: 'executor',
      message: 'go',
      conversation_id: 'conv-7',
      project_id: 'auth-svc',
      triggered_by_event_id: 'evt-source-1',
    }),
  });
  const res = await handoffsCreateRoute(req, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('pending');
  expect(typeof body.handoff_id).toBe('string');

  const row = db.query<{ status: string }, [string]>(
    'SELECT status FROM handoffs WHERE handoff_id=?',
  ).get(body.handoff_id);
  expect(row?.status).toBe('pending');
});

test('POST /handoffs routes role targets through the ledger', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.agentRegistry = ['gemini', 'codex-mini'];
  services.agentRouting = {
    agents: [
      { name: 'gemini', roles: ['executor'] },
      { name: 'codex-mini', roles: ['executor'] },
    ],
    default_roles: { executor: 'gemini' },
  };
  seedPerformance(db, {
    performance_id: 'p-good',
    handoff_id: 'h-good',
    agent_name: 'codex-mini',
    outcome: 'merged',
  });
  seedPerformance(db, {
    performance_id: 'p-bad',
    handoff_id: 'h-bad',
    agent_name: 'gemini',
    outcome: 'failed',
  });

  const res = await handoffsCreateRoute(new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'planner',
      to: 'gemini',
      to_role: 'executor',
      message: 'Task type: implement_small\n\nimplement the tiny change',
      conversation_id: 'conv-7',
      project_id: null,
      triggered_by_event_id: 'evt-source-1',
    }),
  }), services);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.routed_agent).toBe('codex-mini');
  expect(body.routed_role).toBe('executor');
  expect(body.routing_task_type).toBe('implement_small');

  const row = db.query<{ to_agent: string; to_role: string | null; chain_task_type: string | null }, [string]>(
    'SELECT to_agent, to_role, chain_task_type FROM handoffs WHERE handoff_id=?',
  ).get(body.handoff_id);
  expect(row).toEqual({
    to_agent: 'codex-mini',
    to_role: 'executor',
    chain_task_type: 'implement_small',
  });
});

test('POST /handoffs honors ranked-first exploration policy for role routing', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  services.agentRegistry = ['gemini', 'codex-mini'];
  services.agentRouting = {
    agents: [
      { name: 'gemini', roles: ['executor'] },
      { name: 'codex-mini', roles: ['executor'] },
    ],
    default_roles: { executor: 'gemini' },
    role_exploration_policy: 'ranked-first',
  };
  seedPerformance(db, {
    performance_id: 'p-good',
    handoff_id: 'h-good',
    agent_name: 'gemini',
    outcome: 'merged',
  });

  const res = await handoffsCreateRoute(new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'planner',
      to: 'gemini',
      to_role: 'executor',
      message: 'Task type: implement_small\n\nimplement the tiny change',
      conversation_id: 'conv-7',
      project_id: null,
      triggered_by_event_id: 'evt-source-1',
    }),
  }), services);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.routed_agent).toBe('gemini');
  expect(body.routed_role).toBe('executor');

  const row = db.query<{ to_agent: string; to_role: string | null }, [string]>(
    'SELECT to_agent, to_role FROM handoffs WHERE handoff_id=?',
  ).get(body.handoff_id);
  expect(row).toEqual({
    to_agent: 'gemini',
    to_role: 'executor',
  });
});

test('POST /handoffs returns 400 for invalid body', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const req = new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({ from: 'claude' }),
  });
  const res = await handoffsCreateRoute(req, services);
  expect(res.status).toBe(400);
});

test('GET /handoffs/pending returns pending handoffs', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  // seed via the create route
  await handoffsCreateRoute(new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude', to: 'gemini', to_role: 'executor', message: 'go',
      conversation_id: 'c-1', project_id: 'auth-svc', triggered_by_event_id: 'e',
    }),
  }), services);

  const res = await handoffsListPendingRoute(
    new Request('http://x/handoffs/pending'), services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0].status).toBe('pending');
});

test('GET /handoffs/latest returns 400 if conversation_id is missing', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsLatestRoute(new Request(`http://x/handoffs/latest`), services);
  expect(res.status).toBe(400);
});

test('GET /handoffs/latest returns 404 if no handoffs exist for conversation', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsLatestRoute(new Request(`http://x/handoffs/latest?conversation_id=c-latest-404`), services);
  expect(res.status).toBe(404);
});

test('GET /handoffs/latest returns the most recent handoff for a conversation', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  
  services.handoffWriter.createApproved({
    handoff_id: 'h1', ts: '2026-04-26T12:00:00Z', project_id: 'p1', conversation_id: 'c-latest-200',
    from: 'user', to: 'agent', to_role: null, message: 'hi', triggered_by_event_id: 'e1',
    resolved_by: 'system', resolved_at: '2026-04-26T12:00:00Z', chain_max_hops: null, chain_trust_mode: null,
  });
  services.handoffWriter.createApproved({
    handoff_id: 'h2', ts: '2026-04-26T12:05:00Z', project_id: 'p1', conversation_id: 'c-latest-200',
    from: 'user', to: 'agent2', to_role: null, message: 'hi again', triggered_by_event_id: 'e2',
    resolved_by: 'system', resolved_at: '2026-04-26T12:05:00Z', chain_max_hops: null, chain_trust_mode: null,
  });

  const res = await handoffsLatestRoute(new Request(`http://x/handoffs/latest?conversation_id=c-latest-200`), services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.handoff.handoff_id).toBe('h2');
});

test('POST /handoffs/:id/approve flips to approved', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const createReq = new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude', to: 'gemini', to_role: 'executor', message: 'go',
      conversation_id: 'c-1', project_id: 'auth-svc', triggered_by_event_id: 'e',
    }),
  });
  const createRes = await handoffsCreateRoute(createReq, services);
  const create = await createRes.json();
  const id = create.handoff_id;

  const res = await handoffsApproveRoute(
    new Request(`http://x/handoffs/${id}/approve`, { method: 'POST', body: '{}' }),
    id, services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('approved');
});

test('POST /handoffs/:id/approve returns 409 if already resolved', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const createReq = new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude', to: 'gemini', to_role: 'executor', message: 'go',
      conversation_id: 'c-1', project_id: 'auth-svc', triggered_by_event_id: 'e',
    }),
  });
  const createRes = await handoffsCreateRoute(createReq, services);
  const create = await createRes.json();
  const id = create.handoff_id;

  await handoffsApproveRoute(new Request(`http://x/handoffs/${id}/approve`, {
    method: 'POST', body: '{}',
  }), id, services);
  const second = await handoffsApproveRoute(new Request(`http://x/handoffs/${id}/approve`, {
    method: 'POST', body: '{}',
  }), id, services);
  expect(second.status).toBe(409);
});

test('POST /handoffs/:id/approve accepts optional resolved_by override', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const createReq = new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'claude', to: 'gemini', to_role: 'executor', message: 'go',
      conversation_id: 'c-1', project_id: 'auth-svc', triggered_by_event_id: 'e',
    }),
  });
  const createRes = await handoffsCreateRoute(createReq, services);
  const create = await createRes.json();
  const id = create.handoff_id;

  const res = await handoffsApproveRoute(
    new Request(`http://x/handoffs/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ resolved_by: 'auto' }),
    }),
    id, services,
  );
  expect(res.status).toBe(200);

  const row = db.query<{ resolved_by: string | null }, [string]>(
    'SELECT resolved_by FROM handoffs WHERE handoff_id=?',
  ).get(id);
  expect(row?.resolved_by).toBe('auto');
});

test('GET /handoffs?status=approved returns only approved rows', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  // seed two handoffs
  await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm1', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services);
  const created2 = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm2', conversation_id: 'c1', triggered_by_event_id: 'e2' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${created2.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    created2.handoff_id, services);

  const res = await handoffsListPendingRoute(
    new Request(`http://x/handoffs?status=approved`), services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0].handoff_id).toBe(created2.handoff_id);
  expect(body.handoffs[0].status).toBe('approved');
});

test('GET /handoffs?status=pending,approved returns both', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);

  const c1 = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm1', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  const c2 = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm2', conversation_id: 'c1', triggered_by_event_id: 'e2' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${c2.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    c2.handoff_id, services);

  const res = await handoffsListPendingRoute(
    new Request(`http://x/handoffs?status=pending,approved`), services,
  );
  const body = await res.json();
  const ids = body.handoffs.map((h: any) => h.handoff_id).sort();
  expect(ids).toEqual([c1.handoff_id, c2.handoff_id].sort());
});

test('GET /handoffs without status param defaults to pending (back-compat)', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services);

  const res = await handoffsListPendingRoute(
    new Request(`http://x/handoffs`), services,
  );
  const body = await res.json();
  expect(body.handoffs.length).toBe(1);
  expect(body.handoffs[0].status).toBe('pending');
});

test('GET /handoffs?status=garbage returns 400', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsListPendingRoute(
    new Request(`http://x/handoffs?status=garbage`), services,
  );
  expect(res.status).toBe(400);
});

test('GET /handoffs?status=completed&since returns completed count since timestamp', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const insert = db.query(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status, resolved_at)
    VALUES (?, ?, 'c1', 'a', 'b', 'm', 'completed', ?)
  `);
  insert.run('recent-resolved', '2026-04-25T18:00:00.000Z', '2026-04-25T19:30:00.000Z');
  insert.run('old-resolved', '2026-04-25T18:00:00.000Z', '2026-04-25T18:30:00.000Z');
  insert.run('legacy-recent', '2026-04-25T19:15:00.000Z', null);

  const res = await handoffsListPendingRoute(
    new Request('http://x/handoffs?status=completed&since=2026-04-25T19%3A00%3A00.000Z'),
    services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ done: 2 });
});

async function seedApproveClaim(services: Services): Promise<string> {
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    create.handoff_id, services);
  await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: 'test-worker' }) }), create.handoff_id, services);
  return create.handoff_id;
}

function seedLongLivedAgentAndTick(db: Database, opts: { agent_id: string; tick_id: string }): void {
  reconcileLongLivedAgents(db, [{
    name: opts.agent_id,
    long_lived: true,
    long_lived_config: {
      schedule_cron: '*/15 * * * *',
      subscriptions: [],
      mcp_allowlist: [],
      bounds: { wall_clock_ms: 1000, cost_cents: 1, max_sub_dispatches: 0 },
      circuit_breaker_threshold: 3,
      standing_brief: 'x',
    },
  } as any], { now: 1 });
  db.query('INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES (?, ?, ?, ?)').run(
    opts.tick_id,
    opts.agent_id,
    'manual',
    1,
  );
}

function seedLongLivedDispatchedHandoff(services: Services, opts: { handoff_id: string; agent_id: string; tick_id: string }): string {
  services.handoffWriter.createApproved({
    handoff_id: opts.handoff_id,
    ts: '2026-04-25T20:00:00.000Z',
    project_id: null,
    conversation_id: `conv-${opts.handoff_id}`,
    from: 'a',
    to: 'b',
    to_role: null,
    message: 'm',
    triggered_by_event_id: 'e1',
    resolved_by: 'machine-test',
    resolved_at: '2026-04-25T20:00:00.000Z',
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    dispatch_kind: 'long_lived_tick',
    long_lived_agent_id: opts.agent_id,
    long_lived_tick_id: opts.tick_id,
    use_worktree: null,
    open_pr_on_review: null,
    parent_handoff_id: null,
    branch_base: null,
  });
  services.handoffWriter.claimDispatch(opts.handoff_id, 'test-worker');
  return opts.handoff_id;
}

test('POST /handoffs/<id>/complete flips dispatched → completed', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedApproveClaim(services);

  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), id, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ handoff_id: id, status: 'completed' });
  const row = db.query<{ status: string }, [string]>(`SELECT status FROM handoffs WHERE handoff_id=?`).get(id);
  expect(row?.status).toBe('completed');
});

test('POST /handoffs/<id>/complete tears down long-lived tick as success', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, { agent_id: 'agent-1', tick_id: 'tick-1' });
  const id = seedLongLivedDispatchedHandoff(services, {
    handoff_id: 'h-long-complete',
    agent_id: 'agent-1',
    tick_id: 'tick-1',
  });

  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), id, services);
  expect(res.status).toBe(200);

  const tick = db.query<{ outcome: string | null }, [string]>(
    'SELECT outcome FROM long_lived_ticks WHERE id=?',
  ).get('tick-1');
  expect(tick?.outcome).toBe('success');
});

test('POST /handoffs/<id>/complete cancel path tears down long-lived tick as failed', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, { agent_id: 'agent-cancel', tick_id: 'tick-cancel' });
  const id = seedLongLivedDispatchedHandoff(services, {
    handoff_id: 'h-long-cancel',
    agent_id: 'agent-cancel',
    tick_id: 'tick-cancel',
  });
  db.query('UPDATE handoffs SET cancel_requested_at=? WHERE handoff_id=?').run('2026-04-25T20:01:00.000Z', id);

  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), id, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ handoff_id: id, status: 'failed', reason: 'cancelled' });

  const tick = db.query<{ outcome: string | null; completed_at: number | null }, [string]>(
    'SELECT outcome, completed_at FROM long_lived_ticks WHERE id=?',
  ).get('tick-cancel');
  expect(tick?.outcome).toBe('failed');
  expect(tick?.completed_at).not.toBeNull();
});

test('POST /handoffs/<id>/complete for non-long-lived handoff leaves long-lived ticks untouched', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, { agent_id: 'agent-2', tick_id: 'tick-2' });
  const id = await seedApproveClaim(services);

  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), id, services);
  expect(res.status).toBe(200);

  const tick = db.query<{ outcome: string | null }, [string]>(
    'SELECT outcome FROM long_lived_ticks WHERE id=?',
  ).get('tick-2');
  expect(tick?.outcome).toBeNull();
});

test('POST /handoffs/<id>/complete returns success when long-lived teardown throws', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, { agent_id: 'agent-throw', tick_id: 'tick-throw' });
  const id = seedLongLivedDispatchedHandoff(services, {
    handoff_id: 'h-long-throw',
    agent_id: 'agent-throw',
    tick_id: 'tick-throw',
  });

  const originalTransaction = db.transaction.bind(db);
  let injected = false;
  db.transaction = ((fn: () => void) => originalTransaction(() => {
    fn();
    if (!injected) {
      injected = true;
      throw new Error('teardown boom');
    }
  })) as typeof db.transaction;

  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), id, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ handoff_id: id, status: 'completed' });

  const handoff = db.query<{ status: string }, [string]>('SELECT status FROM handoffs WHERE handoff_id=?').get(id);
  expect(handoff?.status).toBe('completed');
});

test('POST /handoffs/<id>/complete on a pending handoff returns 409', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();

  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), create.handoff_id, services);
  expect(res.status).toBe(409);
});

test('POST /handoffs/<id>/complete on unknown id returns 404', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), 'h-nope', services);
  expect(res.status).toBe(404);
});

async function seedAndApprove(services: Services): Promise<string> {
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();
  await handoffsApproveRoute(new Request(`http://x/handoffs/${create.handoff_id}/approve`, { method: 'POST', body: '{}' }),
    create.handoff_id, services);
  return create.handoff_id;
}

test('POST /handoffs/<id>/claim flips approved → dispatched and returns 200', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedAndApprove(services);

  const res = await handoffsClaimRoute(new Request(`http://x/handoffs/${id}/claim`, { method: 'POST', body: JSON.stringify({ worker_id: 'test-worker' }) }), id, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ handoff_id: id, status: 'dispatched' });
  const row = db.query<{ status: string }, [string]>(`SELECT status FROM handoffs WHERE handoff_id=?`).get(id);
  expect(row?.status).toBe('dispatched');
});

test('POST /handoffs/<id>/claim a second time returns 409 with current_status', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedAndApprove(services);
  await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: 'test-worker' }) }), id, services);

  const second = await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: 'test-worker' }) }), id, services);
  expect(second.status).toBe(409);
  const body = await second.json();
  expect(body.current_status).toBe('dispatched');
});

test('POST /handoffs/<id>/claim on unknown id returns 404', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: 'test-worker' }) }), 'h-nope', services);
  expect(res.status).toBe(404);
});

test('POST /handoffs/<id>/claim on a pending handoff returns 409 (not approved)', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();

  const res = await handoffsClaimRoute(new Request('http://x', { method: 'POST', body: JSON.stringify({ worker_id: 'test-worker' }) }), create.handoff_id, services);
  expect(res.status).toBe(409);
});

test('POST /handoffs/<id>/fail flips pending → failed', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();

  const res = await handoffsFailRoute(new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({ reason: 'testing failure' }),
  }), create.handoff_id, services);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ handoff_id: create.handoff_id, status: 'failed' });
  
  const row = db.query<{ status: string; resolution_reason: string | null }, [string]>(
    'SELECT status, resolution_reason FROM handoffs WHERE handoff_id=?',
  ).get(create.handoff_id);
  expect(row?.status).toBe('failed');
  expect(row?.resolution_reason).toBe('testing failure');
});

test('POST /handoffs/<id>/fail tears down long-lived tick as failed', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, { agent_id: 'agent-3', tick_id: 'tick-3' });
  const id = seedLongLivedDispatchedHandoff(services, {
    handoff_id: 'h-long-fail',
    agent_id: 'agent-3',
    tick_id: 'tick-3',
  });

  const res = await handoffsFailRoute(new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({ reason: 'long-lived failure' }),
  }), id, services);

  expect(res.status).toBe(200);
  const tick = db.query<{ outcome: string | null }, [string]>(
    'SELECT outcome FROM long_lived_ticks WHERE id=?',
  ).get('tick-3');
  expect(tick?.outcome).toBe('failed');
});

test('POST /handoffs/:id/approve reject path tears down long-lived tick as failed', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  seedLongLivedAgentAndTick(db, { agent_id: 'agent-reject', tick_id: 'tick-reject' });
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', {
    method: 'POST',
    body: JSON.stringify({
      from: 'a',
      to: 'b',
      message: 'm',
      conversation_id: 'c-reject',
      triggered_by_event_id: 'e1',
    }),
  }), services)).json();
  db.query(
    'UPDATE handoffs SET dispatch_kind=?, long_lived_agent_id=?, long_lived_tick_id=? WHERE handoff_id=?',
  ).run('long_lived_tick', 'agent-reject', 'tick-reject', create.handoff_id);

  const res = await handoffsApproveRoute(
    new Request(`http://x/handoffs/${create.handoff_id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reject: true, reason: 'nope', resolved_by: 'operator-1' }),
    }),
    create.handoff_id,
    services,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ handoff_id: create.handoff_id, status: 'rejected' });

  const tick = db.query<{ outcome: string | null; completed_at: number | null }, [string]>(
    'SELECT outcome, completed_at FROM long_lived_ticks WHERE id=?',
  ).get('tick-reject');
  expect(tick?.outcome).toBe('failed');
  expect(tick?.completed_at).not.toBeNull();
});

test('POST /handoffs/<id>/fail returns 400 for missing/empty reason', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  
  const res = await handoffsFailRoute(new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({ reason: '' }),
  }), 'some-id', services);
  expect(res.status).toBe(400);

  const res2 = await handoffsFailRoute(new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({}),
  }), 'some-id', services);
  expect(res2.status).toBe(400);
});

test('POST /handoffs/<id>/fail returns 404 for unknown id', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  
  const res = await handoffsFailRoute(new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({ reason: 'oops' }),
  }), 'h-nope', services);
  expect(res.status).toBe(404);
});

test('POST /handoffs/<id>/fail returns 409 if already terminal', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const id = await seedApproveClaim(services);
  await handoffsCompleteRoute(new Request('http://x', { method: 'POST' }), id, services);

  const res = await handoffsFailRoute(new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({ reason: 'too late' }),
  }), id, services);
  
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.current_status).toBe('completed');
});

test('GET /handoffs/<id> returns the handoff row', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const create = await (await handoffsCreateRoute(new Request('http://x/handoffs', { method: 'POST',
    body: JSON.stringify({ from: 'a', to: 'b', message: 'm', conversation_id: 'c1', triggered_by_event_id: 'e1' }) }), services)).json();

  const res = await handoffsGetRoute(new Request(`http://x/handoffs/${create.handoff_id}`), create.handoff_id, services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.handoff.handoff_id).toBe(create.handoff_id);
  expect(body.handoff.status).toBe('pending');
});

test('GET /handoffs/<id> returns 404 for unknown id', async () => {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await handoffsGetRoute(new Request('http://x/handoffs/h-nope'), 'h-nope', services);
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body.error.code).toBe('not_found');
});

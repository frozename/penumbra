import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AgentPerformanceWriter, buildServices, loadSqliteVec, migrate, type AgentRoutingConfig, type Services } from '@penumbra/core';
import { ChainStartResponseSchema } from '../../../api-contract/src/chains.js';
import { ProjectRegistry } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { createWorkflowRunsRegistry } from '../../src/services/workflow-runs-registry.js';
import { handoffsCreateRoute, handoffsApproveRoute, handoffsClaimRoute, handoffsCompleteRoute } from '../../src/routes/handoffs.js';
import { chainsStartRoute, chainsHistoryRoute, chainsResponsesRoute, chainsListAgentsRoute, chainSendMessageRoute, chainStartFromInput } from '../../src/routes/chains.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function tempServices(opts?: {
  agentRegistry?: string[] | null;
  agentRouting?: AgentRoutingConfig | null;
  projectRegistry?: ProjectRegistry;
}): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {}, input: {}, storageRoot: '/tmp/chains-test', db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: () => `id-${++n}`,
    agentRegistry: opts?.agentRegistry,
    agentRouting: opts?.agentRouting,
    worktreeRootDir: '/private/tmp/penumbra-test-worktrees',
  });
  services.projectRegistry = opts?.projectRegistry;
  // Mock watchdog for chains testing (by default hasActiveWorker=true to pass existing tests)
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };
  return services;
}

let previousDaemonRequireExplicitProjectId: string | undefined;
let previousRequirePromptProjectMatch: string | undefined;

beforeEach(() => {
  previousDaemonRequireExplicitProjectId = process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  previousRequirePromptProjectMatch = process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  delete process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
});

afterEach(() => {
  if (previousDaemonRequireExplicitProjectId === undefined) {
    delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  } else {
    process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = previousDaemonRequireExplicitProjectId;
  }
  if (previousRequirePromptProjectMatch === undefined) {
    delete process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
  } else {
    process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = previousRequirePromptProjectMatch;
  }
});

function seedPerformance(services: Services, input: {
  performance_id: string;
  handoff_id: string;
  agent_name: string;
  task_type: 'implement_substantial' | 'review_adversarial';
  outcome: 'merged' | 'failed';
  rounds?: number;
  smoke_pass?: 'y' | 'n';
}) {
  new AgentPerformanceWriter(services.db).upsert({
    performance_id: input.performance_id,
    ts: '2026-04-25T00:00:00.000Z',
    handoff_id: input.handoff_id,
    conversation_id: 'conv-ledger',
    project_id: null,
    agent_name: input.agent_name,
    task_type: input.task_type,
    outcome: input.outcome,
    rounds: input.rounds ?? 1,
    smoke_pass: input.smoke_pass ?? 'y',
    reviewer_findings: null,
    maestro_score: 5,
    cost_usd: 100,
    tokens_used: null,
    latency_ms: null,
    source: 'manual_seed',
    notes: null,
    metadata_json: '{}',
  });
}

function writeAgentResponse(
  services: Services,
  input: {
    event_id: string;
    ts: string;
    ingest_ts?: string;
    source?: string;
    source_detail?: string | null;
    user_id?: string;
    session_id: string;
    payload_json: unknown;
  },
) {
  services.t0Writer.write({
    event_id: input.event_id,
    ts: input.ts,
    ingest_ts: input.ingest_ts ?? input.ts,
    source: input.source ?? 'agentchat',
    source_detail: input.source_detail ?? null,
    project_id: null,
    user_id: input.user_id ?? 'u1',
    machine_id: 'm1',
    session_id: input.session_id,
    event_type: 'agent-response',
    lane: 'local',
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: input.payload_json as any,
    payload_summary: 'response',
  });
}

function writeConversationMarker(services: Services, session_id: string) {
  services.t0Writer.write({
    event_id: `marker-${session_id}`,
    ts: '2026-04-26T11:00:00Z',
    ingest_ts: '2026-04-26T11:00:00Z',
    source: 'agentchat',
    source_detail: 'chain-start',
    project_id: null,
    user_id: 'local-user',
    machine_id: 'm1',
    session_id,
    event_type: 'user-prompt',
    lane: 'local',
    provider: null,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: { prompt: 'hi' },
    payload_summary: 'hi',
  });
}

async function createHandoff(services: Services, conversation_id: string): Promise<string> {
  const res = await handoffsCreateRoute(
    new Request('http://x/handoffs', {
      method: 'POST',
      body: JSON.stringify({
        from: 'user',
        to: 'agent',
        message: 'go',
        conversation_id,
        triggered_by_event_id: 'evt-1',
      }),
    }),
    services,
  );
  const body = await res.json() as { handoff_id: string };
  return body.handoff_id;
}

test('POST /chains/start returns 400 if initial_agent is not in registry', async () => {
  const services = tempServices({ agentRegistry: ['planner', 'executor'] });
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'bogus-agent', message: 'hi' }) }), services);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe('unknown_agent');
  expect(body.error.agent).toBe('bogus-agent');
  expect(body.error.hint).toBe('use chain.list_agents to enumerate valid agents');
});

test('POST /chains/start does not run DDL on the request path', async () => {
  const services = tempServices();
  const originalExec = services.db.exec.bind(services.db);
  const originalQuery = services.db.query.bind(services.db);
  const ddlCalls: string[] = [];
  const ddlRe = /\b(?:PRAGMA|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\b/i;

  (services.db as any).exec = (sql: string) => {
    if (ddlRe.test(sql)) ddlCalls.push(`exec:${sql}`);
    return originalExec(sql);
  };
  (services.db as any).query = (sql: string, ...rest: any[]) => {
    if (ddlRe.test(sql)) ddlCalls.push(`query:${sql}`);
    return originalQuery(sql, ...rest);
  };

  const res = await chainsStartRoute(
    new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({ initial_agent: 'codex', message: 'hi' }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  expect(ddlCalls).toEqual([]);
});

test('POST /chains/start allows missing project_id when daemon hard-mode gate is unset', async () => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({ initial_agent: 'codex', message: 'hi' }),
    }),
    services,
  );

  expect(res.status).toBe(200);
});

test('POST /chains/start rejects missing project_id when daemon hard-mode gate is enabled', async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = '1';
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({ initial_agent: 'codex', message: 'hi' }),
    }),
    services,
  );

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: 'project_id_required',
    hint: 'pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior',
  });
});

test('POST /chains/start rejects missing project_id when no dispatch exemption is present', async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = '1';
  const services = tempServices();
  services.db.query(
    `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'agent-42',
    'Home Assistant',
    JSON.stringify({
      version: 1,
      updated_at: 1715385600000,
      pending_goals: [],
      open_threads: [],
      watches: [],
      recent_decisions: [],
    }),
    'Keep home automations healthy',
    1715385600000,
    1715385600000,
  );
  services.db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
  ).run('tick-42', 'agent-42', 'manual', 1715385600000);

  const res = await chainsStartRoute(
    new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({
        initial_agent: 'codex',
        message: 'hi',
        dispatch_kind: 'long_lived_tick',
      }),
    }),
    services,
  );

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: 'project_id_required',
    hint: 'pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior',
  });
});

test('POST /chains/start exempts long_lived_tick dispatches with a valid tick id from the explicit project gate', async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = '1';
  const services = tempServices();
  services.db.query(
    `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'agent-42',
    'Home Assistant',
    JSON.stringify({
      version: 1,
      updated_at: 1715385600000,
      pending_goals: [],
      open_threads: [],
      watches: [],
      recent_decisions: [],
    }),
    'Keep home automations healthy',
    1715385600000,
    1715385600000,
  );
  services.db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
  ).run('tick-42', 'agent-42', 'manual', 1715385600000);

  const logSpy = spyOn(services.log, 'info').mockImplementation(() => undefined as any);
  const res = await chainsStartRoute(
    new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({
        initial_agent: 'codex',
        message: 'hi',
        dispatch_kind: 'long_lived_tick',
        long_lived_agent_id: 'agent-42',
        long_lived_tick_id: 'tick-42',
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  expect(logSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'chain_start.routing_guard.explicit_gate_exempted',
      dispatch_kind: 'long_lived_tick',
      long_lived_tick_id: 'tick-42',
      workflow_run_id: null,
    }),
    expect.any(String),
  );
});

test('POST /chains/start rejects forged long_lived_tick dispatch exemptions', async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = '1';
  const services = tempServices();

  const missingTickRes = await chainsStartRoute(
    new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({
        initial_agent: 'codex',
        message: 'hi',
        dispatch_kind: 'long_lived_tick',
        long_lived_agent_id: 'agent-42',
        long_lived_tick_id: 'missing-tick',
      }),
    }),
    services,
  );
  expect(missingTickRes.status).toBe(400);
  expect(await missingTickRes.json()).toEqual({
    error: 'project_id_required',
    hint: 'pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior',
  });

  const missingIdRes = await chainsStartRoute(
    new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({
        initial_agent: 'codex',
        message: 'hi',
        dispatch_kind: 'long_lived_tick',
      }),
    }),
    services,
  );
  expect(missingIdRes.status).toBe(400);
  expect(await missingIdRes.json()).toEqual({
    error: 'project_id_required',
    hint: 'pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior',
  });
});

test('POST /chains/start exempts workflow dispatches with a valid run id from the explicit project gate', async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = '1';
  const services = tempServices();
  services.workflowRuns = {
    verify: (workflowRunId: string) => workflowRunId === 'workflow-42'
      ? { workflow_name: 'home-mgmt', project_id: null, registered_at: 1715385600000 }
      : null,
    register: () => null,
    unregister: () => undefined,
    recordResult: async () => undefined,
    recordError: async () => undefined,
    getStatus: async () => null,
    waitForResult: async () => null,
    setPersistenceStatus: () => undefined,
    setExecutionRecord: () => undefined,
  } as any;

  const logSpy = spyOn(services.log, 'info').mockImplementation(() => undefined as any);
  const res = await chainsStartRoute(
    new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({
        initial_agent: 'codex',
        message: 'hi',
        dispatch_kind: 'workflow',
        workflow_run_id: 'workflow-42',
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  expect(logSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'chain_start.routing_guard.explicit_gate_exempted',
      dispatch_kind: 'workflow',
      long_lived_tick_id: null,
      workflow_run_id: 'workflow-42',
    }),
    expect.any(String),
  );
});

test('POST /chains/start rejects null project_id when daemon hard-mode gate is enabled', async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = 'true';
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({ initial_agent: 'codex', message: 'hi', project_id: null }),
    }),
    services,
  );

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: 'project_id_required',
    hint: 'pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior',
  });
});

test('POST /chains/start allows explicit project_id when daemon hard-mode gate is enabled', async () => {
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = 'on';
  const services = tempServices();
  const res = await chainsStartRoute(
    new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({ initial_agent: 'codex', message: 'hi', project_id: 'proj-123' }),
    }),
    services,
  );

  expect(res.status).toBe(200);
});

test('POST /chains/:handoff_id/messages injects content into a running ACP session', async () => {
  const services = tempServices();
  const handoff_id = await createHandoff(services, 'conv-running');

  const injected: Array<{ role: string; text: string }> = [];
  (services as any).workerManager = {
    lookupSession: async () => ({
      adapter: 'claude-acp-sonnet',
      inject: async (message: { role: 'user'; text: string }) => {
        injected.push(message);
      },
    }),
  };

  const res = await chainSendMessageRoute(
    new Request(`http://x/chains/${handoff_id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'answer the question' }),
    }),
    handoff_id,
    services,
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(injected).toEqual([{ role: 'user', text: 'answer the question' }]);
});

test('POST /chains/:handoff_id/messages returns 404 for an unknown handoff', async () => {
  const services = tempServices();
  (services as any).workerManager = {
    lookupSession: async () => null,
  };

  const res = await chainSendMessageRoute(
    new Request('http://x/chains/h-missing/messages', {
      method: 'POST',
      body: JSON.stringify({ content: 'hello' }),
    }),
    'h-missing',
    services,
  );

  expect(res.status).toBe(404);
});

test('POST /chains/:handoff_id/messages returns 409 when the adapter does not support injection', async () => {
  const services = tempServices();
  const handoff_id = await createHandoff(services, 'conv-unsupported');
  (services as any).workerManager = {
    lookupSession: async () => ({ adapter: null }),
  };

  const res = await chainSendMessageRoute(
    new Request(`http://x/chains/${handoff_id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'hello' }),
    }),
    handoff_id,
    services,
  );

  expect(res.status).toBe(409);
});

test('POST /chains/:handoff_id/messages returns 410 for a terminal handoff', async () => {
  const services = tempServices();
  const handoff_id = await createHandoff(services, 'conv-terminal');
  await handoffsApproveRoute(
    new Request(`http://x/handoffs/${handoff_id}/approve`, { method: 'POST', body: '{}' }),
    handoff_id,
    services,
  );
  await handoffsClaimRoute(
    new Request(`http://x/handoffs/${handoff_id}/claim`, {
      method: 'POST',
      body: JSON.stringify({ worker_id: 'worker-1' }),
    }),
    handoff_id,
    services,
  );
  await handoffsCompleteRoute(new Request(`http://x/handoffs/${handoff_id}/complete`, { method: 'POST' }), handoff_id, services);
  (services as any).workerManager = {
    lookupSession: async () => null,
  };

  const res = await chainSendMessageRoute(
    new Request(`http://x/chains/${handoff_id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'hello' }),
    }),
    handoff_id,
    services,
  );

  expect(res.status).toBe(410);
});

test('POST /chains/:handoff_id/messages returns 400 for missing content', async () => {
  const services = tempServices();
  const handoff_id = await createHandoff(services, 'conv-empty');
  const res = await chainSendMessageRoute(
    new Request(`http://x/chains/${handoff_id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: '' }),
    }),
    handoff_id,
    services,
  );
  expect(res.status).toBe(400);
});

test('POST /chains/start succeeds if initial_agent is in registry', async () => {
  const services = tempServices({ agentRegistry: ['planner', 'executor'] });
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi' }) }), services);
  expect(res.status).toBe(200);
});

test('POST /chains/start routes role targets to the best ledger-ranked role agent', async () => {
  const routing: AgentRoutingConfig = {
    agents: [
      { name: 'gemini', roles: ['executor'] },
      { name: 'codex-mini', roles: ['executor'] },
    ],
    default_roles: { executor: 'gemini' },
  };
  const services = tempServices({ agentRegistry: ['gemini', 'codex-mini'], agentRouting: routing });
  seedPerformance(services, {
    performance_id: 'p-good',
    handoff_id: 'h-good',
    agent_name: 'codex-mini',
    task_type: 'implement_substantial',
    outcome: 'merged',
    rounds: 1,
    smoke_pass: 'y',
  });
  seedPerformance(services, {
    performance_id: 'p-bad',
    handoff_id: 'h-bad',
    agent_name: 'gemini',
    task_type: 'implement_substantial',
    outcome: 'failed',
    rounds: 4,
    smoke_pass: 'n',
  });

  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({
      initial_agent: 'executor',
      task_type: 'implement_substantial',
      message: 'implement the change',
    }) }), services);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.routed_agent).toBe('codex-mini');
  expect(body.routed_role).toBe('executor');
  expect(body.routing_task_type).toBe('implement_substantial');
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.to_agent).toBe('codex-mini');
  expect(handoff.to_role).toBe('executor');
});

test('POST /chains/start treats a name that is also a configured role as a role target', async () => {
  const routing: AgentRoutingConfig = {
    agents: [
      { name: 'executor', roles: ['executor'] },
      { name: 'codex-spark', roles: ['executor'] },
    ],
    default_roles: { executor: 'executor' },
  };
  const services = tempServices({ agentRegistry: ['executor', 'codex-spark'], agentRouting: routing });

  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({
      initial_agent: 'executor',
      task_type: 'implement_substantial',
      message: 'implement the change',
    }) }), services);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.routed_agent).toBe('codex-spark');
  expect(body.routed_role).toBe('executor');
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.to_agent).toBe('codex-spark');
  expect(handoff.to_role).toBe('executor');
});

test('POST /chains/start supports agent: prefix to force exact routing through a role collision', async () => {
  const routing: AgentRoutingConfig = {
    agents: [
      { name: 'executor', roles: ['executor'] },
      { name: 'codex-spark', roles: ['executor'] },
    ],
    default_roles: { executor: 'executor' },
  };
  const services = tempServices({ agentRegistry: ['executor', 'codex-spark'], agentRouting: routing });

  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({
      initial_agent: 'agent:executor',
      task_type: 'implement_small',
      message: 'implement the change',
    }) }), services);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.routed_agent).toBeUndefined();
  expect(body.routed_role).toBeUndefined();
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.to_agent).toBe('executor');
  expect(handoff.to_role).toBeNull();
  expect(handoff.chain_task_type).toBe('implement_small');
});


test('POST /chains/start treats exact agent names as explicit routing even when role ranking exists', async () => {
  const routing: AgentRoutingConfig = {
    agents: [
      { name: 'gemini', roles: ['executor'] },
      { name: 'codex-mini', roles: ['executor'] },
    ],
    default_roles: { executor: 'gemini' },
  };
  const services = tempServices({ agentRegistry: ['gemini', 'codex-mini'], agentRouting: routing });
  seedPerformance(services, {
    performance_id: 'p-good',
    handoff_id: 'h-good',
    agent_name: 'codex-mini',
    task_type: 'implement_substantial',
    outcome: 'merged',
  });

  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({
      initial_agent: 'gemini',
      task_type: 'implement_substantial',
      message: 'implement the change',
    }) }), services);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.routed_agent).toBeUndefined();
  expect(body.routed_role).toBeUndefined();
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.to_agent).toBe('gemini');
  expect(handoff.to_role).toBeNull();
});

test('POST /chains/start explores an unsampled non-default role agent before the default', async () => {
  const routing: AgentRoutingConfig = {
    agents: [
      { name: 'gemini', roles: ['executor'] },
      { name: 'codex-mini', roles: ['executor'] },
    ],
    default_roles: { executor: 'gemini' },
  };
  const services = tempServices({ agentRegistry: ['gemini', 'codex-mini'], agentRouting: routing });

  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({
      initial_agent: 'executor',
      task_type: 'implement_substantial',
      message: 'implement the change',
    }) }), services);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.routed_agent).toBe('codex-mini');
  expect(body.routed_role).toBe('executor');
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.to_agent).toBe('codex-mini');
  expect(handoff.to_role).toBe('executor');
  expect(handoff.chain_task_type).toBe('implement_substantial');
});

test('POST /chains/start honors ranked-first exploration policy for role routing', async () => {
  const routing = {
    agents: [
      { name: 'gemini', roles: ['executor'] },
      { name: 'codex-mini', roles: ['executor'] },
    ],
    default_roles: { executor: 'gemini' },
    role_exploration_policy: 'ranked-first',
  } satisfies AgentRoutingConfig & { role_exploration_policy: 'ranked-first' };
  const services = tempServices({ agentRegistry: ['gemini', 'codex-mini'], agentRouting: routing });
  seedPerformance(services, {
    performance_id: 'p-good',
    handoff_id: 'h-good',
    agent_name: 'gemini',
    task_type: 'implement_substantial',
    outcome: 'merged',
    rounds: 1,
    smoke_pass: 'y',
  });

  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({
      initial_agent: 'executor',
      task_type: 'implement_substantial',
      message: 'implement the change',
    }) }), services);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.routed_agent).toBe('gemini');
  expect(body.routed_role).toBe('executor');
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.to_agent).toBe('gemini');
  expect(handoff.to_role).toBe('executor');
});

test('POST /chains/start falls back to default role agent when no alternate needs exploration', async () => {
  const routing: AgentRoutingConfig = {
    agents: [
      { name: 'gemini', roles: ['executor'] },
    ],
    default_roles: { executor: 'gemini' },
  };
  const services = tempServices({ agentRegistry: ['gemini'], agentRouting: routing });

  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({
      initial_agent: 'executor',
      task_type: 'implement_substantial',
      message: 'implement the change',
    }) }), services);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.routed_agent).toBe('gemini');
  expect(body.routed_role).toBe('executor');
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.to_agent).toBe('gemini');
  expect(handoff.to_role).toBe('executor');
});

test('chain-start drops unknown project_id and continues when registry has entries', async () => {
  const services = tempServices({ agentRegistry: ['planner'] });
  services.projectRegistry = new ProjectRegistry(new Map([
    ['penumbra', { project_id: 'penumbra', root_path: '/tmp/penumbra' }],
  ]));
  const warnSpy = spyOn(services.log, 'warn').mockImplementation(() => undefined as any);

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'hi',
      project_id: 'not-in-registry',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.error).toBeUndefined();
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      project_id: 'not-in-registry',
      known_project_ids: ['penumbra'],
    }),
    'chain-start unknown_project_id; dropping and continuing',
  );
});

test('chain-start accepts a project_id present in the registry', async () => {
  const services = tempServices({ agentRegistry: ['planner'] });
  services.projectRegistry = new ProjectRegistry(new Map([
    ['penumbra', { project_id: 'penumbra', root_path: '/tmp/penumbra' }],
  ]));

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'hi',
      project_id: 'penumbra',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
});

test('chain-start skips routing guard when project_id is null even with a populated registry', async () => {
  const services = tempServices({
    agentRegistry: ['planner'],
    projectRegistry: new ProjectRegistry(new Map([
      ['penumbra', { project_id: 'penumbra', root_path: '/Volumes/WorkSSD/repos/personal/penumbra' }],
      ['llamactl', { project_id: 'llamactl', root_path: '/Volumes/WorkSSD/repos/personal/llamactl' }],
    ])),
  });

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.routing_warning).toBeUndefined();
  expect(body.routing_advisory).toBeUndefined();
});

test('chain-start attaches a routing warning and dispatches when strict mode is off', async () => {
  const services = tempServices({
    agentRegistry: ['planner'],
    projectRegistry: new ProjectRegistry(new Map([
      ['penumbra', { project_id: 'penumbra', root_path: '/Volumes/WorkSSD/repos/personal/penumbra' }],
      ['llamactl', { project_id: 'llamactl', root_path: '/Volumes/WorkSSD/repos/personal/llamactl' }],
    ])),
  });
  delete process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
      project_id: 'penumbra',
      task_class: 'STANDARD',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body).toHaveProperty('routing_warning', expect.objectContaining({
    code: 'prompt_project_mismatch',
    project_id: 'penumbra',
    mentioned_paths: ['/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts'],
    missing_in_project: [],
    suggested_project_id: 'llamactl',
    hint: 'pass project_id explicitly or update prompt paths',
  }));
});

test('chain-start rejects prompt_project_mismatch in strict mode for user-initiated dispatches', async () => {
  const services = tempServices({
    agentRegistry: ['planner'],
    projectRegistry: new ProjectRegistry(new Map([
      ['penumbra', { project_id: 'penumbra', root_path: '/Volumes/WorkSSD/repos/personal/penumbra' }],
      ['llamactl', { project_id: 'llamactl', root_path: '/Volumes/WorkSSD/repos/personal/llamactl' }],
    ])),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = '1';

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
      project_id: 'penumbra',
      task_class: 'STANDARD',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'prompt_project_mismatch',
      project_id: 'penumbra',
      mentioned_paths: ['/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts'],
      missing_in_project: [],
      suggested_project_id: 'llamactl',
      hint: 'pass project_id explicitly or update prompt paths',
    },
  });
});

test('chain-start allows strict workflow dispatches to cross project prompts', async () => {
  const services = tempServices({
    agentRegistry: ['planner'],
    projectRegistry: new ProjectRegistry(new Map([
      ['penumbra', { project_id: 'penumbra', root_path: '/Volumes/WorkSSD/repos/personal/penumbra' }],
      ['llamactl', { project_id: 'llamactl', root_path: '/Volumes/WorkSSD/repos/personal/llamactl' }],
    ])),
  });
  const previous = process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = '1';
  services.workflowRuns = createWorkflowRunsRegistry({
    uuid: () => 'wfrun-1',
    clock: () => new Date('2026-04-26T00:00:00Z'),
    db: services.db,
    storageRoot: '/private/tmp/penumbra-test-storage',
  });
  const workflowRunId = services.workflowRuns.register('cross-project-workflow', 'penumbra');
  const warnSpy = spyOn(services.log, 'warn').mockImplementation(() => undefined as any);

  try {
    const req = new Request('http://t/chains/start', {
      method: 'POST',
      body: JSON.stringify({
        initial_agent: 'planner',
        message: 'review diff touching /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
        project_id: 'penumbra',
        dispatch_kind: 'workflow',
        workflow_run_id: workflowRunId,
        task_class: 'STANDARD',
      }),
    });
    const res = await chainsStartRoute(req, services);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toHaveProperty('routing_warning', expect.objectContaining({
      code: 'prompt_project_mismatch',
      project_id: 'penumbra',
    }));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'chain_start.routing_guard.internal_hop_mismatch',
        project_id: 'penumbra',
      }),
      expect.any(String),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
    } else {
      process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = previous;
    }
  }
});

test('chain-start rejects spoofed workflow dispatch_kind without valid workflow_run_id', async () => {
  const services = tempServices({
    agentRegistry: ['planner'],
    projectRegistry: new ProjectRegistry(new Map([
      ['penumbra', { project_id: 'penumbra', root_path: '/Volumes/WorkSSD/repos/personal/penumbra' }],
      ['llamactl', { project_id: 'llamactl', root_path: '/Volumes/WorkSSD/repos/personal/llamactl' }],
    ])),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = 'true';
  const warnSpy = spyOn(services.log, 'warn').mockImplementation(() => undefined as any);

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
      project_id: 'penumbra',
      dispatch_kind: 'workflow',
      task_class: 'STANDARD',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'prompt_project_mismatch',
      project_id: 'penumbra',
      mentioned_paths: ['/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts'],
      missing_in_project: [],
      suggested_project_id: 'llamactl',
      hint: 'pass project_id explicitly or update prompt paths',
    },
  });
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'chain_start.routing_guard.workflow_exemption_rejected',
      project_id: 'penumbra',
      workflow_run_id_present: false,
    }),
    expect.any(String),
  );
});

test('chain-start rejects forged workflow_run_id', async () => {
  const services = tempServices({
    agentRegistry: ['planner'],
    projectRegistry: new ProjectRegistry(new Map([
      ['penumbra', { project_id: 'penumbra', root_path: '/Volumes/WorkSSD/repos/personal/penumbra' }],
      ['llamactl', { project_id: 'llamactl', root_path: '/Volumes/WorkSSD/repos/personal/llamactl' }],
    ])),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = '1';
  const warnSpy = spyOn(services.log, 'warn').mockImplementation(() => undefined as any);

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
      project_id: 'penumbra',
      dispatch_kind: 'workflow',
      workflow_run_id: 'not-real-uuid',
      task_class: 'STANDARD',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'chain_start.routing_guard.workflow_exemption_rejected',
      project_id: 'penumbra',
      workflow_run_id_present: true,
    }),
    expect.any(String),
  );
});

test('chain-start rejects cross-project workflow_run_id', async () => {
  const services = tempServices({
    agentRegistry: ['planner'],
    projectRegistry: new ProjectRegistry(new Map([
      ['penumbra', { project_id: 'penumbra', root_path: '/Volumes/WorkSSD/repos/personal/penumbra' }],
      ['llamactl', { project_id: 'llamactl', root_path: '/Volumes/WorkSSD/repos/personal/llamactl' }],
    ])),
  });
  services.workflowRuns = createWorkflowRunsRegistry({
    uuid: () => 'wfrun-2',
    clock: () => new Date('2026-04-26T00:00:00Z'),
    db: services.db,
    storageRoot: '/private/tmp/penumbra-test-storage',
  });
  const otherWorkflowRunId = services.workflowRuns.register('cross-project-workflow', 'other-project');
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = 'true';

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
      project_id: 'penumbra',
      dispatch_kind: 'workflow',
      workflow_run_id: otherWorkflowRunId,
      task_class: 'STANDARD',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
});

test('chain-start rejects workflow exemption when request lacks project_id', async () => {
  const services = tempServices({
    agentRegistry: ['planner'],
    projectRegistry: new ProjectRegistry(new Map([
      ['penumbra', { project_id: 'penumbra', root_path: '/Volumes/WorkSSD/repos/personal/penumbra' }],
      ['llamactl', { project_id: 'llamactl', root_path: '/Volumes/WorkSSD/repos/personal/llamactl' }],
    ])),
  });
  services.workflowRuns = createWorkflowRunsRegistry({
    uuid: () => 'wfrun-3',
    clock: () => new Date('2026-04-26T00:00:00Z'),
    db: services.db,
    storageRoot: '/private/tmp/penumbra-test-storage',
  });
  const workflowRunId = services.workflowRuns.register('cross-project-workflow', 'penumbra');
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = '1';
  const warnSpy = spyOn(services.log, 'warn').mockImplementation(() => undefined as any);

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
      project_id: null,
      dispatch_kind: 'workflow',
      workflow_run_id: workflowRunId,
      task_class: 'STANDARD',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'chain_start.routing_guard.workflow_exemption_rejected',
      project_id: null,
      workflow_run_id_present: true,
    }),
    expect.any(String),
  );
});

test('chain-start rejects spoofed parent_handoff_id in strict mode when the parent does not resolve', async () => {
  const services = tempServices({
    agentRegistry: ['planner'],
    projectRegistry: new ProjectRegistry(new Map([
      ['penumbra', { project_id: 'penumbra', root_path: '/Volumes/WorkSSD/repos/personal/penumbra' }],
      ['llamactl', { project_id: 'llamactl', root_path: '/Volumes/WorkSSD/repos/personal/llamactl' }],
    ])),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = 'true';
  const warnSpy = spyOn(services.log, 'warn').mockImplementation(() => undefined as any);

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
      project_id: 'penumbra',
      parent_handoff_id: 'forged-nonexistent-id',
      task_class: 'STANDARD',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'prompt_project_mismatch',
      project_id: 'penumbra',
      mentioned_paths: ['/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts'],
      missing_in_project: [],
      suggested_project_id: 'llamactl',
      hint: 'pass project_id explicitly or update prompt paths',
    },
  });
});

test('chain-start rejects strict internal parent_handoff_id hops from another project', async () => {
  const services = tempServices({
    agentRegistry: ['planner'],
    projectRegistry: new ProjectRegistry(new Map([
      ['penumbra', { project_id: 'penumbra', root_path: '/Volumes/WorkSSD/repos/personal/penumbra' }],
      ['llamactl', { project_id: 'llamactl', root_path: '/Volumes/WorkSSD/repos/personal/llamactl' }],
    ])),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = 'true';

  services.db.query(
    `INSERT INTO handoffs (
      handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'h-parent',
    '2026-04-26T00:00:00Z',
    'llamactl',
    'conv-parent',
    'user',
    'planner',
    null,
    'parent',
    'open',
  );

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
      project_id: 'penumbra',
      parent_handoff_id: 'h-parent',
      task_class: 'STANDARD',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'prompt_project_mismatch',
      project_id: 'penumbra',
      mentioned_paths: ['/Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts'],
      missing_in_project: [],
      suggested_project_id: 'llamactl',
      hint: 'pass project_id explicitly or update prompt paths',
    },
  });
});

test('chain-start allows strict internal parent_handoff_id hops from the same project', async () => {
  const services = tempServices({
    agentRegistry: ['planner'],
    projectRegistry: new ProjectRegistry(new Map([
      ['penumbra', { project_id: 'penumbra', root_path: '/Volumes/WorkSSD/repos/personal/penumbra' }],
      ['llamactl', { project_id: 'llamactl', root_path: '/Volumes/WorkSSD/repos/personal/llamactl' }],
    ])),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = 'true';
  const warnSpy = spyOn(services.log, 'warn').mockImplementation(() => undefined as any);

  services.db.query(
    `INSERT INTO handoffs (
      handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'h-parent',
    '2026-04-26T00:00:00Z',
    'penumbra',
    'conv-parent',
    'user',
    'planner',
    null,
    'parent',
    'open',
  );

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
      project_id: 'penumbra',
      parent_handoff_id: 'h-parent',
      task_class: 'STANDARD',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body).toHaveProperty('routing_warning', expect.objectContaining({
    code: 'prompt_project_mismatch',
    project_id: 'penumbra',
  }));
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'chain_start.routing_guard.internal_hop_mismatch',
      project_id: 'penumbra',
    }),
    expect.any(String),
  );
});

test('chain-start warns and dispatches for strict long-lived tick hops', async () => {
  const services = tempServices({
    agentRegistry: ['planner'],
    projectRegistry: new ProjectRegistry(new Map([
      ['penumbra', { project_id: 'penumbra', root_path: '/Volumes/WorkSSD/repos/personal/penumbra' }],
      ['llamactl', { project_id: 'llamactl', root_path: '/Volumes/WorkSSD/repos/personal/llamactl' }],
    ])),
  });
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = '1';
  const warnSpy = spyOn(services.log, 'warn').mockImplementation(() => undefined as any);

  services.db.query(
    `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'agent-42',
    'Home Assistant',
    JSON.stringify({
      version: 1,
      updated_at: 1715385600000,
      pending_goals: [],
      open_threads: [],
      watches: [],
      recent_decisions: [],
    }),
    'Keep home automations healthy',
    1715385600000,
    1715385600000,
  );
  services.db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
  ).run(
    'tick-42',
    'agent-42',
    'manual',
    1715385600000,
  );

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /Volumes/WorkSSD/repos/personal/llamactl/src/foo.ts',
      project_id: 'penumbra',
      dispatch_kind: 'long_lived_tick',
      long_lived_agent_id: 'agent-42',
      long_lived_tick_id: 'tick-42',
      task_class: 'STANDARD',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body).toHaveProperty('routing_warning', expect.objectContaining({
    code: 'prompt_project_mismatch',
    project_id: 'penumbra',
  }));
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'chain_start.routing_guard.internal_hop_mismatch',
      project_id: 'penumbra',
    }),
    expect.any(String),
  );
});

test('chain-start attaches a routing advisory when the registry cannot be loaded', async () => {
  const services = tempServices({ agentRegistry: ['planner'] });
  services.projectRegistry = {
    list: () => {
      throw new Error('registry unavailable');
    },
  } as ProjectRegistry;

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /tmp/llamactl/src/foo.ts',
      project_id: 'penumbra',
      task_class: 'STANDARD',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body).toHaveProperty('routing_advisory', {
    code: 'project_registry_unavailable',
  });
  expect(body.routing_warning).toBeUndefined();
});

test('POST /chains/start success response parses against ChainStartResponseSchema', async () => {
  const services = tempServices({ agentRegistry: ['planner'] });

  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'hi',
      project_id: 'penumbra',
      task_class: 'STANDARD',
    }),
  }), services);

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(() => ChainStartResponseSchema.parse(body)).not.toThrow();
});

test('chain-start skips the routing guard when no project registry is available', async () => {
  const services = tempServices({ agentRegistry: ['planner'] });

  const req = new Request('http://t/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'touch /tmp/llamactl/src/foo.ts',
      project_id: 'penumbra',
      task_class: 'STANDARD',
    }),
  });
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.routing_warning).toBeUndefined();
  expect(body.routing_advisory).toBeUndefined();
});

test('POST /chains/start auto-strips leading @ from initial_agent', async () => {
  const services = tempServices({ agentRegistry: ['planner', 'executor'] });
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: '@planner', message: 'hi' }) }), services);
  expect(res.status).toBe(200);
  const body = await res.json();
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.to_agent).toBe('planner');
});

test('POST /chains/start returns 400 invalid_agent if @-stripping leaves an empty agent with no registry loaded', async () => {
  const services = tempServices({ agentRegistry: null });
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: '@', message: 'hi' }) }), services);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'invalid_agent',
      agent: '',
      hint: 'initial_agent must be non-empty after @-prefix/agent:-prefix stripping',
    },
  });
});

test('POST /chains/start returns 400 invalid_agent if @-stripping leaves an empty agent before registry validation', async () => {
  const services = tempServices({ agentRegistry: ['gemini-flash'] });
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: '@', message: 'hi' }) }), services);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'invalid_agent',
      agent: '',
      hint: 'initial_agent must be non-empty after @-prefix/agent:-prefix stripping',
    },
  });
});

test('POST /chains/start strips only the first leading @ before registry validation', async () => {
  const services = tempServices({ agentRegistry: ['gemini-flash'] });
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: '@@gemini-flash', message: 'hi' }) }), services);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: 'unknown_agent',
      agent: '@gemini-flash',
      hint: 'use chain.list_agents to enumerate valid agents',
    },
  });
});

test('POST /chains/start returns 503 if no active worker has heartbeated', async () => {
  const services = tempServices();
  services.watchdog.hasActiveWorker = () => false;

  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi' }) }), services);
  expect(res.status).toBe(503);
  const body = await res.json();
  expect(body.error.code).toBe('no_worker_registered');
});

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
  expect(handoff.resolved_at).toBeNull();
  expect(handoff.chain_max_hops).toBe(5);
  expect(handoff.chain_trust_mode).toBe('all');
  expect(handoff.conversation_id).toBe(body.conversation_id);
});

test('POST /chains/start respects use_worktree: false', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', use_worktree: false }) }),
    services);
  expect(res.status).toBe(200);
  const body = await res.json();
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.use_worktree).toBe(0);
});

test('POST /chains/start respects use_worktree: true', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', use_worktree: true }) }),
    services);
  expect(res.status).toBe(200);
  const body = await res.json();
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.use_worktree).toBe(1);
});

test('POST /chains/start defaults use_worktree to true if omitted', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi' }) }),
    services);
  const body = await res.json();
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.use_worktree).toBe(1);
});

test('POST /chains/start persists open_pr_on_review: true', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi', open_pr_on_review: true }) }),
    services);
  expect(res.status).toBe(200);
  const body = await res.json();
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.open_pr_on_review).toBe(1);
});

test('POST /chains/start defaults open_pr_on_review to null when omitted', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi' }) }),
    services);
  expect(res.status).toBe(200);
  const body = await res.json();
  const handoff = services.db.query<any, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(body.handoff_id);
  expect(handoff.open_pr_on_review).toBeNull();
});

test('POST /chains/start persists long-lived dispatch identity fields when supplied', async () => {
  const services = tempServices();
  services.db.query(
    `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'agent-42',
    'Home Assistant',
    JSON.stringify({
      version: 1,
      updated_at: 1715385600000,
      pending_goals: [],
      open_threads: [],
      watches: [],
      recent_decisions: [],
    }),
    'Keep home automations healthy',
    1715385600000,
    1715385600000,
  );
  services.db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
  ).run(
    'tick-42',
    'agent-42',
    'manual',
    1715385600000,
  );
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'hi',
      dispatch_kind: 'long_lived_tick',
      long_lived_agent_id: 'agent-42',
      long_lived_tick_id: 'tick-42',
    }) }),
    services);
  expect(res.status).toBe(200);
  const body = await res.json();
  const handoff = services.db.query<any, [string]>(
    `SELECT dispatch_kind, long_lived_agent_id, long_lived_tick_id FROM handoffs WHERE handoff_id=?`,
  ).get(body.handoff_id);
  expect(handoff.dispatch_kind).toBe('long_lived_tick');
  expect(handoff.long_lived_agent_id).toBe('agent-42');
  expect(handoff.long_lived_tick_id).toBe('tick-42');
});

test('POST /chains/start defaults long-lived dispatch identity fields to null when omitted', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'hi',
    }) }),
    services);
  expect(res.status).toBe(200);
  const body = await res.json();
  const handoff = services.db.query<any, [string]>(
    `SELECT dispatch_kind, long_lived_agent_id, long_lived_tick_id FROM handoffs WHERE handoff_id=?`,
  ).get(body.handoff_id);
  expect(handoff.dispatch_kind).toBeNull();
  expect(handoff.long_lived_agent_id).toBeNull();
  expect(handoff.long_lived_tick_id).toBeNull();
});

test('POST /chains/start stamps long-lived tick dispatch prompts before persisting handoff message', async () => {
  const services = tempServices();
  services.db.query(
    `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'agent-42',
    'Home Assistant',
    JSON.stringify({
      version: 1,
      updated_at: 1715385600000,
      pending_goals: [{ id: 'g-1', text: 'Watch kitchen lights' }],
      open_threads: [],
      watches: [],
      recent_decisions: [],
    }),
    'Keep home automations healthy',
    1715385600000,
    1715385600000,
  );
  services.db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, trigger_payload_json, started_at
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    'tick-42',
    'agent-42',
    'event',
    JSON.stringify({ entity_id: 'light.kitchen' }),
    1715385600000,
  );

  const rawMessage = 'reactor placeholder';
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: rawMessage,
      dispatch_kind: 'long_lived_tick',
      long_lived_agent_id: 'agent-42',
      long_lived_tick_id: 'tick-42',
    }) }),
    services);
  expect(res.status).toBe(200);
  const body = await res.json();
  const handoff = services.db.query<any, [string]>(
    `SELECT message FROM handoffs WHERE handoff_id=?`,
  ).get(body.handoff_id);
  expect(handoff.message).not.toBe(rawMessage);
  expect(handoff.message).toContain('Tick id: tick-42');

  const promptEvent = services.db.query<any, [string]>(
    `SELECT payload_json FROM t0_events
     WHERE session_id=? AND event_type='user-prompt'
     ORDER BY ts DESC
     LIMIT 1`,
  ).get(body.conversation_id);
  const payloadJson = typeof promptEvent.payload_json === 'string'
    ? JSON.parse(promptEvent.payload_json)
    : promptEvent.payload_json;
  expect(payloadJson).toEqual({ prompt: rawMessage });
});

test('POST /chains/start returns unknown_long_lived_agent when long-lived dispatch identity cannot be resolved', async () => {
  const services = tempServices();
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'reactor placeholder',
      dispatch_kind: 'long_lived_tick',
      long_lived_agent_id: 'missing-agent',
      long_lived_tick_id: 'tick-42',
    }) }),
    services);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe('unknown_long_lived_agent');
});

test('POST /chains/start rejects mismatched long-lived agent/tick identity', async () => {
  const services = tempServices();
  services.db.query(
    `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'agent-a',
    'Agent A',
    JSON.stringify({
      version: 1,
      updated_at: 1715385600000,
      pending_goals: [],
      open_threads: [],
      watches: [],
      recent_decisions: [],
    }),
    'A brief',
    1715385600000,
    1715385600000,
  );
  services.db.query(
    `INSERT INTO long_lived_agents (
      id, display_name, working_memory_json, standing_brief, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'agent-b',
    'Agent B',
    JSON.stringify({
      version: 1,
      updated_at: 1715385600000,
      pending_goals: [],
      open_threads: [],
      watches: [],
      recent_decisions: [],
    }),
    'B brief',
    1715385600000,
    1715385600000,
  );
  services.db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?)`,
  ).run(
    'tick-a',
    'agent-a',
    'manual',
    1715385600000,
  );

  const res = await chainsStartRoute(new Request('http://x/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'planner',
      message: 'reactor placeholder',
      dispatch_kind: 'long_lived_tick',
      long_lived_agent_id: 'agent-b',
      long_lived_tick_id: 'tick-a',
    }),
  }), services);

  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe('cross_identity_long_lived');
  expect(body.error.long_lived_agent_id).toBe('agent-b');
  expect(body.error.long_lived_tick_id).toBe('tick-a');
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

test('chainStartFromInput returns same validation_error payload as POST /chains/start for missing initial_agent', async () => {
  const services = tempServices();
  const httpRes = await chainsStartRoute(
    new Request('http://x/chains/start', {
      method: 'POST',
      body: JSON.stringify({ message: 'hi' }),
    }),
    services,
  );
  const internalRes = await chainStartFromInput({ message: 'hi' }, services);

  expect(internalRes.status).toBe(httpRes.status);
  expect(await internalRes.json()).toEqual(await httpRes.json());
});

test('POST /chains/start still returns schema validation_error for empty initial_agent input', async () => {
  const services = tempServices({ agentRegistry: ['gemini-flash'] });
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: '', message: 'hi' }) }), services);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe('validation_error');
  expect(body.error.field_errors).toContainEqual({
    path: ['initial_agent'],
    message: 'Too small: expected string to have >=1 characters',
  });
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

test('GET /chains/history returns chain-terminated events for a conversation', async () => {
  const services = tempServices();
  const ts = '2026-04-26T12:00:00Z';
  services.t0Writer.write({
    event_id: 'ev1', ts, ingest_ts: ts, source: 'agentchat', source_detail: null,
    project_id: null, user_id: 'u1', machine_id: 'm1', session_id: 'c1',
    event_type: 'chain-terminated', lane: 'local', provider: null, model: null,
    tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
    request_id: null,
    payload_json: { reason: 'max_hops reached', hop_count: 5, terminal_handoff_id: 'h1' },
    payload_summary: 'terminated',
  });

  const res = await chainsHistoryRoute(new Request('http://x/chains/history?conversation_id=c1'), services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.history.length).toBe(1);
  expect(body.history[0].reason).toBe('max_hops reached');
  expect(body.history[0].hop_count).toBe(5);
  expect(body.history[0].conversation_id).toBe('c1');
});

test('GET /chains/history returns 400 if conversation_id is missing', async () => {
  const services = tempServices();
  const res = await chainsHistoryRoute(new Request('http://x/chains/history'), services);
  expect(res.status).toBe(400);
});

test('GET /chains/agents returns [] when no registry is loaded', async () => {
  const services = tempServices({ agentRegistry: null });
  const res = await chainsListAgentsRoute(new Request('http://x/chains/agents'), services);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ agents: [] });
});

test('GET /chains/agents preserves registry order and shape', async () => {
  const services = tempServices({ agentRegistry: ['planner', 'executor', 'reviewer'] });
  const res = await chainsListAgentsRoute(new Request('http://x/chains/agents'), services);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    agents: [
      { name: 'planner' },
      { name: 'executor' },
      { name: 'reviewer' },
    ],
  });
});

test('GET /chains/responses returns agent responses for a conversation', async () => {
  const services = tempServices();
  writeAgentResponse(services, {
    event_id: 'ev1',
    ts: '2026-04-26T12:00:00Z',
    source_detail: 'planner',
    user_id: 'planner',
    session_id: 'c1',
    payload_json: { response: 'hello from planner' },
  });
  writeAgentResponse(services, {
    event_id: 'ev2',
    ts: '2026-04-26T12:05:00Z',
    source_detail: 'executor',
    user_id: 'executor',
    session_id: 'c1',
    payload_json: { response: 'hello from executor' },
  });

  const resFinal = await chainsResponsesRoute(new Request('http://x/chains/responses?conversation_id=c1'), services);
  expect(resFinal.status).toBe(200);
  const bodyFinal = await resFinal.json();
  expect(bodyFinal.responses.length).toBe(1);
  expect(bodyFinal.responses[0].agent).toBe('executor');
  expect(bodyFinal.responses[0].text).toBe('hello from executor');

  const resAll = await chainsResponsesRoute(new Request('http://x/chains/responses?conversation_id=c1&which=all'), services);
  const bodyAll = await resAll.json();
  expect(bodyAll.responses.length).toBe(2);
  expect(bodyAll.responses[0].agent).toBe('planner');
  expect(bodyAll.responses[0].text).toBe('hello from planner');
  expect(bodyAll.responses[1].agent).toBe('executor');
  expect(bodyAll.responses[1].text).toBe('hello from executor');
});

test('GET /chains/responses returns agent name from user_id for production agent-response rows', async () => {
  const services = tempServices();
  writeAgentResponse(services, {
    event_id: 'ev1',
    ts: '2026-04-26T12:00:00Z',
    source_detail: null,
    source: 'agentchat',
    user_id: 'planner',
    session_id: 'c1',
    payload_json: { response: 'hello from planner' },
  });

  const res = await chainsResponsesRoute(new Request('http://x/chains/responses?conversation_id=c1'), services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.responses).toEqual([
    { agent: 'planner', text: 'hello from planner', ts: '2026-04-26T12:00:00Z' },
  ]);
});

test('GET /chains/responses returns 404 only for unknown conversations and preserves empty known conversations', async () => {
  const services = tempServices();
  writeConversationMarker(services, 'known-empty');

  const knownRes = await chainsResponsesRoute(new Request('http://x/chains/responses?conversation_id=known-empty&which=all'), services);
  expect(knownRes.status).toBe(200);
  const knownBody = await knownRes.json();
  expect(knownBody).toEqual({ responses: [] });

  const missingRes = await chainsResponsesRoute(new Request('http://x/chains/responses?conversation_id=missing-conv&which=all'), services);
  expect(missingRes.status).toBe(404);
  const missingBody = await missingRes.json();
  expect(missingBody).toEqual({
    error: { code: 'not_found', message: 'no chain events found for conversation' },
  });
});

test('GET /chains/responses decodes multiline responses and surfaces error payloads', async () => {
  const services = tempServices();
  writeAgentResponse(services, {
    event_id: 'ev1',
    ts: '2026-04-26T12:00:00Z',
    user_id: 'planner',
    session_id: 'c1',
    payload_json: { response: 'line1\nline2' },
  });
  writeAgentResponse(services, {
    event_id: 'ev2',
    ts: '2026-04-26T12:01:00Z',
    user_id: 'planner',
    session_id: 'c1',
    payload_json: { error: 'adapter crashed' },
  });

  const res = await chainsResponsesRoute(new Request('http://x/chains/responses?conversation_id=c1&which=all'), services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.responses).toEqual([
    { agent: 'planner', text: 'line1\nline2', ts: '2026-04-26T12:00:00Z' },
    { agent: 'planner', text: '', error: { message: 'adapter crashed' }, ts: '2026-04-26T12:01:00Z' },
  ]);
});

test('GET /chains/responses handles malformed payload_json rows without 500ing', async () => {
  const services = tempServices();
  services.db.exec(`
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id, session_id,
      event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, request_id,
      payload_json, payload_summary
    ) VALUES (
      'ev-bad', '2026-04-26T12:00:00Z', '2026-04-26T12:00:00Z', 'agentchat', NULL, NULL, 'planner', 'm1', 'c1',
      'agent-response', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      '{"response":"ok"}', 'response'
    );
  `);
  services.db.query<unknown, [string, string]>(`UPDATE t0_events SET payload_json=? WHERE event_id=?`).run('{bad json', 'ev-bad');

  const res = await chainsResponsesRoute(new Request('http://x/chains/responses?conversation_id=c1'), services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.responses).toEqual([
    {
      agent: 'planner',
      text: '',
      error: { message: 'malformed payload_json' },
      ts: '2026-04-26T12:00:00Z',
    },
  ]);
});

test('GET /chains/responses orders same-ts rows deterministically by ingest_ts then event_id', async () => {
  const services = tempServices();
  writeAgentResponse(services, {
    event_id: 'ev-b',
    ts: '2026-04-26T12:00:00Z',
    ingest_ts: '2026-04-26T12:00:02Z',
    user_id: 'executor',
    session_id: 'c1',
    payload_json: { response: 'second' },
  });
  writeAgentResponse(services, {
    event_id: 'ev-a',
    ts: '2026-04-26T12:00:00Z',
    ingest_ts: '2026-04-26T12:00:01Z',
    user_id: 'planner',
    session_id: 'c1',
    payload_json: { response: 'first' },
  });
  writeAgentResponse(services, {
    event_id: 'ev-c',
    ts: '2026-04-26T12:00:00Z',
    ingest_ts: '2026-04-26T12:00:02Z',
    user_id: 'reviewer',
    session_id: 'c1',
    payload_json: { response: 'third' },
  });

  const resFinal = await chainsResponsesRoute(new Request('http://x/chains/responses?conversation_id=c1'), services);
  expect(resFinal.status).toBe(200);
  const bodyFinal = await resFinal.json();
  expect(bodyFinal.responses).toEqual([
    { agent: 'reviewer', text: 'third', ts: '2026-04-26T12:00:00Z' },
  ]);

  const resAll = await chainsResponsesRoute(new Request('http://x/chains/responses?conversation_id=c1&which=all'), services);
  expect(resAll.status).toBe(200);
  const bodyAll = await resAll.json();
  expect(bodyAll.responses.map((response: any) => response.agent)).toEqual(['planner', 'executor', 'reviewer']);
});

test('GET /chains/responses returns 400 if conversation_id is missing', async () => {
  const services = tempServices();
  const res = await chainsResponsesRoute(new Request('http://x/chains/responses'), services);
  expect(res.status).toBe(400);
});

test('GET /chains/messages returns all events for a conversation chronologically', async () => {
  const services = tempServices();
  services.db.exec(`
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id, session_id,
      event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, request_id,
      payload_json, payload_summary
    ) VALUES 
    ('ev1', '2026-04-26T12:00:00Z', '2026-04-26T12:00:00Z', 'agentchat', NULL, NULL, 'u1', 'm1', 'c1', 'user-prompt', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"prompt":"hi"}', 'hi'),
    ('ev2', '2026-04-26T12:01:00Z', '2026-04-26T12:01:00Z', 'agentchat', NULL, NULL, 'u1', 'm1', 'c1', 'agent-response', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"response":"hello"}', 'hello')
  `);

  const { chainsMessagesRoute } = await import('../../src/routes/chains.js');
  const res = await chainsMessagesRoute(new Request('http://x/chains/messages?conversation_id=c1'), services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events.length).toBe(2);
  expect(body.events[0].event_type).toBe('user-prompt');
  expect(body.events[0].payload).toEqual({ prompt: 'hi' });
  expect(body.events[1].event_type).toBe('agent-response');
  expect(body.events[1].payload).toEqual({ response: 'hello' });
});

test('GET /chains/messages filters by types array', async () => {
  const services = tempServices();
  services.db.exec(`
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id, session_id,
      event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, request_id,
      payload_json, payload_summary
    ) VALUES 
    ('ev1', '2026-04-26T12:00:00Z', '2026-04-26T12:00:00Z', 'agentchat', NULL, NULL, 'u1', 'm1', 'c1', 'user-prompt', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"prompt":"hi"}', 'hi'),
    ('ev2', '2026-04-26T12:01:00Z', '2026-04-26T12:01:00Z', 'agentchat', NULL, NULL, 'u1', 'm1', 'c1', 'agent-response', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"response":"hello"}', 'hello')
  `);

  const { chainsMessagesRoute } = await import('../../src/routes/chains.js');
  const res = await chainsMessagesRoute(new Request('http://x/chains/messages?conversation_id=c1&types=agent-response'), services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events.length).toBe(1);
  expect(body.events[0].event_type).toBe('agent-response');
});

test('GET /chains/messages parses malformed JSON safely as null', async () => {
  const services = tempServices();
  services.db.exec(`
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, source_detail, project_id, user_id, machine_id, session_id,
      event_type, lane, provider, model, tokens_in, tokens_out, cost_usd, latency_ms, request_id,
      payload_json, payload_summary
    ) VALUES 
    ('ev1', '2026-04-26T12:00:00Z', '2026-04-26T12:00:00Z', 'agentchat', NULL, NULL, 'u1', 'm1', 'c1', 'user-prompt', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"prompt":"ok"}', 'hi')
  `);
  services.db.query<unknown, [string, string]>(`UPDATE t0_events SET payload_json=? WHERE event_id=?`).run('{bad', 'ev1');

  const { chainsMessagesRoute } = await import('../../src/routes/chains.js');
  const res = await chainsMessagesRoute(new Request('http://x/chains/messages?conversation_id=c1'), services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events.length).toBe(1);
  expect(body.events[0].payload).toBeNull();
});

test('GET /chains/messages returns 400 if conversation_id is missing', async () => {
  const services = tempServices();
  const { chainsMessagesRoute } = await import('../../src/routes/chains.js');
  const res = await chainsMessagesRoute(new Request('http://x/chains/messages'), services);
  expect(res.status).toBe(400);
});

test('GET /chains/messages returns empty events array for unknown conversation_id', async () => {
  const services = tempServices();
  const { chainsMessagesRoute } = await import('../../src/routes/chains.js');
  const res = await chainsMessagesRoute(new Request('http://x/chains/messages?conversation_id=unknown-id'), services);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events.length).toBe(0);
});

import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { chainsStartRoute, chainsHistoryRoute, chainsResponsesRoute, chainsListAgentsRoute } from '../../src/routes/chains.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function tempServices(opts?: { agentRegistry?: string[] | null }): Services {
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
  });
  // Mock watchdog for chains testing (by default hasActiveWorker=true to pass existing tests)
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };
  return services;
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

test('POST /chains/start succeeds if initial_agent is in registry', async () => {
  const services = tempServices({ agentRegistry: ['planner', 'executor'] });
  const res = await chainsStartRoute(new Request('http://x/chains/start', { method: 'POST',
    body: JSON.stringify({ initial_agent: 'planner', message: 'hi' }) }), services);
  expect(res.status).toBe(200);
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
      hint: 'initial_agent must be non-empty after @-prefix stripping',
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
      hint: 'initial_agent must be non-empty after @-prefix stripping',
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
      '{bad json', 'response'
    );
  `);

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
    ('ev1', '2026-04-26T12:00:00Z', '2026-04-26T12:00:00Z', 'agentchat', NULL, NULL, 'u1', 'm1', 'c1', 'user-prompt', 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{bad', 'hi')
  `);

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

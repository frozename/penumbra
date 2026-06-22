import { createLogger, loadSqliteVec, type Logger, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, mock, spyOn, test } from "bun:test";

import { longLivedFederationToolsRoute } from "../../src/routes/long-lived-federation-tools.js";

type McpPool = NonNullable<Services["mcpPool"]>;
type ListTools = McpPool["listTools"];
type ListToolsResult = Awaited<ReturnType<ListTools>>;
type StateFn = (
  server: string,
) => { initialized?: boolean; initPromise?: Promise<void> } | undefined;

interface McpPoolStub extends McpPool {
  _state?: StateFn;
  _readyWaitMs?: number;
}

function makeSilentLog(): Logger {
  // Fresh per-test logger so spyOn(log, "warn") call counts don't leak across tests.
  return createLogger({ component: "test", level: "silent" });
}

function makeServices(db: Database): Services {
  // federation-tools route exercises only `db`, `log`, and (per-test) `mcpPool`.
  // Stub everything else through a file-local laundering since Services has
  // ~40 nominal slots none of these tests reach.
  const stub = {
    db,
    storageRoot: "/tmp/penumbra-test",
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-05-11T00:00:00.000Z"),
    uuid: ((): (() => string) => {
      let n = 0;
      return () => `evt-${String(++n)}`;
    })(),
    log: makeSilentLog(),
    agentRegistry: null,
    agentRouting: null,
    providerQuotas: [],
  };
  return stub as unknown as Services;
}

interface McpPoolStubInput {
  listTools?: ListTools;
  _state?: StateFn;
  _readyWaitMs?: number;
}

function makeMcpPoolStub(input: McpPoolStubInput): McpPoolStub {
  return {
    callTool: () => Promise.resolve(undefined),
    listTools: input.listTools ?? ((): Promise<ListToolsResult> => Promise.resolve([])),
    getFederationHealth: () => ({ registered: [], skipped: [] }),
    shutdown: () => Promise.resolve(),
    _state: input._state,
    _readyWaitMs: input._readyWaitMs,
  };
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
    "agent-1",
    "Agent 1",
    "active",
    null,
    0,
    3,
    null,
    "[]",
    JSON.stringify(allowlist),
    "[]",
    "{}",
    null,
    null,
    null,
    "{}",
    "brief",
    null,
    null,
    null,
    null,
    null,
    1,
    1,
  );
}

test("GET /long-lived/agents/:id/federation-tools returns 404 for unknown agent", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = makeServices(db);
  const res = await longLivedFederationToolsRoute(
    new Request("http://x/long-lived/agents/missing/federation-tools"),
    services,
    "missing",
  );
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "agent_not_found" });
});

test("GET /long-lived/agents/:id/federation-tools returns empty tools without mcpPool", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ["ha:state_get"]);
  const services = makeServices(db);
  const res = await longLivedFederationToolsRoute(
    new Request("http://x/long-lived/agents/agent-1/federation-tools"),
    services,
    "agent-1",
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ tools: [] });
});

test("GET /long-lived/agents/:id/federation-tools filters a single server", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ["ha:state_get", "ha:state_set"]);
  const listTools = mock<ListTools>(() =>
    Promise.resolve([
      { name: "state_get", description: "get state" },
      { name: "state_set", description: "set state" },
      { name: "ignored", description: "nope" },
    ]),
  );
  const services = makeServices(db);
  services.mcpPool = makeMcpPoolStub({ listTools });
  const res = await longLivedFederationToolsRoute(
    new Request("http://x/long-lived/agents/agent-1/federation-tools"),
    services,
    "agent-1",
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    tools: [
      { name: "ha.state_get", description: "get state", inputSchema: undefined },
      { name: "ha.state_set", description: "set state", inputSchema: undefined },
    ],
  });
});

test("GET /long-lived/agents/:id/federation-tools skips builtin penumbra allowlist entries", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ["penumbra:chain_start", "ha:ha_pulse"]);
  const listTools = mock<ListTools>((server) => {
    if (server === "ha") return Promise.resolve([{ name: "ha_pulse", description: "pulse" }]);
    return Promise.reject(new Error(`unexpected listTools call for ${server}`));
  });
  const services = makeServices(db);
  services.mcpPool = makeMcpPoolStub({ listTools });
  const res = await longLivedFederationToolsRoute(
    new Request("http://x/long-lived/agents/agent-1/federation-tools"),
    services,
    "agent-1",
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    tools: [{ name: "ha.ha_pulse", description: "pulse", inputSchema: undefined }],
  });
  expect(listTools).not.toHaveBeenCalledWith("penumbra");
  expect(listTools).toHaveBeenCalledTimes(1);
});

test("GET /long-lived/agents/:id/federation-tools matches glob allowlist entries", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ["ha:ha_*"]);
  const listTools = mock<ListTools>(() =>
    Promise.resolve([
      { name: "ha_get_state", description: "get state" },
      { name: "ha_call_service", description: "call service" },
    ]),
  );
  const services = makeServices(db);
  services.mcpPool = makeMcpPoolStub({ listTools });
  const res = await longLivedFederationToolsRoute(
    new Request("http://x/long-lived/agents/agent-1/federation-tools"),
    services,
    "agent-1",
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    tools: [
      { name: "ha.ha_get_state", description: "get state", inputSchema: undefined },
      { name: "ha.ha_call_service", description: "call service", inputSchema: undefined },
    ],
  });
});

test("GET /long-lived/agents/:id/federation-tools accepts mixed legacy and canonical allowlist entries", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ["ha:state_get", "ha.state_set"]);
  const listTools = mock<ListTools>(() =>
    Promise.resolve([
      { name: "state_get", description: "get state" },
      { name: "state_set", description: "set state" },
    ]),
  );
  const services = makeServices(db);
  services.mcpPool = makeMcpPoolStub({ listTools });
  const res = await longLivedFederationToolsRoute(
    new Request("http://x/long-lived/agents/agent-1/federation-tools"),
    services,
    "agent-1",
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    tools: [
      { name: "ha.state_get", description: "get state", inputSchema: undefined },
      { name: "ha.state_set", description: "set state", inputSchema: undefined },
    ],
  });
});

test("GET /long-lived/agents/:id/federation-tools warns and skips malformed allowlist entries", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ["invalid-no-colon", "ha:state_get"]);
  const services = makeServices(db);
  const warnSpy = spyOn(services.log, "warn");
  const listTools = mock<ListTools>(() => Promise.resolve([{ name: "state_get" }]));
  services.mcpPool = makeMcpPoolStub({ listTools });
  const res = await longLivedFederationToolsRoute(
    new Request("http://x/long-lived/agents/agent-1/federation-tools"),
    services,
    "agent-1",
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    tools: [{ name: "ha.state_get", description: undefined, inputSchema: undefined }],
  });
  expect(warnSpy).toHaveBeenCalled();
});

test("GET /long-lived/agents/:id/federation-tools returns empty tools for malformed json", async () => {
  const db = new Database(":memory:");
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
    "agent-1",
    "Agent 1",
    "active",
    null,
    0,
    3,
    null,
    "[]",
    "not valid json",
    "[]",
    "{}",
    null,
    null,
    null,
    "{}",
    "brief",
    null,
    null,
    null,
    null,
    null,
    1,
    1,
  );
  const services = makeServices(db);
  const warnSpy = spyOn(services.log, "warn");
  const listTools = mock<ListTools>(() => Promise.reject(new Error("should not call")));
  services.mcpPool = makeMcpPoolStub({ listTools });
  const res = await longLivedFederationToolsRoute(
    new Request("http://x/long-lived/agents/agent-1/federation-tools"),
    services,
    "agent-1",
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ tools: [] });
  expect(warnSpy).toHaveBeenCalled();
});

test("GET /long-lived/agents/:id/federation-tools merges multiple servers and skips list failures", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ["ha:state_get", "x:do_it", "y:run"]);
  const services = makeServices(db);
  const warnSpy = spyOn(services.log, "warn");
  const listTools = mock<ListTools>((server): Promise<ListToolsResult> => {
    if (server === "ha") return Promise.resolve([{ name: "state_get" }, { name: "state_set" }]);
    if (server === "x") return Promise.reject(new Error("boom"));
    return Promise.resolve([{ name: "run" }]);
  });
  services.mcpPool = makeMcpPoolStub({ listTools });
  const res = await longLivedFederationToolsRoute(
    new Request("http://x/long-lived/agents/agent-1/federation-tools"),
    services,
    "agent-1",
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    tools: [
      { name: "ha.state_get", description: undefined, inputSchema: undefined },
      { name: "y.run", description: undefined, inputSchema: undefined },
    ],
  });
  expect(warnSpy).toHaveBeenCalled();
});

test("GET /long-lived/agents/:id/federation-tools waits for a cold-start federation init before listing tools", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ["ha:state_get"]);

  let initResolve!: () => void;
  const initPromise = new Promise<void>((resolve) => {
    initResolve = resolve;
  });
  const listTools = mock<ListTools>(() =>
    Promise.resolve([{ name: "state_get", description: "get state" }]),
  );
  const services = makeServices(db);
  const warnSpy = spyOn(services.log, "warn");
  services.mcpPool = makeMcpPoolStub({
    listTools,
    _state: () => ({ initialized: false, initPromise }),
    _readyWaitMs: 50,
  });

  const startedAt = Date.now();
  const resPromise = longLivedFederationToolsRoute(
    new Request("http://x/long-lived/agents/agent-1/federation-tools"),
    services,
    "agent-1",
  );
  await Bun.sleep(50);
  initResolve();
  const res = await resPromise;
  const elapsedMs = Date.now() - startedAt;

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    tools: [{ name: "ha.state_get", description: "get state", inputSchema: undefined }],
  });
  expect(listTools).toHaveBeenCalledTimes(1);
  expect(warnSpy).not.toHaveBeenCalled();
  expect(elapsedMs).toBeGreaterThanOrEqual(50);
});

test("GET /long-lived/agents/:id/federation-tools emits the warn after bounded wait when federation stays unhealthy", async () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  seedAgent(db, ["ha:state_get"]);

  const listTools = mock<ListTools>(() => Promise.reject(new Error("mcp_unavailable")));
  const services = makeServices(db);
  const warnSpy = spyOn(services.log, "warn");
  services.mcpPool = makeMcpPoolStub({
    listTools,
    _state: () => ({ initialized: false, initPromise: new Promise<void>(() => undefined) }),
    _readyWaitMs: 50,
  });

  const startedAt = Date.now();
  const res = await longLivedFederationToolsRoute(
    new Request("http://x/long-lived/agents/agent-1/federation-tools"),
    services,
    "agent-1",
  );
  const elapsedMs = Date.now() - startedAt;

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ tools: [] });
  expect(listTools).toHaveBeenCalledTimes(1);
  expect(warnSpy).toHaveBeenCalled();
  expect(elapsedMs).toBeGreaterThanOrEqual(50);
  expect(elapsedMs).toBeLessThan(500);
});

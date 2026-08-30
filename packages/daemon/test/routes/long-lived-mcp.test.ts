import { createLogger, loadSqliteVec, type Logger, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { longLivedMcpCallRoute } from "@src/routes/long-lived-mcp.js";
import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

type ActionGate = NonNullable<Services["actionGate"]>;
type HandleCall = ActionGate["handleCall"];
type HandleCallResult = Awaited<ReturnType<HandleCall>>;

const silentLog: Logger = createLogger({ component: "test", level: "silent" });

function makeServices(db: Database): Services {
  // long-lived-mcp routes exercise only `db`, `clock`, `uuid`, `log`, and the
  // `actionGate` slot (assigned per-test). Every other Services slot is never
  // invoked here, so the bulk of the object is stubbed and laundered through
  // unknown once instead of casting each slot.
  const stub = {
    db,
    storageRoot: "/tmp/penumbra-test",
    embedder: new TestEmbedder({ dim: 384 }),
    clock: (): Date => new Date("2026-05-11T00:00:00.000Z"),
    uuid: ((): (() => string) => {
      let n = 0;
      return () => `evt-${String(++n)}`;
    })(),
    log: silentLog,
    agentRegistry: null,
    agentRouting: null,
    providerQuotas: [],
  };
  return stub as unknown as Services;
}

function executed(result: unknown, tier: 1 | 2 | 3 = 1): HandleCallResult {
  return { kind: "executed", result, tier };
}

function queued(pending_action_id: string): HandleCallResult {
  return { kind: "queued", pending_action_id };
}

function rejected(error: string, details?: unknown): HandleCallResult {
  return details === undefined ? { kind: "rejected", error } : { kind: "rejected", error, details };
}

function withToken<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["PENUMBRA_TOKEN"];
  process.env["PENUMBRA_TOKEN"] = token;
  return fn().finally(() => {
    if (prev === undefined) delete process.env["PENUMBRA_TOKEN"];
    else process.env["PENUMBRA_TOKEN"] = prev;
  });
}

function authHeaders(token = "tok"): Record<string, string> {
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
    "agent-1",
    "Agent 1",
    "active",
    null,
    0,
    3,
    null,
    "[]",
    "[]",
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
  db.query(
    `INSERT INTO long_lived_ticks (
      id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
      completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("tick-1", "agent-1", null, "manual", null, null, 1, null, null, null, null, null);
}

test("POST /long-lived/mcp/call returns 400 for malformed body", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const services = makeServices(db);
    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ agent_id: "agent-1", tick_id: "tick-1", tool: "bad-tool" }),
      }),
      services,
    );
    expect(res.status).toBe(400);
  });
});

test("POST /long-lived/mcp/call accepts dotted tool ids like ha:light.toggle", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock<HandleCall>(() => Promise.resolve(executed("ok")));
    const services = makeServices(db);
    services.actionGate = { handleCall };

    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ agent_id: "agent-1", tick_id: "tick-1", tool: "ha:light.toggle" }),
      }),
      services,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action_status: "executed", result: "ok" });
  });
});

test("POST /long-lived/mcp/call normalizes dot and colon tool ids before action gate dispatch", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock<HandleCall>((req) => Promise.resolve(executed(req.tool)));
    const services = makeServices(db);
    services.actionGate = { handleCall };

    const dotRes = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ agent_id: "agent-1", tick_id: "tick-1", tool: "ha.ha_get_state" }),
      }),
      services,
    );
    expect(dotRes.status).toBe(200);
    expect(await dotRes.json()).toEqual({ action_status: "executed", result: "ha:ha_get_state" });

    const colonRes = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ agent_id: "agent-1", tick_id: "tick-1", tool: "ha:ha_get_state" }),
      }),
      services,
    );
    expect(colonRes.status).toBe(200);
    expect(await colonRes.json()).toEqual({ action_status: "executed", result: "ha:ha_get_state" });
    expect(handleCall).toHaveBeenCalledTimes(2);
    expect(handleCall.mock.calls.map((call) => call[0].tool)).toEqual([
      "ha:ha_get_state",
      "ha:ha_get_state",
    ]);
  });
});

test("POST /long-lived/mcp/call lowercases tool ids before action gate dispatch", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock<HandleCall>((req) =>
      Promise.resolve(req.tool === "ha:integration.install" ? queued("pa-1") : executed(req.tool)),
    );
    const services = makeServices(db);
    services.actionGate = { handleCall };

    const upperRes = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          agent_id: "agent-1",
          tick_id: "tick-1",
          tool: "HA:integration.install",
        }),
      }),
      services,
    );
    expect(upperRes.status).toBe(200);
    expect(await upperRes.json()).toEqual({
      action_status: "queued",
      pending_action_id: "pa-1",
      message:
        "Action requires operator approval. Record an open_thread referencing pending_action_id.",
    });

    const lowerRes = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          agent_id: "agent-1",
          tick_id: "tick-1",
          tool: "ha:integration.install",
        }),
      }),
      services,
    );
    expect(lowerRes.status).toBe(200);
    expect(await lowerRes.json()).toEqual({
      action_status: "queued",
      pending_action_id: "pa-1",
      message:
        "Action requires operator approval. Record an open_thread referencing pending_action_id.",
    });
    expect(handleCall.mock.calls.map((call) => call[0].tool)).toEqual([
      "ha:integration.install",
      "ha:integration.install",
    ]);
  });
});

test("POST /long-lived/mcp/call accepts _meta and forwards it to action gate", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock<HandleCall>((req) => Promise.resolve(executed(req._meta)));
    const services = makeServices(db);
    services.actionGate = { handleCall };

    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          agent_id: "agent-1",
          tick_id: "tick-1",
          tool: "ha.ha_get_state",
          _meta: { origin: "claude-code", trace: "t-1" },
        }),
      }),
      services,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      action_status: "executed",
      result: { origin: "claude-code", trace: "t-1" },
    });
    expect(handleCall).toHaveBeenCalledWith({
      agent_id: "agent-1",
      tick_id: "tick-1",
      tool: "ha:ha_get_state",
      args: {},
      _meta: { origin: "claude-code", trace: "t-1" },
    });
  });
});

test("POST /long-lived/mcp/call rejects invalid _meta payloads", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock<HandleCall>(() => Promise.resolve(executed("ok")));
    const services = makeServices(db);
    services.actionGate = { handleCall };

    const invalidBodies = [{ _meta: "bad" }, { _meta: 42 }, { _meta: ["bad"] }];

    for (const invalid of invalidBodies) {
      const res = await longLivedMcpCallRoute(
        new Request("http://x/long-lived/mcp/call", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            agent_id: "agent-1",
            tick_id: "tick-1",
            tool: "ha:state_get",
            ...invalid,
          }),
        }),
        services,
      );
      expect(res.status).toBe(400);
    }

    expect(handleCall).not.toHaveBeenCalled();
  });
});

test("route rejects _meta > 2048 UTF-8 bytes with 400 meta_too_large", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock<HandleCall>(() => Promise.resolve(executed("ok")));
    const services = makeServices(db);
    services.actionGate = { handleCall };

    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          agent_id: "agent-1",
          tick_id: "tick-1",
          tool: "ha:state_get",
          _meta: { origin: "claude-code", blob: "😀".repeat(600) },
        }),
      }),
      services,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "meta_too_large" });
    expect(handleCall).not.toHaveBeenCalled();
  });
});

test("POST /long-lived/mcp/call forwards _meta as undefined when omitted", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock<HandleCall>(() => Promise.resolve(executed("ok")));
    const services = makeServices(db);
    services.actionGate = { handleCall };

    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ agent_id: "agent-1", tick_id: "tick-1", tool: "ha:state_get" }),
      }),
      services,
    );

    expect(res.status).toBe(200);
    expect(handleCall).toHaveBeenCalledWith({
      agent_id: "agent-1",
      tick_id: "tick-1",
      tool: "ha:state_get",
      args: {},
      _meta: undefined,
    });
  });
});

test("POST /long-lived/mcp/call rejects payloads larger than 1 MiB", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const services = makeServices(db);
    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-length": "2000000",
        },
        body: JSON.stringify({ agent_id: "agent-1", tick_id: "tick-1", tool: "ha:state_get" }),
      }),
      services,
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });
});

test("POST /long-lived/mcp/call returns 403 when identity does not match", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const services = makeServices(db);
    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ agent_id: "agent-1", tick_id: "tick-1", tool: "ha:state_get" }),
      }),
      services,
    );
    expect(res.status).toBe(403);
  });
});

test("POST /long-lived/mcp/call returns 503 when the action gate is missing", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const services = makeServices(db);
    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ agent_id: "agent-1", tick_id: "tick-1", tool: "ha:state_get" }),
      }),
      services,
    );
    expect(res.status).toBe(503);
  });
});

test("POST /long-lived/mcp/call normalizes executed gate results", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock<HandleCall>(() => Promise.resolve(executed({ x: 1 })));
    const services = makeServices(db);
    services.actionGate = { handleCall };

    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ agent_id: "agent-1", tick_id: "tick-1", tool: "ha:state_get" }),
      }),
      services,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action_status: "executed", result: { x: 1 } });
  });
});

test("POST /long-lived/mcp/call normalizes queued gate results", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock<HandleCall>(() => Promise.resolve(queued("abc")));
    const services = makeServices(db);
    services.actionGate = { handleCall };

    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ agent_id: "agent-1", tick_id: "tick-1", tool: "ha:state_get" }),
      }),
      services,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      action_status: "queued",
      pending_action_id: "abc",
      message:
        "Action requires operator approval. Record an open_thread referencing pending_action_id.",
    });
  });
});

test("POST /long-lived/mcp/call normalizes rejected gate results without details", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock<HandleCall>(() => Promise.resolve(rejected("not_in_allowlist")));
    const services = makeServices(db);
    services.actionGate = { handleCall };

    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ agent_id: "agent-1", tick_id: "tick-1", tool: "ha:state_get" }),
      }),
      services,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action_status: "rejected", error: "not_in_allowlist" });
  });
});

test("POST /long-lived/mcp/call normalizes rejected gate results with details", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock<HandleCall>(() =>
      Promise.resolve(rejected("mcp_call_timeout", { timeout_ms: 30000 })),
    );
    const services = makeServices(db);
    services.actionGate = { handleCall };

    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ agent_id: "agent-1", tick_id: "tick-1", tool: "ha:state_get" }),
      }),
      services,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      action_status: "rejected",
      error: "mcp_call_timeout",
      details: { timeout_ms: 30000 },
    });
  });
});

test("POST /long-lived/mcp/call accepts a verified running identity", async () => {
  await withToken("tok", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedRunningIdentity(db);
    const handleCall = mock<HandleCall>(() => Promise.resolve(executed({ ok: true })));
    const services = makeServices(db);
    services.actionGate = { handleCall };

    const res = await longLivedMcpCallRoute(
      new Request("http://x/long-lived/mcp/call", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          agent_id: "agent-1",
          tick_id: "tick-1",
          tool: "ha:state_get",
          args: { a: 1 },
        }),
      }),
      services,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action_status: "executed", result: { ok: true } });
    expect(handleCall).toHaveBeenCalledWith({
      agent_id: "agent-1",
      tick_id: "tick-1",
      tool: "ha:state_get",
      args: { a: 1 },
    });
  });
});

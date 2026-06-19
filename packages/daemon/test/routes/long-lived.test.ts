import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { reconcileLongLivedAgents } from "../../src/long-lived/reconciler.js";
import {
  longLivedApproveActionRoute,
  longLivedAuditRoute,
  longLivedGetRoute,
  longLivedInjectGoalRoute,
  longLivedListRoute,
  longLivedPauseRoute,
  longLivedPendingActionsRoute,
  longLivedReconcileOrphansRoute,
  longLivedRejectActionRoute,
  longLivedResumeRoute,
  longLivedRetireRoute,
  longLivedTickRoute,
  longLivedStateGetRoute,
  longLivedStateSetRoute,
  longLivedTicksRoute,
} from "../../src/routes/long-lived.js";
import { createDaemonFetchHandler } from "../../src/serve.js";

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/long-lived-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-10T00:00:00.000Z"),
    uuid: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  });
}

function seedAgent(services: Services): void {
  reconcileLongLivedAgents(
    services.db,
    [
      {
        name: "home-mgmt",
        display_name: "Home Mgmt",
        long_lived: true,
        long_lived_config: {
          schedule_cron: "*/15 * * * *",
          subscriptions: [{ server: "ha", event: "state_changed" }],
          mcp_allowlist: ["ha:state.*"],
          bounds: { wall_clock_ms: 180000, cost_cents: 50, max_sub_dispatches: 1 },
          circuit_breaker_threshold: 3,
          standing_brief: "watch home state",
        },
      } as any,
    ],
    { now: Date.parse("2026-05-10T00:00:00.000Z") },
  );
}

test("GET /long-lived lists reconciled agents", async () => {
  const services = tempServices();
  seedAgent(services);

  const res = await longLivedListRoute(new Request("http://x/long-lived"), services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    agents: Array<{ id: string; display_name: string; status: string }>;
  };
  expect(body.agents).toHaveLength(1);
  expect(body.agents[0]).toMatchObject({
    id: "home-mgmt",
    display_name: "Home Mgmt",
    status: "active",
  });
});

test("GET /long-lived/:id returns agent detail with related rows", async () => {
  const services = tempServices();
  seedAgent(services);

  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
      completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "tick-1",
      "home-mgmt",
      "chain-1",
      "cron",
      JSON.stringify({ scheduled: true }),
      "check the house",
      1000,
      2000,
      "success",
      12,
      null,
      JSON.stringify({}),
    );

  services.db
    .query(
      `INSERT INTO long_lived_pending_actions (
      id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
      status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "action-1",
      "home-mgmt",
      "tick-1",
      "notify",
      "ha:state",
      JSON.stringify({ message: "ping" }),
      "needs attention",
      "pending",
      999999,
      null,
      null,
      null,
      1500,
    );
  services.db
    .query(
      `INSERT INTO long_lived_pending_actions (
      id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
      status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "action-2",
      "home-mgmt",
      "tick-1",
      "notify",
      "ha:state",
      JSON.stringify({ message: "pong" }),
      "needs attention",
      "pending",
      999999,
      null,
      null,
      null,
      1600,
    );

  services.db
    .query(
      `INSERT INTO long_lived_action_audit (
      agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("home-mgmt", "tick-1", "action-1", "notify", "ha:state", "approved", null, 1600);

  const res = await longLivedGetRoute(
    new Request("http://x/long-lived/home-mgmt"),
    "home-mgmt",
    services,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    agent: { id: string; display_name: string; working_memory: { version: number } };
    recent_ticks: Array<{ id: string; trigger_payload: { scheduled: boolean } }>;
    pending_actions: Array<{ id: string; payload: { message: string } }>;
    recent_audit: Array<{ pending_action_id: string | null; decision: string }>;
  };
  expect(body.agent.id).toBe("home-mgmt");
  expect(body.agent.display_name).toBe("Home Mgmt");
  expect(body.agent.working_memory.version).toBe(1);
  expect(body.recent_ticks).toHaveLength(1);
  expect(body.recent_ticks[0].trigger_payload).toEqual({ scheduled: true });
  expect(body.pending_actions).toHaveLength(2);
  expect(body.pending_actions[0].payload).toEqual({ message: "pong" });
  expect(body.recent_audit).toHaveLength(1);
  expect(body.recent_audit[0].decision).toBe("approved");
});

test("POST /long-lived/reconcile-orphans reconciles orphaned ticks", async () => {
  const services = tempServices();
  seedAgent(services);
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, chain_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("tick-orphan", "home-mgmt", "conv-abc", "cron", 1000);

  const res = await longLivedReconcileOrphansRoute(
    new Request("http://x/long-lived/reconcile-orphans"),
    services,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ reconciled: 1 });

  const row = services.db
    .query(
      `SELECT completed_at, outcome
     FROM long_lived_ticks
     WHERE id = 'tick-orphan'`,
    )
    .get() as { completed_at: number | null; outcome: string | null };
  expect(row.completed_at).not.toBeNull();
  expect(row.outcome).toBe("orphan_recovered");
});

test("POST /long-lived/reconcile-orphans uses the injected clock", async () => {
  const fixedNow = Date.parse("2026-05-10T12:34:56.000Z");
  const services = tempServices();
  services.clock = () => new Date(fixedNow);
  seedAgent(services);
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, chain_id, trigger_kind, started_at
    ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("tick-orphan-clock", "home-mgmt", "conv-clock", "cron", 1000);

  const res = await longLivedReconcileOrphansRoute(
    new Request("http://x/long-lived/reconcile-orphans"),
    services,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ reconciled: 1 });

  const row = services.db
    .query(
      `SELECT completed_at
     FROM long_lived_ticks
     WHERE id = 'tick-orphan-clock'`,
    )
    .get() as { completed_at: number | null };
  expect(row.completed_at).toBe(fixedNow);
});

test("serve.ts wires GET /long-lived and GET /long-lived/:id", async () => {
  const services = tempServices();
  seedAgent(services);
  const handler = createDaemonFetchHandler({ services, token: "tok" });

  const listRes = await handler(
    new Request("http://x/long-lived", {
      headers: { authorization: "Bearer tok" },
    }),
  );
  expect(listRes.status).toBe(200);

  const getRes = await handler(
    new Request("http://x/long-lived/home-mgmt", {
      headers: { authorization: "Bearer tok" },
    }),
  );
  expect(getRes.status).toBe(200);

  const reconcileRes = await handler(
    new Request("http://x/long-lived/reconcile-orphans", {
      method: "POST",
      headers: { authorization: "Bearer tok" },
    }),
  );
  expect(reconcileRes.status).toBe(200);
});

test("operator long-lived routes are reachable and respond", async () => {
  const services = tempServices();
  seedAgent(services);

  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
      completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "tick-1",
      "home-mgmt",
      "chain-1",
      "cron",
      JSON.stringify({ scheduled: true }),
      "check the house",
      1000,
      2000,
      "success",
      12,
      null,
      JSON.stringify({}),
    );
  services.db
    .query(
      `INSERT INTO long_lived_pending_actions (
      id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
      status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "action-1",
      "home-mgmt",
      "tick-1",
      "notify",
      "ha:state",
      JSON.stringify({ message: "ping" }),
      "needs attention",
      "pending",
      999999,
      null,
      null,
      null,
      1500,
    );

  const pauseRes = await longLivedPauseRoute(
    new Request("http://x/long-lived/home-mgmt/pause"),
    "home-mgmt",
    services,
  );
  expect(pauseRes.status).toBe(200);
  expect(await pauseRes.json()).toMatchObject({ id: "home-mgmt", status: "paused" });

  const resumeRes = await longLivedResumeRoute(
    new Request("http://x/long-lived/home-mgmt/resume"),
    "home-mgmt",
    services,
  );
  expect(resumeRes.status).toBe(200);
  expect(await resumeRes.json()).toMatchObject({ id: "home-mgmt", status: "active" });

  const stateGetRes = await longLivedStateGetRoute(
    new Request("http://x/long-lived/home-mgmt/state"),
    "home-mgmt",
    services,
  );
  expect(stateGetRes.status).toBe(200);
  expect(await stateGetRes.json()).toHaveProperty("working_memory");

  const stateSetRes = await longLivedStateSetRoute(
    new Request("http://x/long-lived/home-mgmt/state", {
      method: "POST",
      body: JSON.stringify({ partial: { intent_summary: "updated summary" } }),
    }),
    "home-mgmt",
    services,
  );
  expect(stateSetRes.status).toBe(200);
  expect(await stateSetRes.json()).toEqual({ ok: true });

  const pendingActionsRes = await longLivedPendingActionsRoute(
    new Request("http://x/long-lived/home-mgmt/pending-actions?status=pending"),
    "home-mgmt",
    services,
  );
  expect(pendingActionsRes.status).toBe(200);
  expect(
    ((await pendingActionsRes.json()) as { pending_actions: Array<{ id: string }> })
      .pending_actions,
  ).toHaveLength(1);

  const approveRes = await longLivedApproveActionRoute(
    new Request("http://x/long-lived/pending-actions/action-1/approve", {
      method: "POST",
      body: JSON.stringify({ decided_by: "maestro:foo" }),
    }),
    "action-1",
    services,
  );
  expect(approveRes.status).toBe(200);
  expect(await approveRes.json()).toEqual({ ok: true });
  expect(
    services.db
      .query(`SELECT decided_by FROM long_lived_pending_actions WHERE id = ?`)
      .get("action-1"),
  ).toEqual({ decided_by: "maestro:foo" });

  services.db
    .query(
      `INSERT INTO long_lived_pending_actions (
      id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
      status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "action-2",
      "home-mgmt",
      "tick-1",
      "notify",
      "ha:state",
      JSON.stringify({ message: "ping" }),
      "needs attention",
      "pending",
      999999,
      null,
      null,
      null,
      1600,
    );
  services.db
    .query(
      `INSERT INTO long_lived_action_audit (
      agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("home-mgmt", "tick-1", "action-1", "notify", "ha:state", "approved", null, 1700);

  const rejectRes = await longLivedRejectActionRoute(
    new Request("http://x/long-lived/pending-actions/action-2/reject", {
      method: "POST",
      body: JSON.stringify({ decided_by: "maestro:bar", reason: "not-needed" }),
    }),
    "action-2",
    services,
  );
  expect(rejectRes.status).toBe(200);
  expect(await rejectRes.json()).toEqual({ ok: true });
  expect(
    services.db
      .query(`SELECT decided_by FROM long_lived_pending_actions WHERE id = ?`)
      .get("action-2"),
  ).toEqual({ decided_by: "maestro:bar" });
  expect(
    services.db
      .query(
        `SELECT reason FROM long_lived_action_audit WHERE pending_action_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get("action-2"),
  ).toEqual({ reason: "not-needed" });

  services.db
    .query(
      `INSERT INTO long_lived_pending_actions (
      id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
      status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "action-3",
      "home-mgmt",
      "tick-1",
      "notify",
      "ha:state",
      JSON.stringify({ message: "ping-2" }),
      "needs attention",
      "pending",
      999999,
      null,
      null,
      null,
      1650,
    );

  const bodyOnlyRejectRes = await longLivedRejectActionRoute(
    new Request("http://x/long-lived/pending-actions/action-3/reject", {
      method: "POST",
      body: JSON.stringify({ reason: "body-only", decided_by: "maestro:body" }),
    }),
    "action-3",
    services,
  );
  expect(bodyOnlyRejectRes.status).toBe(200);
  expect(
    services.db
      .query(`SELECT decided_by FROM long_lived_pending_actions WHERE id = ?`)
      .get("action-3"),
  ).toEqual({ decided_by: "maestro:body" });
  expect(
    services.db
      .query(
        `SELECT reason FROM long_lived_action_audit WHERE pending_action_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get("action-3"),
  ).toEqual({ reason: "body-only" });

  const injectGoalRes = await longLivedInjectGoalRoute(
    new Request("http://x/long-lived/home-mgmt/inject-goal", {
      method: "POST",
      body: JSON.stringify({ goal: "check the basement" }),
    }),
    "home-mgmt",
    services,
  );
  expect(injectGoalRes.status).toBe(200);
  expect(await injectGoalRes.json()).toEqual({ ok: true });

  const retireRes = await longLivedRetireRoute(
    new Request("http://x/long-lived/home-mgmt/retire"),
    "home-mgmt",
    services,
  );
  expect(retireRes.status).toBe(200);
  expect(await retireRes.json()).toMatchObject({ id: "home-mgmt", status: "retired" });

  const auditRes = await longLivedAuditRoute(
    new Request("http://x/long-lived/home-mgmt/audit"),
    "home-mgmt",
    services,
  );
  expect(auditRes.status).toBe(200);
  expect(
    ((await auditRes.json()) as { audit: Array<{ agent_id: string }> }).audit[0].agent_id,
  ).toBe("home-mgmt");

  const ticksRes = await longLivedTicksRoute(
    new Request("http://x/long-lived/home-mgmt/ticks"),
    "home-mgmt",
    services,
  );
  expect(ticksRes.status).toBe(200);
  expect(
    ((await ticksRes.json()) as { ticks: Array<{ agent_id: string }> }).ticks[0].agent_id,
  ).toBe("home-mgmt");
});

test("serve.ts wires long-lived operator routes", async () => {
  const routes = [
    ["POST", "/long-lived/home-mgmt/pause", 200],
    ["POST", "/long-lived/home-mgmt/resume", 200],
    ["POST", "/long-lived/home-mgmt/retire", 200],
    ["POST", "/long-lived/home-mgmt/tick", 200],
    ["GET", "/long-lived/home-mgmt/state", 200],
    ["POST", "/long-lived/home-mgmt/state", 200],
    ["GET", "/long-lived/home-mgmt/pending-actions", 200],
    ["POST", "/long-lived/pending-actions/action-1/approve", 200],
    ["POST", "/long-lived/pending-actions/action-2/reject", 200],
    ["POST", "/long-lived/home-mgmt/inject-goal", 200],
    ["GET", "/long-lived/home-mgmt/audit", 200],
    ["GET", "/long-lived/home-mgmt/ticks", 200],
  ] as const;

  for (const [method, path, status] of routes) {
    const services = tempServices();
    seedAgent(services);
    services.longLivedReactor = {
      manualTick: (agentId: string) => ({ outcome: `manual:${agentId}`, tick_id: "tick-1" }),
      reload: async () => {},
      shutdown: () => {},
    };
    services.db
      .query(
        `INSERT INTO long_lived_ticks (
        id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
        completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "tick-1",
        "home-mgmt",
        "chain-1",
        "cron",
        JSON.stringify({ scheduled: true }),
        "check the house",
        1000,
        2000,
        "success",
        12,
        null,
        JSON.stringify({}),
      );
    services.db
      .query(
        `INSERT INTO long_lived_pending_actions (
        id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
        status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "action-1",
        "home-mgmt",
        "tick-1",
        "notify",
        "ha:state",
        JSON.stringify({ message: "ping" }),
        "needs attention",
        "pending",
        999999,
        null,
        null,
        null,
        1500,
      );
    services.db
      .query(
        `INSERT INTO long_lived_pending_actions (
        id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
        status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "action-2",
        "home-mgmt",
        "tick-1",
        "notify",
        "ha:state",
        JSON.stringify({ message: "pong" }),
        "needs attention",
        "pending",
        999999,
        null,
        null,
        null,
        1600,
      );
    if (path.endsWith("/resume")) {
      services.db.query("UPDATE long_lived_agents SET status='paused' WHERE id='home-mgmt'").run();
    }
    const handler = createDaemonFetchHandler({ services, token: "tok" });
    const init: RequestInit = { method };
    if (method === "POST" && (path.endsWith("/state") || path.endsWith("/inject-goal"))) {
      init.body = path.endsWith("/state")
        ? JSON.stringify({ partial: { intent_summary: "updated summary" } })
        : JSON.stringify({ goal: "check the basement" });
    }
    const res = await handler(
      new Request(`http://x${path}`, {
        ...init,
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
      }),
    );
    expect(res.status, `${method} ${path}`).toBe(status);
  }
});

test("POST /long-lived/:id/tick triggers a manual reactor tick", async () => {
  const services = tempServices();
  seedAgent(services);
  services.longLivedReactor = {
    manualTick: (agentId: string) => ({ outcome: `manual:${agentId}`, tick_id: "tick-1" }),
    reload: async () => {},
    shutdown: () => {},
  };

  const res = await longLivedTickRoute(
    new Request("http://x/long-lived/home-mgmt/tick", {
      method: "POST",
    }),
    "home-mgmt",
    services,
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ outcome: "manual:home-mgmt", tick_id: "tick-1" });
});

test("POST /long-lived/:id/tick returns not_found and not_active correctly", async () => {
  const services = tempServices();
  services.longLivedReactor = {
    manualTick: () => ({ outcome: "should-not-run" }),
    reload: async () => {},
    shutdown: () => {},
  };

  const missingRes = await longLivedTickRoute(
    new Request("http://x/long-lived/missing/tick", {
      method: "POST",
    }),
    "missing",
    services,
  );
  expect(missingRes.status).toBe(404);
  expect(await missingRes.json()).toEqual({ error: { code: "not_found" } });

  seedAgent(services);
  services.db.query("UPDATE long_lived_agents SET status='paused' WHERE id='home-mgmt'").run();

  const pausedRes = await longLivedTickRoute(
    new Request("http://x/long-lived/home-mgmt/tick", {
      method: "POST",
    }),
    "home-mgmt",
    services,
  );
  expect(pausedRes.status).toBe(409);
  expect(await pausedRes.json()).toEqual({ error: { code: "not_active", status: "paused" } });
});

test("POST /long-lived/:id/tick rate-limits consecutive manual ticks", async () => {
  const services = tempServices();
  seedAgent(services);
  services.longLivedReactor = {
    manualTick: (agentId: string) => ({ outcome: `manual:${agentId}`, tick_id: "tick-1" }),
    reload: async () => {},
    shutdown: () => {},
  };

  const first = await longLivedTickRoute(
    new Request("http://x/long-lived/home-mgmt/tick", {
      method: "POST",
    }),
    "home-mgmt",
    services,
  );
  expect(first.status).toBe(200);

  const second = await longLivedTickRoute(
    new Request("http://x/long-lived/home-mgmt/tick", {
      method: "POST",
    }),
    "home-mgmt",
    services,
  );
  expect(second.status).toBe(429);
  const body = (await second.json()) as { error: { code: string; retry_after_ms: number } };
  expect(body.error.code).toBe("rate_limited");
  expect(body.error.retry_after_ms).toBeGreaterThan(0);
  expect(body.error.retry_after_ms).toBeLessThanOrEqual(1_000);
});

test("POST /long-lived/:id/inject-goal fires an injected_goal tick for cron-less agents", async () => {
  const services = tempServices();
  seedAgent(services);
  services.db.query("UPDATE long_lived_agents SET schedule_cron = NULL WHERE id='home-mgmt'").run();

  const ticks: string[] = [];
  const now = services.clock().getTime();
  services.longLivedReactor = {
    injectedGoalTick: (agentId: string) => {
      ticks.push(agentId);
      services.db
        .query(
          "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES (?, ?, ?, ?)",
        )
        .run(`tick-injected-${agentId}`, agentId, "injected_goal", now);
      return { outcome: `injected:${agentId}`, tick_id: "tick-injected" };
    },
    reload: async () => {},
    shutdown: () => {},
  };

  const injectGoalRes = await longLivedInjectGoalRoute(
    new Request("http://x/long-lived/home-mgmt/inject-goal", {
      method: "POST",
      body: JSON.stringify({ goal: "check the basement" }),
    }),
    "home-mgmt",
    services,
  );
  expect(injectGoalRes.status).toBe(200);
  expect(await injectGoalRes.json()).toEqual({ ok: true });
  expect(ticks).toEqual(["home-mgmt"]);
  const row = services.db
    .query(
      "SELECT COUNT(*) as c FROM long_lived_ticks WHERE agent_id='home-mgmt' AND trigger_kind='injected_goal'",
    )
    .get() as { c: number };
  expect(row.c).toBe(1);
});

test("POST /long-lived/pending-actions/:id/approve publishes decision event and fires injected_goal tick", async () => {
  const services = tempServices();
  seedAgent(services);
  services.db
    .query(
      `INSERT INTO long_lived_ticks (
      id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
      completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "tick-for-action",
      "home-mgmt",
      "chain-1",
      "manual",
      JSON.stringify({ manual: true }),
      "review queue",
      1000,
      null,
      null,
      null,
      null,
      null,
    );
  services.db
    .query(
      `INSERT INTO long_lived_pending_actions (
      id, agent_id, tick_id, action_kind, action_target, payload_json, rationale,
      status, expires_at, decided_by, decided_at, executed_in_tick_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "approve-action",
      "home-mgmt",
      "tick-for-action",
      "notify",
      "ha:state",
      JSON.stringify({ message: "ping" }),
      "needs attention",
      "pending",
      999999,
      null,
      null,
      null,
      1500,
    );

  const decidedEvents: Array<{
    event: string;
    agent_id: string;
    payload: { action_id: string; decision: string };
  }> = [];
  const unsubscribe = services.handoffEvents.subscribe((evt) => {
    if ((evt as { event?: string }).event === "long_lived_action_decided") {
      decidedEvents.push(
        evt as { event: string; payload: { action_id: string; decision: string } },
      );
    }
  });

  const fired: string[] = [];
  const now = services.clock().getTime();
  services.longLivedReactor = {
    injectedGoalTick: (agentId: string) => {
      fired.push(agentId);
      services.db
        .query(
          "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES (?, ?, ?, ?)",
        )
        .run(`tick-injected-${agentId}-approve`, agentId, "injected_goal", now);
      return { outcome: `injected:${agentId}`, tick_id: "tick-injected-2" };
    },
    reload: async () => {},
    shutdown: () => {},
  };

  const approveRes = await longLivedApproveActionRoute(
    new Request("http://x/long-lived/pending-actions/approve-action/approve", {
      method: "POST",
      body: JSON.stringify({ decided_by: "test" }),
    }),
    "approve-action",
    services,
  );

  unsubscribe();
  expect(approveRes.status).toBe(200);
  expect(await approveRes.json()).toEqual({ ok: true });
  expect(fired).toEqual(["home-mgmt"]);
  expect(decidedEvents).toHaveLength(1);
  expect(decidedEvents[0]).toEqual({
    event: "long_lived_action_decided",
    agent_id: "home-mgmt",
    payload: { action_id: "approve-action", decision: "approved" },
  });
  const row = services.db
    .query(
      "SELECT COUNT(*) as c FROM long_lived_ticks WHERE agent_id='home-mgmt' AND trigger_kind='injected_goal'",
    )
    .get() as { c: number };
  expect(row.c).toBe(1);
});

import { TaskRouterConfigSchema, type TaskRouterConfig } from "@penumbra/config";
import {
  AgentPerformanceWriter,
  type AgentRoutingConfig,
  loadSqliteVec,
  migrate,
  type Services,
  setRoutingBias,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";

import {
  resolveSingleRoute,
  RouterHardConstraintExhaustedError,
  type RouterDecisionSink,
} from "../../src/routes/role-routing.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    /* already loaded */
  }
}

const NOW = "2026-05-01T12:00:00Z";

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function writePerf(db: Database, agent: string): void {
  new AgentPerformanceWriter(db).upsert({
    performance_id: `perf-${agent}`,
    ts: NOW,
    handoff_id: `handoff-${agent}`,
    conversation_id: "conv",
    project_id: "proj",
    agent_name: agent,
    task_type: "review_adversarial",
    outcome: "merged",
    rounds: 1,
    smoke_pass: "y",
    reviewer_findings: 0,
    maestro_score: null,
    cost_usd: null,
    tokens_used: 100,
    latency_ms: 10_000,
    source: "test",
    notes: null,
    metadata_json: "{}",
  });
}

function writePressure(db: Database, provider: string, usedPct: number): void {
  db.prepare(
    `
    INSERT INTO t0_events (
      event_id, ts, ingest_ts, source, user_id, machine_id,
      event_type, lane, provider, payload_json
    ) VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'rate-limit-snapshot', 'cli-subscription', ?, ?)
  `,
  ).run(
    `pressure-${provider}`,
    NOW,
    NOW,
    provider,
    JSON.stringify({
      window_label: "24h",
      model: null,
      used_pct: usedPct,
      resets_at: null,
      source_kind: "subscription",
    }),
  );
}

function writeBias(
  db: Database,
  scope: "provider" | "agent",
  value: string,
  mode: "boost" | "divert" | "exclude",
  opts: { weight?: number; expiresAt?: string } = {},
): void {
  setRoutingBias(db, {
    scope,
    value,
    mode,
    weight: opts.weight ?? null,
    reason: "test",
    ...(opts.expiresAt ? { expires_at: opts.expiresAt } : { ttl_seconds: 3600 }),
    now: new Date(NOW),
  });
}

function routing(): AgentRoutingConfig {
  return {
    agents: [
      {
        name: "alpha",
        roles: ["reviewer"],
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
      },
      {
        name: "beta",
        roles: ["reviewer"],
        pricing_mode: "subscription",
        subscription_provider: "openai",
      },
    ],
    default_roles: {},
    role_exploration_policy: "ranked-first",
  };
}

function services(db: Database, agentRouting: AgentRoutingConfig | null = routing()): Services {
  return {
    db,
    agentRouting,
    agentRegistry: ["alpha", "beta"],
    clock: () => new Date(NOW),
    log: { warn: () => undefined } as Services["log"],
  } as Services;
}

function routerConfig(mode: TaskRouterConfig["mode"]): TaskRouterConfig {
  return TaskRouterConfigSchema.parse({ mode });
}

describe("resolveSingleRoute", () => {
  test("skips a pressured provider and routes to an alternate role agent", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    writePressure(db, "anthropic", 95);
    writePressure(db, "openai", 5);

    expect(
      resolveSingleRoute(services(db), "reviewer", "review this", "review_adversarial"),
    ).toEqual({
      agent: "beta",
      role: "reviewer",
      taskType: "review_adversarial",
    });
  });

  test("without pressure it returns the top-ranked role agent", () => {
    const db = freshDb();
    writePerf(db, "alpha");

    expect(
      resolveSingleRoute(services(db), "reviewer", "review this", "review_adversarial"),
    ).toEqual({
      agent: "alpha",
      role: "reviewer",
      taskType: "review_adversarial",
    });
  });

  test("pressure read failures degrade to normal routing", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    db.run("DROP TABLE t0_events");

    expect(
      resolveSingleRoute(services(db), "reviewer", "review this", "review_adversarial"),
    ).toEqual({
      agent: "alpha",
      role: "reviewer",
      taskType: "review_adversarial",
    });
  });

  test("missing agent routing remains a null route", () => {
    const db = freshDb();
    writePerf(db, "alpha");

    expect(
      resolveSingleRoute(services(db, null), "reviewer", "review this", "review_adversarial"),
    ).toBeNull();
  });

  test("an exclude bias steers selection away from the excluded agent", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    writeBias(db, "agent", "alpha", "exclude");

    expect(
      resolveSingleRoute(services(db), "reviewer", "review this", "review_adversarial"),
    ).toEqual({
      agent: "beta",
      role: "reviewer",
      taskType: "review_adversarial",
    });
  });

  test("excluding all role providers still returns a route (safe fallback)", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    writeBias(db, "provider", "anthropic", "exclude");
    writeBias(db, "provider", "openai", "exclude");

    const route = resolveSingleRoute(services(db), "reviewer", "review this", "review_adversarial");
    expect(route).not.toBeNull();
    expect(["alpha", "beta"]).toContain(route!.agent);
  });

  test("an expired bias is ignored", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    writeBias(db, "agent", "alpha", "exclude", { expiresAt: "2026-04-01T00:00:00.000Z" });

    expect(
      resolveSingleRoute(services(db), "reviewer", "review this", "review_adversarial"),
    ).toEqual({
      agent: "alpha",
      role: "reviewer",
      taskType: "review_adversarial",
    });
  });

  test("bias read failures degrade to normal routing", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    db.run("DROP TABLE routing_bias");

    expect(
      resolveSingleRoute(services(db), "reviewer", "review this", "review_adversarial"),
    ).toEqual({
      agent: "alpha",
      role: "reviewer",
      taskType: "review_adversarial",
    });
  });

  test("excludes unhealthy seats reported by the local seat health service", () => {
    const db = freshDb();
    writePerf(db, "alpha");

    const svc = services(db);
    svc.localSeatHealth = {
      getUnhealthyAgents: () => new Set(["alpha"]),
    };

    expect(resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial")).toEqual({
      agent: "beta",
      role: "reviewer",
      taskType: "review_adversarial",
    });
  });

  test("local seat health read failures degrade to normal routing", () => {
    const db = freshDb();
    writePerf(db, "alpha");

    const svc = services(db);
    svc.localSeatHealth = {
      getUnhealthyAgents: () => {
        throw new Error("health unavailable");
      },
    };

    expect(resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial")).toEqual({
      agent: "alpha",
      role: "reviewer",
      taskType: "review_adversarial",
    });
  });

  test("does not gate any agent when no local seat health service is wired (gate off)", () => {
    const db = freshDb();
    writePerf(db, "alpha");

    const svc = services(db);
    expect(svc.localSeatHealth).toBeUndefined();

    expect(resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial")).toEqual({
      agent: "alpha",
      role: "reviewer",
      taskType: "review_adversarial",
    });
  });
});

describe("resolveSingleRoute — model task router modes", () => {
  test("an absent taskRouterConfig behaves exactly like mode:'off' (no router involvement)", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    const svc = services(db);
    expect(svc.taskRouterConfig).toBeUndefined();

    expect(resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial")).toEqual({
      agent: "alpha",
      role: "reviewer",
      taskType: "review_adversarial",
    });
  });

  test("mode:'shadow' returns the legacy route unchanged while recording a decision via the sink", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    const svc = services(db);
    svc.taskRouterConfig = routerConfig("shadow");
    svc.modelAliasMap = {};

    const sink: RouterDecisionSink = { decision: null };
    const route = resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {
      decisionSink: sink,
    });

    expect(route).toEqual({ agent: "alpha", role: "reviewer", taskType: "review_adversarial" });
    expect(sink.decision).not.toBeNull();
    expect(sink.decision?.taskProfile.taskTypes.length).toBeGreaterThan(0);
  });

  test("mode:'recommend' is wired identically to shadow: route untouched, decision recorded", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    const svc = services(db);
    svc.taskRouterConfig = routerConfig("recommend");
    svc.modelAliasMap = {};

    const sink: RouterDecisionSink = { decision: null };
    const route = resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {
      decisionSink: sink,
    });

    expect(route).toEqual({ agent: "alpha", role: "reviewer", taskType: "review_adversarial" });
    expect(sink.decision).not.toBeNull();
  });

  test("mode:'auto' returns the router's own selection", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    const svc = services(db);
    svc.taskRouterConfig = routerConfig("auto");
    svc.modelAliasMap = {};

    expect(resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {})).toEqual({
      agent: "alpha",
      role: "reviewer",
      taskType: "review_adversarial",
    });
  });

  test("mode:'auto' throws a legible hard-constraint error instead of silently falling back", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    const svc = services(db);
    svc.taskRouterConfig = routerConfig("auto");
    svc.modelAliasMap = {};
    svc.localSeatHealth = { getUnhealthyAgents: () => new Set(["alpha", "beta"]) };

    let caught: unknown;
    try {
      resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RouterHardConstraintExhaustedError);
    const err = caught as RouterHardConstraintExhaustedError;
    expect(err.decision.selected).toBeNull();
    expect(err.decision.alternatives).toHaveLength(2);
    for (const alternative of err.decision.alternatives) {
      expect(alternative.excluded).toBe(true);
      expect(alternative.reasons).toContain("unhealthy_or_unavailable");
    }
  });

  test("mode:'auto' logs a router failure and degrades to legacy routing", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    const svc = services(db);
    // Deliberately malformed: bypasses TaskRouterConfigSchema's defaults so
    // decide()'s internal weight/threshold reads throw, exercising the same
    // degrade-to-legacy shape as the pressure/bias reads above.
    svc.taskRouterConfig = { mode: "auto" } as unknown as TaskRouterConfig;
    svc.modelAliasMap = {};
    const warnSpy = spyOn(svc.log, "warn");

    expect(resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {})).toEqual({
      agent: "alpha",
      role: "reviewer",
      taskType: "review_adversarial",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "reviewer",
        mode: "auto",
        error: expect.any(String),
      }),
      expect.any(String),
    );
  });

  test("mode:'auto' degrades to the legacy route when pressure excludes every candidate", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    writePressure(db, "anthropic", 95);
    writePressure(db, "openai", 95);
    const svc = services(db);
    const legacyRoute = resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial");
    svc.taskRouterConfig = routerConfig("auto");
    svc.modelAliasMap = {};

    expect(resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {})).toEqual(
      legacyRoute,
    );
  });

  test("mode:'auto' degrades to the legacy null route for an empty role pool", () => {
    const db = freshDb();
    const svc = services(db, {
      agents: [
        { name: "alpha", roles: ["executor"] },
        { name: "beta", roles: ["executor"] },
      ],
      default_roles: {},
    });
    const legacyRoute = resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial");
    expect(legacyRoute).toBeNull();
    svc.taskRouterConfig = routerConfig("auto");
    svc.modelAliasMap = {};

    expect(resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {})).toBeNull();
  });

  test("mode:'auto' without routing hints never invokes the router", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    const svc = services(db);
    svc.taskRouterConfig = { mode: "auto" } as unknown as TaskRouterConfig;
    svc.modelAliasMap = {};
    const warnSpy = spyOn(svc.log, "warn");

    expect(resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial")).toEqual({
      agent: "alpha",
      role: "reviewer",
      taskType: "review_adversarial",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("mode:'auto' with a local-only constraint fails closed rather than ever picking a remote seat", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    writePerf(db, "beta");
    const svc = services(db);
    svc.taskRouterConfig = routerConfig("auto");
    svc.modelAliasMap = {};

    let caught: unknown;
    try {
      resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {
        localOnly: true,
      });
    } catch (err) {
      caught = err;
    }

    // No candidate's remoteness is known yet (Phase 12 does not populate
    // per-candidate isRemote facts), so a local-only constraint must fail
    // closed to "no selection" -- it can never accidentally select a remote
    // seat by guessing.
    expect(caught).toBeInstanceOf(RouterHardConstraintExhaustedError);
    const err = caught as RouterHardConstraintExhaustedError;
    expect(err.decision.selected).toBeNull();
    for (const alternative of err.decision.alternatives) {
      expect(alternative.reasons).toContain("privacy_local_only_unknown_remoteness");
    }
  });
});

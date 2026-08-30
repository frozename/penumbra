import { TaskRouterConfigSchema, type TaskRouterConfig } from "@penumbra/config";
import {
  AgentPerformanceWriter,
  type AgentRoutingConfig,
  createAaSnapshotStore,
  loadSqliteVec,
  migrate,
  type AaSnapshotStore,
  type AaSnapshotStorePayload,
  type Services,
  setRoutingBias,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveSingleRoute,
  RoutingBiasExhaustedError,
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

function missingAaSnapshotStore(): AaSnapshotStore {
  return {
    read: async () => ({ state: "missing", stale: false, ageSeconds: null, source: "missing" }),
    readSync: () => ({ state: "missing", stale: false, ageSeconds: null, source: "missing" }),
    write: async () => ({ state: "missing", stale: false, ageSeconds: null, source: "missing" }),
    refresh: async () => ({ state: "missing", stale: false, ageSeconds: null, source: "missing" }),
  };
}

function services(db: Database, agentRouting: AgentRoutingConfig | null = routing()): Services {
  return {
    db,
    agentRouting,
    agentRegistry: ["alpha", "beta"],
    clock: () => new Date(NOW),
    log: { warn: () => undefined } as Services["log"],
    aaSnapshotStore: missingAaSnapshotStore(),
  } as Services;
}

function routerConfig(mode: TaskRouterConfig["mode"]): TaskRouterConfig {
  return TaskRouterConfigSchema.parse({ mode });
}

function aaSnapshotPayload(): AaSnapshotStorePayload {
  return {
    provenance: {
      collectedAt: NOW,
      dataVersion: "daemon-role-routing-test",
      benchmarkVersion: "bench-test",
    },
    models: [
      {
        id: "aa:alpha",
        name: "Alpha Model",
        slug: "alpha-model",
        model_creator: { id: "creator:openai", name: "OpenAI", slug: "openai" },
        evaluations: {
          artificial_analysis_intelligence_index: 91,
          artificial_analysis_coding_index: 87,
          terminalbench_hard: 65,
        },
        pricing: {
          price_1m_input_tokens: 2,
          price_1m_output_tokens: 8,
        },
        median_output_tokens_per_second: 80,
        median_time_to_first_token_seconds: 0.4,
      },
      {
        id: "aa:beta",
        name: "Beta Model",
        slug: "beta-model",
        model_creator: { id: "creator:anthropic", name: "Anthropic", slug: "anthropic" },
        evaluations: {
          artificial_analysis_intelligence_index: 70,
          artificial_analysis_coding_index: 62,
          terminalbench_hard: 45,
        },
        pricing: {
          price_1m_input_tokens: 1,
          price_1m_output_tokens: 4,
        },
        median_output_tokens_per_second: 40,
        median_time_to_first_token_seconds: 1.2,
      },
    ],
  };
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

  test("excluding all role providers throws a typed bias-exhaustion error instead of re-admitting", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    writeBias(db, "provider", "anthropic", "exclude");
    writeBias(db, "provider", "openai", "exclude");

    expect(() =>
      resolveSingleRoute(services(db), "reviewer", "review this", "review_adversarial"),
    ).toThrow(RoutingBiasExhaustedError);
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

  test("mode:'shadow' reads the daemon AA snapshot store into the router decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "role-routing-aa-"));
    try {
      const db = freshDb();
      writePerf(db, "alpha");
      const store = createAaSnapshotStore({
        path: join(dir, "aa-snapshot.json"),
        ttlSeconds: 3600,
        now: () => new Date(NOW),
      });
      await store.write(aaSnapshotPayload(), {
        fetchedAtIso: NOW,
        ttlSeconds: 3600,
      });

      const svc = services(db) as Services & { aaSnapshotStore: AaSnapshotStore };
      svc.taskRouterConfig = routerConfig("shadow");
      svc.modelAliasMap = {
        alpha: { aa_creator: "openai", aa_slug: "alpha-model" },
        beta: { aa_creator: "anthropic", aa_slug: "beta-model" },
      };
      svc.aaSnapshotStore = store;

      const sink: RouterDecisionSink = { decision: null };
      const route = resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {
        decisionSink: sink,
      });

      expect(route).toEqual({ agent: "alpha", role: "reviewer", taskType: "review_adversarial" });
      expect(sink.decision).not.toBeNull();
      expect(sink.decision?.dataFreshness.artificial_analysis).toBe("fresh");
      expect(sink.decision?.dataFreshness.artificial_analysis_collected_at).toBe(NOW);
      expect(sink.decision?.factors).toContainEqual(
        expect.objectContaining({
          name: "alpha.aa_prior",
          source: "artificial_analysis",
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mode:'shadow' re-reads the AA snapshot store so TTL changes reach decisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "role-routing-aa-ttl-"));
    try {
      const db = freshDb();
      writePerf(db, "alpha");
      const store = createAaSnapshotStore({
        path: join(dir, "aa-snapshot.json"),
        ttlSeconds: 3600,
        now: () => new Date(NOW),
      });
      await store.write(aaSnapshotPayload(), {
        fetchedAtIso: NOW,
        ttlSeconds: 3600,
      });

      const svc = services(db) as Services & { aaSnapshotStore: AaSnapshotStore };
      svc.taskRouterConfig = routerConfig("shadow");
      svc.modelAliasMap = {
        alpha: { aa_creator: "openai", aa_slug: "alpha-model" },
        beta: { aa_creator: "anthropic", aa_slug: "beta-model" },
      };
      svc.aaSnapshotStore = store;

      const freshSink: RouterDecisionSink = { decision: null };
      resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {
        decisionSink: freshSink,
      });
      expect(freshSink.decision?.dataFreshness.artificial_analysis).toBe("fresh");

      const staleFetchedAtIso = "2026-05-01T10:00:00Z";
      const expectedAgeSeconds = String(
        Math.floor((new Date(NOW).getTime() - new Date(staleFetchedAtIso).getTime()) / 1000),
      );
      await store.write(aaSnapshotPayload(), {
        fetchedAtIso: staleFetchedAtIso,
        ttlSeconds: 60,
      });
      const staleSink: RouterDecisionSink = { decision: null };
      resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {
        decisionSink: staleSink,
      });

      expect(staleSink.decision?.dataFreshness.artificial_analysis).toBe("stale");
      expect(staleSink.decision?.dataFreshness.artificial_analysis_age_seconds).toBe(
        expectedAgeSeconds,
      );
      expect(staleSink.decision?.factors).toContainEqual(
        expect.objectContaining({
          name: "aa_staleness_discount",
          source: "config",
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mode:'shadow' degrades to absent AA freshness when the snapshot store is unreadable", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    const svc = services(db) as Services & { aaSnapshotStore: AaSnapshotStore };
    svc.taskRouterConfig = routerConfig("shadow");
    svc.modelAliasMap = {};
    svc.aaSnapshotStore = {
      read: async () => ({ state: "missing", stale: false, ageSeconds: null, source: "missing" }),
      readSync: () => ({ state: "corrupt", stale: false, ageSeconds: null, source: "corrupt" }),
      write: async () => ({ state: "missing", stale: false, ageSeconds: null, source: "missing" }),
      refresh: async () => ({
        state: "missing",
        stale: false,
        ageSeconds: null,
        source: "missing",
      }),
    };

    const sink: RouterDecisionSink = { decision: null };
    const route = resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {
      decisionSink: sink,
    });

    expect(route).toEqual({ agent: "alpha", role: "reviewer", taskType: "review_adversarial" });
    expect(sink.decision?.dataFreshness).toEqual({ artificial_analysis: "absent" });
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

  test("mode:'auto' throws when the role pool contains only fenced roles:[] seats", () => {
    const db = freshDb();
    const svc = services(db, {
      agents: [
        { name: "alpha", roles: [] },
        { name: "beta", roles: [] },
      ],
      default_roles: {},
    });
    const legacyRoute = resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial");
    expect(legacyRoute).toBeNull();
    svc.taskRouterConfig = routerConfig("auto");
    svc.modelAliasMap = {};

    expect(() =>
      resolveSingleRoute(svc, "reviewer", "review this", "review_adversarial", {}),
    ).toThrow(RouterHardConstraintExhaustedError);
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

  test("mode:'auto' throws a legible hard-constraint error when routing biases empty the pool", () => {
    const db = freshDb();
    writePerf(db, "alpha");
    writePerf(db, "beta");
    writeBias(db, "provider", "anthropic", "exclude");
    writeBias(db, "provider", "openai", "exclude");
    const svc = services(db);
    svc.taskRouterConfig = routerConfig("auto");
    svc.modelAliasMap = {};

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
      expect(alternative.reasons).toContain("routing_bias_exclude");
    }
  });
});

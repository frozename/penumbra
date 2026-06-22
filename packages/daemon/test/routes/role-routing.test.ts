import {
  AgentPerformanceWriter,
  type AgentRoutingConfig,
  loadSqliteVec,
  migrate,
  type Services,
  setRoutingBias,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { resolveSingleRoute } from "../../src/routes/role-routing.js";

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
  } as Services;
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
});

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  AgentPerformanceWriter,
  loadSqliteVec,
  migrate,
  type AgentRoutingConfig,
  type Services,
} from "@penumbra/core";
import { resolveSingleRoute } from "../../src/routes/role-routing.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {}
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
    writePressure(db, "anthropic", 0.95);
    writePressure(db, "openai", 0.05);

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
    db.exec("DROP TABLE t0_events");

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
});

import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  loadSqliteVec,
  migrate,
  pickFromPool,
  type PressureResult,
  type RouteAgentInput,
} from "../../src/index.js";
import { AgentPerformanceWriter } from "../../src/writers/agent-performance.js";
import type { AgentTaskType } from "../../src/schemas/agent-performance.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {}
}

const NOW = "2026-05-01T12:00:00Z";

type AgentchatConfig = NonNullable<RouteAgentInput["agentchatConfig"]>;

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function writePerf(
  db: Database,
  agent: string,
  taskType: AgentTaskType,
  overrides: Partial<{
    outcome: "merged" | "pr_opened" | "failed";
    rounds: number;
    latency_ms: number;
  }> = {},
): void {
  new AgentPerformanceWriter(db).upsert({
    performance_id: `${taskType}-${agent}`,
    ts: NOW,
    handoff_id: `handoff-${taskType}-${agent}`,
    conversation_id: "conv",
    project_id: "proj",
    agent_name: agent,
    task_type: taskType,
    outcome: overrides.outcome ?? "merged",
    rounds: overrides.rounds ?? 1,
    smoke_pass: "y",
    reviewer_findings: 0,
    maestro_score: null,
    cost_usd: null,
    tokens_used: 100,
    latency_ms: overrides.latency_ms ?? 10_000,
    source: "test",
    notes: null,
    metadata_json: "{}",
  });
}

function config(headroom_weighting = false): AgentchatConfig {
  return {
    role_routing: { headroom_weighting },
    agents: [
      {
        name: "a",
        roles: [],
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
      },
      {
        name: "b",
        roles: [],
        pricing_mode: "subscription",
        subscription_provider: "openai",
      },
    ],
  };
}

function pressure(anthropic: number, openai: number): PressureResult {
  return {
    warnings: [],
    snapshots: [
      {
        provider: "anthropic",
        window_label: "24h",
        model: null,
        used_pct: anthropic,
        resets_at: null,
        observed_at: NOW,
        source_kind: "subscription",
      },
      {
        provider: "openai",
        window_label: "24h",
        model: null,
        used_pct: openai,
        resets_at: null,
        observed_at: NOW,
        source_kind: "subscription",
      },
    ],
  };
}

describe("pickFromPool", () => {
  test("no pressure selects the highest-scored agent", () => {
    const db = freshDb();
    writePerf(db, "a", "implement_small", { rounds: 1, latency_ms: 10_000 });
    writePerf(db, "b", "implement_small", { rounds: 5, latency_ms: 60_000 });

    expect(pickFromPool(["a", "b"], db, config(), undefined, "implement_small")).toBe("a");
  });

  test("forces headroom weighting locally and sheds a pressured provider", () => {
    const db = freshDb();
    const agentchatConfig = config(false);
    writePerf(db, "a", "implement_small", { rounds: 1, latency_ms: 10_000 });
    writePerf(db, "b", "implement_small", { rounds: 5, latency_ms: 60_000 });

    expect(
      pickFromPool(["a", "b"], db, agentchatConfig, pressure(0.95, 0.1), "implement_small"),
    ).toBe("b");
    expect(agentchatConfig.role_routing?.headroom_weighting).toBe(false);
  });

  test("cold-start falls back to the first pool agent", () => {
    const db = freshDb();

    expect(pickFromPool(["a", "b"], db, config(), undefined, "implement_small")).toBe("a");
  });

  test("single-element pool returns immediately without querying the database", () => {
    const db = freshDb();
    const querySpy = spyOn(db, "query");

    expect(pickFromPool(["a"], db, config(), undefined, "implement_small")).toBe("a");
    expect(querySpy).not.toHaveBeenCalled();
  });

  test("all providers over pressure still returns a fallback result", () => {
    const db = freshDb();
    writePerf(db, "a", "implement_small", { rounds: 1, latency_ms: 10_000 });
    writePerf(db, "b", "implement_small", { rounds: 5, latency_ms: 60_000 });

    expect(pickFromPool(["a", "b"], db, config(), pressure(0.95, 0.97), "implement_small")).toBe(
      "a",
    );
  });

  test("empty pool throws", () => {
    const db = freshDb();

    expect(() => pickFromPool([], db, config(), undefined, "implement_small")).toThrow(
      /pool must not be empty/,
    );
  });

  test("task type is threaded into the rank query", () => {
    const db = freshDb();
    writePerf(db, "b", "review_adversarial", { rounds: 1, latency_ms: 10_000 });

    expect(pickFromPool(["a", "b"], db, config(), undefined, "review_adversarial")).toBe("b");
  });
});

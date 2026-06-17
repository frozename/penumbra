import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  AgentPerformanceWriter,
  loadSqliteVec,
  migrate,
} from "../../../packages/core/src/index.js";
import type { WorkflowCtx } from "../../../packages/workflows/src/ctx.js";
import { parseAgentField, resolveAgent } from "./pool-resolver.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {}
}

const NOW = new Date().toISOString();

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
    rounds: agent === "a" ? 1 : 5,
    smoke_pass: "y",
    reviewer_findings: 0,
    maestro_score: null,
    cost_usd: null,
    tokens_used: 100,
    latency_ms: agent === "a" ? 10_000 : 60_000,
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

function ctx(overrides: Partial<WorkflowCtx> = {}): WorkflowCtx {
  return {
    dispatch: async () => ({ conversation_id: "conv", handoff_id: "handoff" }),
    awaitChain: async () => ({ status: "completed", final_agent: "a", response_text: "ok" }),
    fileWrite: async () => "path",
    config: {
      role_routing: { headroom_weighting: false },
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
    },
    cwd: "/tmp/work",
    storageRoot: "/tmp/storage",
    project: "proj",
    args: {},
    ...overrides,
  };
}

describe("parseAgentField", () => {
  test("parses strings and non-empty arrays", () => {
    expect(parseAgentField("a")).toEqual({ kind: "single", agent: "a" });
    expect(parseAgentField(["a", "b"])).toEqual({ kind: "pool", agents: ["a", "b"] });
  });

  test("returns null for absent or empty values", () => {
    expect(parseAgentField(undefined)).toBeNull();
    expect(parseAgentField([])).toBeNull();
  });
});

describe("resolveAgent", () => {
  test("returns single agents without opening the database", () => {
    let dbCalls = 0;
    const out = resolveAgent({ kind: "single", agent: "a" }, "review_adversarial", {
      ...ctx(),
      db: () => {
        dbCalls += 1;
        return freshDb();
      },
    });

    expect(out).toBe("a");
    expect(dbCalls).toBe(0);
  });

  test("resolves pools using pressure-aware selection", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writePressure(db, "anthropic", 0.95);
    writePressure(db, "openai", 0.1);

    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("b");
  });

  test("returns the first pool agent when no workflow database is available", () => {
    expect(resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", ctx())).toBe(
      "a",
    );
  });
});

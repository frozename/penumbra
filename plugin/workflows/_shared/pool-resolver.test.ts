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
  test("parses strings, non-empty arrays, and object pools", () => {
    expect(parseAgentField("a")).toEqual({ kind: "single", agent: "a" });
    expect(parseAgentField(["a", "b"])).toEqual({ kind: "pool", agents: ["a", "b"] });
    expect(
      parseAgentField({
        members: [{ agent: "a" }, { agent: "b", tier: "cloud" }],
        select: "order",
        fallback_to_cloud: true,
      }),
    ).toEqual({ kind: "pool", agents: ["a", "b"] });
  });

  test("returns null for absent or empty values", () => {
    expect(parseAgentField(undefined)).toBeNull();
    expect(parseAgentField([])).toBeNull();
    expect(parseAgentField({ members: [] })).toBeNull();
  });
});

describe("agentPoolToNames", () => {
  test("normalizes every agent pool form to declaration-order names", async () => {
    const { agentPoolToNames } =
      (await import("./pool-resolver.js")) as typeof import("./pool-resolver.js") & {
        agentPoolToNames?: (pool: unknown) => string[];
      };
    expect(agentPoolToNames).toBeFunction();

    expect(agentPoolToNames("a")).toEqual(["a"]);
    expect(agentPoolToNames(["a", "b"])).toEqual(["a", "b"]);
    expect(
      agentPoolToNames?.({
        members: [{ agent: "a", tier: "local" }, { agent: "b" }],
        select: "rank",
      }),
    ).toEqual(["a", "b"]);
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
    writePressure(db, "anthropic", 95);
    writePressure(db, "openai", 10);

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

  test("tool_free:true reaches the scorer and demotes an ACP twin in favor of an equivalent HTTP twin", () => {
    // Two agents with identical performance histories so the only score
    // differentiator is the adapter-aware penalty wired through tool_free.
    // "acp-twin" carries an ACP adapter; "http-twin" carries an HTTP adapter.
    const db = freshDb();
    writePerf(db, "acp-twin");
    writePerf(db, "http-twin");
    const ctxWithAdapters = ctx({
      config: {
        role_routing: { headroom_weighting: false },
        agents: [
          {
            name: "acp-twin",
            roles: [],
            pricing_mode: "subscription",
            subscription_provider: "anthropic",
            adapter: "stdio-acp",
          },
          {
            name: "http-twin",
            roles: [],
            pricing_mode: "subscription",
            subscription_provider: "openai",
            adapter: "openai-compat-http",
          },
        ],
      },
      db: () => db,
    });

    // tool_free unset is the inert baseline. With identical performance the
    // scorer ties; pickFromPool's pickPreferred breaks the tie deterministically
    // and "acp-twin" wins by declaration order (no penalty).
    expect(
      resolveAgent(
        { kind: "pool", agents: ["acp-twin", "http-twin"] },
        "review_adversarial",
        ctxWithAdapters,
      ),
    ).toBe("acp-twin");

    // tool_free:true flips the winner: the ACP candidate gets the 0.85 penalty
    // and the HTTP twin overtakes it. Confirms the flag flows resolveAgent →
    // pickFromPool → routeAgent and the scorer's adapter check fires.
    expect(
      resolveAgent(
        { kind: "pool", agents: ["acp-twin", "http-twin"] },
        "review_adversarial",
        ctxWithAdapters,
        { tool_free: true },
      ),
    ).toBe("http-twin");
  });

  test("tool_free unset (the default for tool-needing callers) leaves the ACP candidate eligible to win", () => {
    // Mirrors the inert-default contract from the routeAgent test layer: a
    // caller that does NOT opt into tool_free must see ACP candidates compete
    // on baseline merit, with no transport penalty. Guards against the wiring
    // accidentally defaulting to true and breaking tool-needing roles.
    const db = freshDb();
    writePerf(db, "acp-twin");
    writePerf(db, "http-twin");
    const ctxWithAdapters = ctx({
      config: {
        role_routing: { headroom_weighting: false },
        agents: [
          {
            name: "acp-twin",
            roles: [],
            pricing_mode: "subscription",
            subscription_provider: "anthropic",
            adapter: "stdio-acp",
          },
          {
            name: "http-twin",
            roles: [],
            pricing_mode: "subscription",
            subscription_provider: "openai",
            adapter: "openai-compat-http",
          },
        ],
      },
      db: () => db,
    });

    // No tool_free → ACP keeps parity and wins on declaration-order tiebreak.
    expect(
      resolveAgent(
        { kind: "pool", agents: ["acp-twin", "http-twin"] },
        "review_adversarial",
        ctxWithAdapters,
      ),
    ).toBe("acp-twin");
    // Explicit false is also inert.
    expect(
      resolveAgent(
        { kind: "pool", agents: ["acp-twin", "http-twin"] },
        "review_adversarial",
        ctxWithAdapters,
        { tool_free: false },
      ),
    ).toBe("acp-twin");
  });
});

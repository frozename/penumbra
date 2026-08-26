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

function writePerf(db: Database, agent: string, taskType = "review_adversarial"): void {
  new AgentPerformanceWriter(db).upsert({
    performance_id: `perf-${agent}`,
    ts: NOW,
    handoff_id: `handoff-${agent}`,
    conversation_id: "conv",
    project_id: "proj",
    agent_name: agent,
    task_type: taskType,
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

function writeBias(
  db: Database,
  scope: "provider" | "agent",
  value: string,
  mode: "boost" | "divert" | "exclude",
  expiresAt = new Date(Date.parse(NOW) + 60_000).toISOString(),
): void {
  db.prepare(
    `INSERT INTO routing_bias (
      bias_id, scope, value, mode, weight, reason, created_at, expires_at
    ) VALUES (?, ?, ?, ?, NULL, 'test', ?, ?)`,
  ).run(`bias-${scope}-${value}-${mode}`, scope, value, mode, NOW, expiresAt);
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
          roles: ["reviewer"],
          pricing_mode: "subscription",
          subscription_provider: "anthropic",
        },
        {
          name: "b",
          roles: ["reviewer"],
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
  test("keeps the configured single agent when no fallback role is provided", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent({ kind: "single", agent: "a" }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("a");
  });

  test("routes away from a single preferred agent excluded by provider bias", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        {
          ...ctx(),
          db: () => db,
        },
        { fallback_role: "reviewer" },
      ),
    ).toBe("b");
  });

  test("limits a single-agent fallback to reviewer-role agents", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writePerf(db, "c");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              {
                name: "a",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "anthropic",
              },
              {
                name: "b",
                roles: ["executor"],
                pricing_mode: "subscription",
                subscription_provider: "openai",
              },
              {
                name: "c",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "google",
              },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "reviewer" },
      ),
    ).toBe("c");
  });

  test("safely re-admits an excluded planner when no other planner-role agent exists", () => {
    const db = freshDb();
    writePerf(db, "a", "plan_refine");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "plan_refine",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              {
                name: "a",
                roles: ["planner"],
                pricing_mode: "subscription",
                subscription_provider: "anthropic",
              },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "planner" },
      ),
    ).toBe("a");
  });

  test("limits a plan-refine fallback to planner-role agents", () => {
    const db = freshDb();
    writePerf(db, "a", "plan_refine");
    writePerf(db, "b", "plan_refine");
    writePerf(db, "c", "plan_refine");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "plan_refine",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              {
                name: "a",
                roles: ["planner"],
                pricing_mode: "subscription",
                subscription_provider: "anthropic",
              },
              {
                name: "b",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "openai",
              },
              {
                name: "c",
                roles: ["planner"],
                pricing_mode: "subscription",
                subscription_provider: "google",
              },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "planner" },
      ),
    ).toBe("c");
  });

  test("avoids a pressured reviewer on a single-agent fallback", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writePerf(db, "c");
    writeBias(db, "provider", "anthropic", "exclude");
    writePressure(db, "openai", 95);
    writePressure(db, "google", 10);

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              {
                name: "a",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "anthropic",
              },
              {
                name: "b",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "openai",
              },
              {
                name: "c",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "google",
              },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "reviewer" },
      ),
    ).toBe("c");
  });

  test("forwards tool_free on a single-agent fallback", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writePerf(db, "c");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        ctx({
          config: {
            role_routing: { headroom_weighting: false },
            agents: [
              {
                name: "a",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "anthropic",
              },
              {
                name: "b",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "openai",
                adapter: "stdio-acp",
              },
              {
                name: "c",
                roles: ["reviewer"],
                pricing_mode: "subscription",
                subscription_provider: "google",
                adapter: "openai-compat-http",
              },
            ],
          },
          db: () => db,
        }),
        { fallback_role: "reviewer", tool_free: true },
      ),
    ).toBe("c");
  });

  test("safely re-admits the preferred single agent when biases exclude every candidate", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writeBias(db, "provider", "anthropic", "exclude");
    writeBias(db, "provider", "openai", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        {
          ...ctx(),
          db: () => db,
        },
        { fallback_role: "reviewer" },
      ),
    ).toBe("a");
  });

  test("does not pick an excluded pool member when a non-excluded member exists", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writeBias(db, "provider", "anthropic", "exclude");

    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("b");
  });

  test("applies boost biases while resolving a pool", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    db.query(
      `UPDATE agent_performance SET rounds = 1, latency_ms = 10000 WHERE agent_name = 'b'`,
    ).run();
    writeBias(db, "agent", "b", "boost");

    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("b");
  });

  test("applies divert biases while resolving a pool", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    db.query(
      `UPDATE agent_performance SET rounds = 1, latency_ms = 10000 WHERE agent_name = 'b'`,
    ).run();
    writeBias(db, "agent", "a", "divert");

    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("b");
  });

  test("honors agent-scoped exclusions for a configured single agent", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writeBias(db, "agent", "a", "exclude");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        {
          ...ctx(),
          db: () => db,
        },
        { fallback_role: "reviewer" },
      ),
    ).toBe("b");
  });

  test("ignores expired routing biases", () => {
    const db = freshDb();
    writePerf(db, "a");
    writePerf(db, "b");
    writeBias(
      db,
      "provider",
      "anthropic",
      "exclude",
      new Date(Date.parse(NOW) - 60_000).toISOString(),
    );

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        {
          ...ctx(),
          db: () => db,
        },
        { fallback_role: "reviewer" },
      ),
    ).toBe("a");
  });

  test("keeps current single and pool behavior when the workflow database is unavailable", () => {
    const workflowCtx = ctx();

    expect(resolveAgent({ kind: "single", agent: "a" }, "review_adversarial", workflowCtx)).toBe(
      "a",
    );
    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", workflowCtx),
    ).toBe("a");
    expect(
      resolveAgent({ kind: "pool", agents: ["a", "b"] }, "review_adversarial", workflowCtx, {
        excludeAgents: ["a"],
      }),
    ).toBe("b");
  });

  test("degrades to the configured single agent when the bias store read fails", () => {
    const db = freshDb();
    db.exec("DROP TABLE routing_bias");

    expect(
      resolveAgent({ kind: "single", agent: "a" }, "review_adversarial", {
        ...ctx(),
        db: () => db,
      }),
    ).toBe("a");
  });

  test("degrades to the configured single agent when fallback routing throws", () => {
    const db = freshDb();
    writeBias(db, "provider", "anthropic", "exclude");
    db.exec("DROP TABLE agent_performance");

    expect(
      resolveAgent(
        { kind: "single", agent: "a" },
        "review_adversarial",
        {
          ...ctx(),
          db: () => db,
        },
        { fallback_role: "reviewer" },
      ),
    ).toBe("a");
  });

  test("reads the database once and keeps the configured single agent when no bias is active", () => {
    let dbCalls = 0;
    const db = freshDb();
    const out = resolveAgent({ kind: "single", agent: "a" }, "review_adversarial", {
      ...ctx(),
      db: () => {
        dbCalls += 1;
        return db;
      },
    });

    expect(out).toBe("a");
    expect(dbCalls).toBe(1);
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

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { loadSqliteVec, migrate, pickFromPool } from "@src/index.js";
import type { RoutingBias } from "@src/readers/routing-bias.js";
import type { AgentTaskType } from "@src/schemas/agent-performance.js";
import { routeAgent, type RouteAgentInput } from "@src/services/agent-routing.js";
import { AgentPerformanceWriter } from "@src/writers/agent-performance.js";

import {
  buildRetryRoutingMaps,
  type RetryAgentCandidate,
  selectRetryAgent,
} from "../../../agentchat/src/worker/silent-failure-retry.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    /* already loaded */
  }
}

const NOW = "2026-08-27T12:00:00.000Z";

type AgentchatConfig = NonNullable<RouteAgentInput["agentchatConfig"]>;
type RouteCheck = {
  detail: string;
  route: { agent: string } | null;
};

function runRoute(input: RouteAgentInput): RouteCheck {
  return routeAgent(input) as unknown as RouteCheck;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function writePerf(db: Database, agent: string, taskType: AgentTaskType = "implement_small"): void {
  new AgentPerformanceWriter(db).upsert({
    performance_id: `perf-${taskType}-${agent}`,
    ts: NOW,
    handoff_id: `handoff-${taskType}-${agent}`,
    conversation_id: "conv",
    project_id: "proj",
    agent_name: agent,
    task_type: taskType,
    outcome: "merged",
    rounds: 1,
    smoke_pass: "y",
    reviewer_findings: 0,
    maestro_score: null,
    cost_usd: null,
    tokens_used: 100,
    latency_ms: 1_000,
    exec_ms: 1_000,
    source: "test",
    notes: null,
    metadata_json: "{}",
  });
}

function agentchatConfig(): AgentchatConfig {
  return {
    role_routing: { headroom_weighting: false, latency_weighting: false },
    agents: [
      {
        name: "http-seat",
        roles: ["executor"],
        pricing_mode: "subscription",
        subscription_provider: "openai",
        adapter: "openai-compat-http",
      },
      {
        name: "tool-seat",
        roles: ["executor"],
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
        adapter: "stdio-acp",
      },
    ],
  };
}

describe("requires-tools hard constraint", () => {
  test("role route without tool_free hard-excludes a top-ranked text-only HTTP seat", () => {
    const db = freshDb();
    writePerf(db, "http-seat");
    writePerf(db, "tool-seat");

    const out = runRoute({
      db,
      detail: "single",
      role: "executor",
      message: "implement this",
      taskType: "implement_small",
      agentRegistry: ["http-seat", "tool-seat"],
      agentchatConfig: agentchatConfig(),
      roleExplorationPolicy: "ranked-first",
      now: new Date(NOW),
    });

    expect(out.detail).toBe("single");
    if (!out.route) throw new Error("expected a route");
    expect(out.route.agent).toBe("tool-seat");
  });

  test("tool_free:true keeps the same text-only HTTP seat eligible", () => {
    const db = freshDb();
    writePerf(db, "http-seat");
    writePerf(db, "tool-seat");

    const out = runRoute({
      db,
      detail: "single",
      role: "executor",
      message: "summarize this",
      taskType: "summarization",
      agentRegistry: ["http-seat", "tool-seat"],
      agentchatConfig: agentchatConfig(),
      roleExplorationPolicy: "ranked-first",
      tool_free: true,
      now: new Date(NOW),
    });

    expect(out.detail).toBe("single");
    if (!out.route) throw new Error("expected a route");
    expect(out.route.agent).toBe("http-seat");
  });

  test("auto role exploration leaves a text-only seat available to the outer constraint filter", () => {
    const db = freshDb();
    writePerf(db, "http-seat");

    const out = runRoute({
      db,
      detail: "single",
      role: "executor",
      taskType: "implement_small",
      agentRegistry: ["http-seat"],
      agentchatConfig: agentchatConfig(),
      roleExplorationPolicy: "ranked-first",
      allowRoleExploration: true,
      now: new Date(NOW),
    });

    expect(out.detail).toBe("single");
    if (!out.route) throw new Error("expected a route");
    expect(out.route.agent).toBe("http-seat");
  });

  test("legacy role routing never selects a text-only seat", () => {
    const db = freshDb();
    writePerf(db, "http-seat");

    const out = runRoute({
      db,
      detail: "single",
      role: "executor",
      taskType: "implement_small",
      agentRegistry: ["http-seat"],
      agentchatConfig: agentchatConfig(),
      roleExplorationPolicy: "ranked-first",
      now: new Date(NOW),
    });

    expect(out.detail).toBe("single");
    expect(out.route).toBeNull();
  });

  test("pickFromPool reports the task and original pool when requires_tools removes every seat", () => {
    const db = freshDb();

    expect(() =>
      pickFromPool(["http-seat"], db, agentchatConfig(), undefined, "implement_small"),
    ).toThrow(/requires_tools constraint.*taskType=implement_small.*pool=http-seat/);
  });

  test("pickFromPool skips a text-only HTTP first member for non-tool-free work", () => {
    const db = freshDb();

    expect(
      pickFromPool(["http-seat", "tool-seat"], db, agentchatConfig(), undefined, "implement_small"),
    ).toBe("tool-seat");
  });

  test("pickFromPool keeps a text-only HTTP first member when tool_free is true", () => {
    const db = freshDb();

    expect(
      pickFromPool(
        ["http-seat", "tool-seat"],
        db,
        agentchatConfig(),
        undefined,
        "summarization",
        true,
      ),
    ).toBe("http-seat");
  });

  test("selectRetryAgent skips text-only HTTP candidates for non-tool-free retries", () => {
    const candidates: RetryAgentCandidate[] = [
      { agent_name: "http-seat", score: 1 },
      { agent_name: "tool-seat", score: 0.5 },
    ];
    const { validAgents, agentProviders, agentAdapters } = buildRetryRoutingMaps([
      {
        name: "http-seat",
        pricing_mode: "subscription",
        subscription_provider: "openai",
        adapter: "openai-compat-http",
      },
      {
        name: "tool-seat",
        pricing_mode: "subscription",
        subscription_provider: "anthropic",
        adapter: "stdio-acp",
      },
    ]);
    const activeBiases: RoutingBias[] = [];

    expect(
      selectRetryAgent({
        candidates,
        failedAgent: "failed-seat",
        validAgents,
        agentProviders,
        agentAdapters,
        activeBiases,
      }),
    ).toBe("tool-seat");
  });
});

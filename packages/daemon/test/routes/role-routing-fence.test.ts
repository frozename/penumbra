import { type TaskRouterConfig, TaskRouterConfigSchema } from "@penumbra/config";
import {
  type AaSnapshotStore,
  AgentPerformanceWriter,
  type AgentRoutingConfig,
  loadSqliteVec,
  migrate,
  RoutingDecisionSchema,
  type Services,
} from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { resolveSingleRoute, type RouterDecisionSink } from "@src/routes/role-routing.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    /* already loaded */
  }
}

const NOW = "2026-08-27T12:00:00.000Z";

function freshDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function writePerf(db: Database, agent: string, taskType = "implement_small"): void {
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

function missingAaSnapshotStore(): AaSnapshotStore {
  return {
    read: () => ({ state: "missing", stale: false, ageSeconds: null, source: "missing" }),
    readSync: () => ({ state: "missing", stale: false, ageSeconds: null, source: "missing" }),
    write: () => ({ state: "missing", stale: false, ageSeconds: null, source: "missing" }),
    refresh: () => ({ state: "missing", stale: false, ageSeconds: null, source: "missing" }),
  };
}

function routerConfig(mode: TaskRouterConfig["mode"]): TaskRouterConfig {
  return TaskRouterConfigSchema.parse({ mode });
}

function services(db: Database, agentRouting: AgentRoutingConfig): Services {
  return {
    db,
    agentRouting,
    agentRegistry: agentRouting.agents.map((agent) => agent.name),
    clock: () => new Date(NOW),
    log: { warn: () => undefined } as Services["log"],
    aaSnapshotStore: missingAaSnapshotStore(),
    taskRouterConfig: routerConfig("auto"),
    modelAliasMap: {},
  } as Services;
}

describe("role routing hard fences", () => {
  test.each(["auto", "shadow", "recommend"] as const)(
    "mode:%s hard-excludes roles:[] seats before ranking and records the excluded alternative",
    (mode) => {
      const db = freshDb();
      writePerf(db, "fenced");
      writePerf(db, "executor-seat");
      const svc = services(db, {
        agents: [
          {
            name: "fenced",
            roles: [],
            pricing_mode: "subscription",
            subscription_provider: "openai",
            adapter: "stdio-acp",
          },
          {
            name: "executor-seat",
            roles: ["executor"],
            pricing_mode: "subscription",
            subscription_provider: "anthropic",
            adapter: "stdio-acp",
          },
        ],
        default_roles: {},
        role_exploration_policy: "ranked-first",
      });
      svc.taskRouterConfig = routerConfig(mode);

      const sink: RouterDecisionSink = { decision: null };
      const route = resolveSingleRoute(svc, "executor", "implement this", "implement_small", {
        decisionSink: sink,
      });

      expect(route?.agent).toBe("executor-seat");
      const decision = RoutingDecisionSchema.parse(sink.decision);
      expect(decision.alternatives).toContainEqual(
        expect.objectContaining({
          routeId: "openai:fenced",
          excluded: true,
          reasons: ["role_routing_roles_empty"],
        }) as unknown,
      );
      expect(decision.alternatives).not.toContainEqual(
        expect.objectContaining({
          routeId: "openai:fenced",
          excluded: false,
        }),
      );
      expect(decision.fallbackChain).not.toContain("fenced");
    },
  );

  test("legacy role routing requires strict role holders while auto routing explores non-empty seats", () => {
    const db = freshDb();
    writePerf(db, "fenced");
    writePerf(db, "planner-seat");
    const svc = services(db, {
      agents: [
        {
          name: "fenced",
          roles: [],
          pricing_mode: "subscription",
          subscription_provider: "openai",
          adapter: "stdio-acp",
        },
        {
          name: "planner-seat",
          roles: ["planner"],
          pricing_mode: "subscription",
          subscription_provider: "anthropic",
          adapter: "stdio-acp",
        },
      ],
      default_roles: {},
      role_exploration_policy: "unsampled-first",
    });
    svc.taskRouterConfig = undefined;

    expect(resolveSingleRoute(svc, "executor", "implement this", "implement_small")).toBeNull();

    svc.taskRouterConfig = routerConfig("auto");
    expect(resolveSingleRoute(svc, "executor", "implement this", "implement_small", {})).toEqual({
      agent: "planner-seat",
      role: "executor",
      taskType: "implement_small",
    });
  });

  test("tool-needing role routing hard-excludes text-only HTTP seats by default and records the excluded alternative", () => {
    const db = freshDb();
    writePerf(db, "http-seat");
    writePerf(db, "tool-seat");
    const svc = services(db, {
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
      default_roles: {},
      role_exploration_policy: "ranked-first",
    });

    const sink: RouterDecisionSink = { decision: null };
    const route = resolveSingleRoute(svc, "executor", "implement this", "implement_small", {
      decisionSink: sink,
    });

    expect(route?.agent).toBe("tool-seat");
    const decision = RoutingDecisionSchema.parse(sink.decision);
    expect(decision.alternatives).toContainEqual(
      expect.objectContaining({
        routeId: "openai:http-seat",
        excluded: true,
        reasons: ["requires_tools_text_only_adapter"],
      }) as unknown,
    );
    expect(decision.fallbackChain).not.toContain("http-seat");
  });

  test("tool_free:true keeps a text-only HTTP seat eligible in the auto-router path", () => {
    const db = freshDb();
    writePerf(db, "http-seat", "summarization");
    writePerf(db, "tool-seat", "summarization");
    const svc = services(db, {
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
      default_roles: {},
      role_exploration_policy: "ranked-first",
    });

    const sink: RouterDecisionSink = { decision: null };
    const route = resolveSingleRoute(svc, "executor", "summarize this", "summarization", {
      tool_free: true,
      decisionSink: sink,
    });

    expect(route?.agent).toBe("http-seat");
    const decision = RoutingDecisionSchema.parse(sink.decision);
    expect(decision.selected?.agent).toBe("http-seat");
    expect(decision.alternatives).not.toContainEqual(
      expect.objectContaining({
        routeId: "openai:http-seat",
        excluded: true,
      }),
    );
  });
});

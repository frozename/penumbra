import { loadSqliteVec, migrate } from "@penumbra/core";
import { computeRouteForRole } from "@src/routes/agents.js";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

interface RouteRejection {
  agent: string;
  reason: string;
}

describe("computeRouteForRole", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    const makeRows = (
      agentName: string,
      tsBase: string,
      samples: number,
      successes: number,
    ): void => {
      for (let n = 0; n < samples; n += 1) {
        db.prepare(
          `
          INSERT INTO agent_performance (
            performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type, outcome,
            rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used, latency_ms, source,
            notes, agent_kind, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
          `${agentName}-${String(n)}`,
          tsBase,
          `${agentName}-handoff-${String(n)}`,
          null,
          null,
          agentName,
          "review_adversarial",
          n < successes ? "merged" : "failed",
          1,
          "y",
          0,
          5,
          0.4,
          10,
          1000,
          "worker",
          null,
          "coding",
          "{}",
        );
      }
    };

    // Anchor fixtures to fixed ISO timestamps so the route window is
    // deterministic regardless of the wall clock.
    // The calls below use a wider window because these fixed pre-cutover rows
    // cannot also stay "recent" forever as the wall clock advances.
    const tsBase = "2026-06-05T00:00:00.000Z";
    const preCutover = (hourOffset: number): string =>
      new Date(Date.parse(tsBase) + hourOffset * 3600000).toISOString();
    makeRows("high-perf", preCutover(1), 10, 9);
    makeRows("mid", preCutover(2), 5, 3);
    makeRows("low", preCutover(3), 8, 3);
    makeRows("tiny", preCutover(4), 2, 2);
    makeRows("outsider", preCutover(5), 12, 8);
  });

  test("routes to the best eligible agent and explains rejections", () => {
    const out = computeRouteForRole({
      db,
      role: "reviewer",
      windowDays: 365,
      minSamples: 3,
      agentKind: "coding",
      pressureSnapshot: {
        snapshots: [
          {
            provider: "anthropic",
            window_label: "24h",
            model: null,
            used_pct: 95,
            resets_at: null,
            observed_at: new Date(Date.now() - 1000).toISOString(),
            source_kind: "subscription",
          },
        ],
        warnings: [],
      },
      agentchatRoles: {
        agents: [
          {
            name: "high-perf",
            roles: ["reviewer"],
            pricing_mode: "subscription",
            subscription_provider: "anthropic",
          },
          { name: "mid", roles: ["reviewer"], api_provider: "openai" },
          { name: "low", roles: ["reviewer"], api_provider: "openai" },
          { name: "tiny", roles: ["reviewer"], api_provider: "openai" },
          { name: "outsider", roles: ["planner"], api_provider: "openai" },
        ],
      },
    });

    expect(out.chosen).toEqual({
      agent: "mid",
      success_rate: 0.6,
      samples: 5,
      roles: ["reviewer"],
    });
    const rejected = out.rejected as RouteRejection[];
    const byAgent = new Map(rejected.map((r) => [r.agent, r.reason]));
    expect(byAgent.get("high-perf")).toBe("under_pressure");
    expect(byAgent.get("tiny")).toBe("below_min_samples");
    expect(byAgent.get("low")).toBe("lower_success_rate");
    expect(byAgent.get("outsider")).toBe("no_role_match");

    const noMatch = computeRouteForRole({
      db,
      role: "does_not_exist",
      windowDays: 365,
      minSamples: 3,
      agentKind: "coding",
      pressureSnapshot: { snapshots: [], warnings: [] },
      agentchatRoles: { agents: [] },
    });

    expect(noMatch.chosen).toBeNull();
    expect(noMatch.reason).toContain("no eligible agent");
  });

  test("routes to the best eligible agent for planner role", () => {
    const makePlannerRows = (
      agentName: string,
      tsBase: string,
      samples: number,
      successes: number,
    ): void => {
      for (let n = 0; n < samples; n += 1) {
        db.prepare(
          `INSERT INTO agent_performance (
            performance_id, ts, handoff_id, agent_name, task_type, outcome,
            rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used, latency_ms, source, agent_kind, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `${agentName}-plan-${String(n)}`,
          tsBase,
          `${agentName}-handoff-${String(n)}`,
          agentName,
          "plan_refine",
          n < successes ? "merged" : "failed",
          1,
          "y",
          0,
          5,
          0.4,
          10,
          1000,
          "worker",
          "coding",
          "{}",
        );
      }
    };
    // Fixed timestamp; the test uses a wide route window so the row stays visible
    // regardless of the wall clock.
    makePlannerRows("best-planner", "2026-06-05T02:00:00.000Z", 10, 8);

    const out = computeRouteForRole({
      db,
      role: "planner",
      windowDays: 365,
      minSamples: 3,
      agentKind: "coding",
      pressureSnapshot: { snapshots: [], warnings: [] },
      agentchatRoles: {
        agents: [{ name: "best-planner", roles: ["planner"], api_provider: "openai" }],
      },
    });

    expect(out.chosen).toEqual({
      agent: "best-planner",
      success_rate: 0.8,
      samples: 10,
      roles: ["planner"],
    });
  });

  test("honors unsampled-first exploration policy when no agent meets min_samples (cold start)", () => {
    const out = computeRouteForRole({
      db,
      role: "reviewer",
      windowDays: 365,
      minSamples: 3,
      agentKind: "coding",
      pressureSnapshot: { snapshots: [], warnings: [] },
      roleExplorationPolicy: "unsampled-first",
      agentchatRoles: {
        agents: [
          { name: "local-a", roles: ["reviewer"], api_provider: "llamactl" },
          { name: "local-b", roles: ["reviewer"], api_provider: "llamactl" },
        ],
      },
    });

    expect(out.chosen).not.toBeNull();
    expect(["local-a", "local-b"]).toContain(out.chosen?.agent);
    expect(out.chosen?.samples).toBe(0);

    const rankedFirst = computeRouteForRole({
      db,
      role: "reviewer",
      windowDays: 365,
      minSamples: 3,
      agentKind: "coding",
      pressureSnapshot: { snapshots: [], warnings: [] },
      roleExplorationPolicy: "ranked-first",
      agentchatRoles: {
        agents: [
          { name: "local-a", roles: ["reviewer"], api_provider: "llamactl" },
          { name: "local-b", roles: ["reviewer"], api_provider: "llamactl" },
        ],
      },
    });

    expect(rankedFirst.chosen).toBeNull();
  });
});

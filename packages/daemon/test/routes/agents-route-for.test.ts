import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, migrate } from "@penumbra/core";
import { computeRouteForRole } from "../../src/routes/agents.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

describe("computeRouteForRole", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    const makeRows = (agentName: string, tsBase: string, samples: number, successes: number) => {
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
          `${agentName}-${n}`,
          tsBase,
          `${agentName}-handoff-${n}`,
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

    // Anchor fixtures to FIXED ISO timestamps strictly before the gate-outcome
    // cutover (DEFAULT_GATE_OUTCOME_CUTOVER_ISO = 2026-06-12T00:00:00Z). These
    // rows carry no gate_outcome (NULL), so they only count as success-eligible
    // via the legacy `ts < cutover AND gate_outcome IS NULL` predicate. Using
    // Date.now()-N*day made the recent rows land *after* the cutover once the
    // wall clock passed 2026-06-12, dropping success_rate to 0 and breaking the
    // assertions. Fixed pre-cutover timestamps deterministically exercise the
    // NULL-verdict path.
    // SEAM: these must also fall inside the routing window (now - windowDays).
    // With windowDays:14 the floor is `now - 14d`; 2026-06-05 stays inside the
    // window while the suite runs on/before ~2026-06-19. If the wall clock
    // advances past that, bump this base forward (still keeping it < cutover) or
    // raise windowDays in the calls below.
    const tsBase = "2026-06-05T00:00:00.000Z";
    const preCutover = (hourOffset: number) =>
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
      windowDays: 14,
      minSamples: 3,
      agentKind: "coding",
      pressureSnapshot: {
        snapshots: [
          {
            provider: "anthropic",
            window_label: "24h",
            model: null,
            used_pct: 0.95,
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
    expect(out.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent: "high-perf", reason: "under_pressure" }),
        expect.objectContaining({ agent: "tiny", reason: "below_min_samples" }),
        expect.objectContaining({ agent: "low", reason: "lower_success_rate" }),
        expect.objectContaining({ agent: "outsider", reason: "no_role_match" }),
      ]),
    );

    const noMatch = computeRouteForRole({
      db,
      role: "does_not_exist",
      windowDays: 14,
      minSamples: 3,
      agentKind: "coding",
      pressureSnapshot: { snapshots: [], warnings: [] },
      agentchatRoles: { agents: [] },
    });

    expect(noMatch.chosen).toBeNull();
    expect(noMatch.reason).toContain("no eligible agent");
  });

  test("routes to the best eligible agent for planner role", () => {
    // Add plan_refine performance rows
    const makePlannerRows = (agentName, tsBase, samples, successes) => {
      for (let n = 0; n < samples; n += 1) {
        db.prepare(
          `INSERT INTO agent_performance (
            performance_id, ts, handoff_id, agent_name, task_type, outcome,
            rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, tokens_used, latency_ms, source, agent_kind, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `${agentName}-plan-${n}`,
          tsBase,
          `${agentName}-handoff-${n}`,
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
    // Fixed pre-cutover timestamp (see beforeEach note): keeps the NULL-verdict
    // rows on the legacy success-eligible side of DEFAULT_GATE_OUTCOME_CUTOVER_ISO.
    makePlannerRows("best-planner", "2026-06-05T02:00:00.000Z", 10, 8);

    const out = computeRouteForRole({
      db,
      role: "planner",
      windowDays: 14,
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
      windowDays: 14,
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
      windowDays: 14,
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

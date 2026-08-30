import type { ModelAliasMap, TaskRouterConfig } from "@penumbra/config";

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { replay, type ReplayConfig } from "@src/routing/replay.js";
import type { AaModel, AaModelSnapshot } from "@src/routing/schemas.js";
import type { TaskProfileJudge } from "@src/routing/task-profile-judge.js";
import { AgentPerformanceWriter } from "@src/writers/agent-performance.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

const NOW = new Date("2026-08-25T12:00:00.000Z");
const ROLE = "executor";
const SINCE = "2026-08-01T00:00:00.000Z";
const UNTIL = "2026-08-31T00:00:00.000Z";
const CODING_MESSAGE = "Implement a complex repository change across the whole codebase";

function aaModel(creator: string, slug: string, overrides: Partial<AaModel> = {}): AaModel {
  return {
    id: `${creator}-${slug}`,
    name: slug,
    slug,
    model_creator: { id: `${creator}-id`, name: creator, slug: creator },
    evaluations: {},
    pricing: {},
    ...overrides,
  };
}

function snapshot(models: AaModel[]): AaModelSnapshot {
  return { collectedAt: "2026-08-25T11:00:00.000Z", dataVersion: "test", models };
}

function qualityVsFastSnapshot(): AaModelSnapshot {
  return snapshot([
    aaModel("openai", "quality-model", {
      evaluations: {
        artificial_analysis_intelligence_index: 95,
        artificial_analysis_coding_index: 98,
        terminalbench_hard: 0.95,
        terminalbench_v2_1: 0.96,
        tau2: 0.94,
      },
      pricing: { price_1m_input_tokens: 12, price_1m_output_tokens: 36 },
      median_output_tokens_per_second: 45,
      median_time_to_first_token_seconds: 12,
    }),
    aaModel("google", "fast-model", {
      evaluations: {
        artificial_analysis_intelligence_index: 45,
        artificial_analysis_coding_index: 42,
        terminalbench_hard: 0.35,
        terminalbench_v2_1: 0.38,
        tau2: 0.4,
      },
      pricing: { price_1m_input_tokens: 0.2, price_1m_output_tokens: 0.8 },
      median_output_tokens_per_second: 240,
      median_time_to_first_token_seconds: 0.2,
    }),
  ]);
}

const ALIASES: ModelAliasMap = {
  "quality-seat": { aa_creator: "openai", aa_slug: "quality-model", reasoning_level: "high" },
  "fast-seat": { aa_creator: "google", aa_slug: "fast-model" },
};

const AGENTCHAT_CONFIG = {
  role_routing: { headroom_weighting: true, latency_weighting: false },
  agents: [
    {
      name: "quality-seat",
      roles: [ROLE],
      pricing_mode: "subscription" as const,
      subscription_provider: "openai",
    },
    { name: "fast-seat", roles: [ROLE], pricing_mode: "api" as const, api_provider: "google" },
  ],
};

function zeroWeights(): TaskRouterConfig["weights"] {
  return {
    quality: 0,
    speed: 0,
    latency: 0,
    cost: 0,
    reliability: 0,
    affinity: 0,
    history: 0,
    quota: 0,
    uncertainty: 0,
    staleness: 0,
  };
}

const ROUTER_CONFIG: TaskRouterConfig = {
  mode: "auto",
  weights: {
    quality: 1,
    speed: 0.35,
    latency: 0.3,
    cost: 0.25,
    reliability: 0.75,
    affinity: 0.5,
    history: 0.6,
    quota: 0.2,
    uncertainty: 0.4,
    staleness: 0.1,
  },
  thresholds: {
    quality_floor: 0.5,
    context_safety_margin_tokens: 4096,
    max_fallbacks: 2,
    judge_confidence_floor: 0.6,
  },
  snapshot_ttl_seconds: 86_400,
};

function seed(
  db: Database,
  agent: string,
  handoffId: string,
  overrides: { cost_usd?: number; latency_ms?: number } = {},
): void {
  new AgentPerformanceWriter(db).upsert({
    performance_id: `${handoffId}-performance`,
    ts: "2026-08-05T10:00:00.000Z",
    handoff_id: handoffId,
    conversation_id: `${handoffId}-conversation`,
    project_id: "project",
    agent_name: agent,
    task_type: "implement_substantial",
    outcome: "merged",
    rounds: 1,
    smoke_pass: "y",
    reviewer_findings: 0,
    maestro_score: 5,
    cost_usd: overrides.cost_usd ?? 0.01,
    tokens_used: 1_000,
    latency_ms: overrides.latency_ms ?? 1_000,
    source: "manual_seed",
    notes: null,
    metadata_json: "{}",
  });
}

function countRoutingRows(db: Database): number {
  return db
    .query<
      { n: number },
      []
    >("SELECT (SELECT COUNT(*) FROM handoffs) + (SELECT COUNT(*) FROM agent_performance) + (SELECT COUNT(*) FROM routing_decisions) AS n")
    .get()!.n;
}

function insertHandoff(
  db: Database,
  opts: {
    handoffId: string;
    ts: string;
    toAgent: string;
    toRole?: string | null;
    message: string;
    projectId?: string | null;
    dispatchKind?: string | null;
  },
): void {
  db.prepare(
    `
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role,
        message, status, dispatch_kind
      ) VALUES (?, ?, ?, ?, 'maestro', ?, ?, ?, 'resolved', ?)
    `,
  ).run(
    opts.handoffId,
    opts.ts,
    opts.projectId ?? null,
    `${opts.handoffId}-conversation`,
    opts.toAgent,
    opts.toRole ?? null,
    opts.message,
    opts.dispatchKind ?? null,
  );
}

describe("router replay", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  afterEach(() => {
    db.close();
  });

  test("replay never calls a model: an armed judge stub is never invoked, and the report is still produced", () => {
    seed(db, "quality-seat", "quality-seat-handoff");
    insertHandoff(db, {
      handoffId: "quality-seat-handoff",
      ts: "2026-08-05T10:00:00.000Z",
      toAgent: "quality-seat",
      toRole: ROLE,
      message: CODING_MESSAGE,
    });

    let judgeCalls = 0;
    const judge: TaskProfileJudge = {
      profileTask: () => {
        judgeCalls++;
        return Promise.reject(new Error("model call attempted"));
      },
    };

    const config: ReplayConfig = {
      mode: "off",
      routerConfig: ROUTER_CONFIG,
      aliasMap: {},
      agentchatConfig: { role_routing: {}, agents: [] },
      agentRegistry: [],
    };

    const report = replay(
      db,
      config,
      { since: SINCE, until: UNTIL },
      { routerDeps: { now: () => NOW }, judge },
    );

    expect(report).toBeDefined();
    expect(report.profiledHandoffs).toBe(1);
    expect(judgeCalls).toBe(0);
  });

  test("replay skips malformed harness context rows instead of aborting the run", () => {
    seed(db, "quality-seat", "quality-seat-handoff");
    seed(db, "fast-seat", "fast-seat-handoff");
    insertHandoff(db, {
      handoffId: "quality-seat-handoff",
      ts: "2026-08-05T10:00:00.000Z",
      toAgent: "quality-seat",
      toRole: ROLE,
      message: CODING_MESSAGE,
    });
    insertHandoff(db, {
      handoffId: "fast-seat-handoff",
      ts: "2026-08-06T10:00:00.000Z",
      toAgent: "fast-seat",
      toRole: ROLE,
      message: CODING_MESSAGE,
      dispatchKind: Buffer.from("bad") as unknown as string,
    });

    const report = replay(
      db,
      {
        mode: "auto",
        routerConfig: ROUTER_CONFIG,
        aliasMap: ALIASES,
        agentchatConfig: AGENTCHAT_CONFIG,
        agentRegistry: ["quality-seat", "fast-seat"],
        aaSnapshot: { snapshot: qualityVsFastSnapshot(), stale: false, ageSeconds: 3_600 },
      },
      { since: SINCE, until: UNTIL },
      { routerDeps: { now: () => NOW } },
    );

    expect(report.totalHandoffs).toBe(2);
    expect(report.profiledHandoffs).toBe(1);
    expect(report.skippedNoPerformanceRow).toBe(0);
    expect(report.skippedInvalidContext).toBe(1);
    expect(report.totalHandoffs).toBe(
      report.profiledHandoffs + report.skippedNoPerformanceRow + report.skippedInvalidContext,
    );
    expect(report.rows.map((row) => row.handoffId)).toEqual(["quality-seat-handoff"]);
    expect(report.agreedCount).toBe(1);
    expect(report.disagreedCount).toBe(0);
    expect(report.agreedCount + report.disagreedCount).toBe(report.profiledHandoffs);
    expect(report.agreementRate).toBe(1);
  });

  test("replay performs no writes and repeated runs stay identical", () => {
    seed(db, "quality-seat", "quality-seat-handoff");
    insertHandoff(db, {
      handoffId: "quality-seat-handoff",
      ts: "2026-08-05T10:00:00.000Z",
      toAgent: "quality-seat",
      toRole: ROLE,
      message: CODING_MESSAGE,
    });

    const config: ReplayConfig = {
      mode: "auto",
      routerConfig: ROUTER_CONFIG,
      aliasMap: ALIASES,
      agentchatConfig: AGENTCHAT_CONFIG,
      agentRegistry: ["quality-seat", "fast-seat"],
      aaSnapshot: { snapshot: qualityVsFastSnapshot(), stale: false, ageSeconds: 3_600 },
    };

    const countBefore = countRoutingRows(db);
    const first = replay(
      db,
      config,
      { since: SINCE, until: UNTIL },
      { routerDeps: { now: () => NOW } },
    );
    const second = replay(
      db,
      config,
      { since: SINCE, until: UNTIL },
      { routerDeps: { now: () => NOW } },
    );
    const countAfter = countRoutingRows(db);

    expect(countAfter).toBe(countBefore);
    expect(second).toEqual(first);
  });

  describe("agreement rate", () => {
    let config: ReplayConfig;

    beforeEach(() => {
      seed(db, "quality-seat", "quality-seat-handoff");
      seed(db, "fast-seat", "fast-seat-handoff");
      config = {
        mode: "auto",
        routerConfig: ROUTER_CONFIG,
        aliasMap: ALIASES,
        agentchatConfig: AGENTCHAT_CONFIG,
        agentRegistry: ["quality-seat", "fast-seat"],
        aaSnapshot: { snapshot: qualityVsFastSnapshot(), stale: false, ageSeconds: 3_600 },
      };
    });

    test("a historical handoff whose routed agent matches decide().selected counts as agreed", () => {
      insertHandoff(db, {
        handoffId: "quality-seat-handoff",
        ts: "2026-08-05T10:00:00.000Z",
        toAgent: "quality-seat",
        toRole: ROLE,
        message: CODING_MESSAGE,
      });

      const report = replay(
        db,
        config,
        { since: SINCE, until: UNTIL },
        { routerDeps: { now: () => NOW } },
      );

      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]?.replayedAgent).toBe("quality-seat");
      expect(report.rows[0]?.agreed).toBe(true);
      expect(report.agreedCount).toBe(1);
      expect(report.disagreedCount).toBe(0);
      expect(report.agreementRate).toBe(1);
    });

    test("a historical handoff whose routed agent differs from decide().selected counts as disagreed", () => {
      insertHandoff(db, {
        handoffId: "fast-seat-handoff",
        ts: "2026-08-05T10:00:00.000Z",
        toAgent: "fast-seat",
        toRole: ROLE,
        message: CODING_MESSAGE,
      });

      const report = replay(
        db,
        config,
        { since: SINCE, until: UNTIL },
        { routerDeps: { now: () => NOW } },
      );

      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]?.replayedAgent).toBe("quality-seat");
      expect(report.rows[0]?.historicalAgent).toBe("fast-seat");
      expect(report.rows[0]?.agreed).toBe(false);
      expect(report.agreedCount).toBe(0);
      expect(report.disagreedCount).toBe(1);
      expect(report.agreementRate).toBe(0);
    });

    test("table-driven: agree and disagree rows both count correctly in the same run", () => {
      insertHandoff(db, {
        handoffId: "quality-seat-handoff",
        ts: "2026-08-05T10:00:00.000Z",
        toAgent: "quality-seat",
        toRole: ROLE,
        message: CODING_MESSAGE,
      });
      insertHandoff(db, {
        handoffId: "fast-seat-handoff",
        ts: "2026-08-06T10:00:00.000Z",
        toAgent: "fast-seat",
        toRole: ROLE,
        message: CODING_MESSAGE,
      });

      const report = replay(
        db,
        config,
        { since: SINCE, until: UNTIL },
        { routerDeps: { now: () => NOW } },
      );

      expect(report.agreedCount).toBe(1);
      expect(report.disagreedCount).toBe(1);
      expect(report.agreementRate).toBe(0.5);
    });

    test("a historical handoff with no matching agent_performance row is skipped, not counted as a disagreement", () => {
      insertHandoff(db, {
        handoffId: "quality-seat-handoff",
        ts: "2026-08-05T10:00:00.000Z",
        toAgent: "quality-seat",
        toRole: ROLE,
        message: CODING_MESSAGE,
      });
      insertHandoff(db, {
        handoffId: "orphan-handoff",
        ts: "2026-08-07T10:00:00.000Z",
        toAgent: "fast-seat",
        toRole: ROLE,
        message: CODING_MESSAGE,
      });

      const report = replay(
        db,
        config,
        { since: SINCE, until: UNTIL },
        { routerDeps: { now: () => NOW } },
      );

      expect(report.totalHandoffs).toBe(2);
      expect(report.profiledHandoffs).toBe(1);
      expect(report.skippedNoPerformanceRow).toBe(1);
      expect(report.rows.map((row) => row.handoffId)).toEqual(["quality-seat-handoff"]);
      expect(report.agreedCount).toBe(1);
      expect(report.disagreedCount).toBe(0);
    });

    test("a null replayed agent counts as disagreed against the profiled denominator", () => {
      const emptyRegistryConfig: ReplayConfig = {
        mode: "auto",
        routerConfig: ROUTER_CONFIG,
        aliasMap: {},
        agentchatConfig: { role_routing: {}, agents: [] },
        agentRegistry: [],
      };
      insertHandoff(db, {
        handoffId: "quality-seat-handoff",
        ts: "2026-08-05T10:00:00.000Z",
        toAgent: "quality-seat",
        toRole: ROLE,
        message: CODING_MESSAGE,
      });

      const report = replay(
        db,
        emptyRegistryConfig,
        { since: SINCE, until: UNTIL },
        { routerDeps: { now: () => NOW } },
      );

      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]?.replayedAgent).toBeNull();
      expect(report.rows[0]?.agreed).toBe(false);
      expect(report.agreedCount).toBe(0);
      expect(report.disagreedCount).toBe(1);
      expect(report.agreementRate).toBe(0);
    });
  });

  test("the report surfaces most-selected and most-excluded routes with reasons, and low-confidence decisions", () => {
    seed(db, "quality-seat", "quality-seat-handoff");
    seed(db, "fast-seat", "fast-seat-handoff");
    insertHandoff(db, {
      handoffId: "quality-seat-handoff",
      ts: "2026-08-05T10:00:00.000Z",
      toAgent: "quality-seat",
      toRole: ROLE,
      message: CODING_MESSAGE,
    });
    insertHandoff(db, {
      handoffId: "low-confidence-handoff",
      ts: "2026-08-06T10:00:00.000Z",
      toAgent: "quality-seat",
      toRole: null,
      message: "zzz yyy xxx qqq",
    });
    new AgentPerformanceWriter(db).upsert({
      performance_id: "low-confidence-performance",
      ts: "2026-08-06T10:00:00.000Z",
      handoff_id: "low-confidence-handoff",
      conversation_id: "low-confidence-conversation",
      project_id: "project",
      agent_name: "quality-seat",
      task_type: "unknown",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: 0.01,
      tokens_used: 1_000,
      latency_ms: 1_000,
      source: "manual_seed",
      notes: null,
      metadata_json: "{}",
    });

    const registry = ["quality-seat", "fast-seat", "expensive-seat"];
    const aliasMap: ModelAliasMap = {
      ...ALIASES,
      "expensive-seat": { aa_creator: "openai", aa_slug: "expensive-model" },
    };
    const agentchatConfig = {
      ...AGENTCHAT_CONFIG,
      agents: [
        ...AGENTCHAT_CONFIG.agents,
        {
          name: "expensive-seat",
          roles: [ROLE],
          pricing_mode: "api" as const,
          api_provider: "openai",
        },
      ],
    };
    const snapshotWithExpensive = snapshot([
      ...qualityVsFastSnapshot().models,
      aaModel("openai", "expensive-model", {
        pricing: { price_1m_input_tokens: 5_000, price_1m_output_tokens: 5_000 },
      }),
    ]);
    const config: ReplayConfig = {
      mode: "auto",
      routerConfig: { ...ROUTER_CONFIG, max_predicted_cost_usd_per_dispatch: 1 },
      aliasMap,
      agentchatConfig,
      agentRegistry: registry,
      aaSnapshot: { snapshot: snapshotWithExpensive, stale: false, ageSeconds: 3_600 },
    };

    const report = replay(
      db,
      config,
      { since: SINCE, until: UNTIL },
      { routerDeps: { now: () => NOW } },
    );

    expect(report.mostSelectedRoutes.length).toBeGreaterThan(0);
    expect(report.mostSelectedRoutes[0]).toMatchObject({ routeId: "openai:quality-seat" });

    const excludedExpensive = report.mostExcludedRoutes.find(
      (route) => route.routeId === "openai:expensive-seat",
    );
    expect(excludedExpensive).toBeDefined();
    expect(excludedExpensive?.count).toBe(2);
    expect(excludedExpensive?.reasons).toContain("hard_budget");

    expect(report.lowConfidenceDecisions).toHaveLength(1);
    expect(report.lowConfidenceDecisions[0]?.handoffId).toBe("low-confidence-handoff");
    expect(report.lowConfidenceDecisions[0]?.confidence).toBeLessThan(0.5);
  });

  test("perturbing one weight by +-10% and re-running flags routes whose winner flips", () => {
    seed(db, "quality-seat", "quality-seat-handoff");
    seed(db, "fast-seat", "fast-seat-handoff");
    insertHandoff(db, {
      handoffId: "quality-seat-handoff",
      ts: "2026-08-05T10:00:00.000Z",
      toAgent: "quality-seat",
      toRole: ROLE,
      message: CODING_MESSAGE,
    });

    // Tuned via computePriors so quality-seat narrowly wins at cost=1.7 and
    // fast-seat wins once cost is nudged +10% to 1.87 -- see replay.test.ts
    // history for the derivation (a 2-candidate crossover of the quality vs
    // cost metric clusters).
    const sensitivityConfig: TaskRouterConfig = {
      ...ROUTER_CONFIG,
      weights: { ...zeroWeights(), quality: 0.2, cost: 1.7 },
    };
    const config: ReplayConfig = {
      mode: "auto",
      routerConfig: sensitivityConfig,
      aliasMap: ALIASES,
      agentchatConfig: AGENTCHAT_CONFIG,
      agentRegistry: ["quality-seat", "fast-seat"],
      aaSnapshot: { snapshot: qualityVsFastSnapshot(), stale: false, ageSeconds: 3_600 },
    };

    const report = replay(
      db,
      config,
      { since: SINCE, until: UNTIL, weightPerturbations: ["cost"] },
      { routerDeps: { now: () => NOW } },
    );

    expect(report.rows[0]?.replayedAgent).toBe("quality-seat");
    expect(report.weightSensitivity).toHaveLength(1);
    const finding = report.weightSensitivity[0]!;
    expect(finding.weight).toBe("cost");
    expect(finding.baselineAgent).toBe("quality-seat");
    expect(finding.plusTenPercentAgent).toBe("fast-seat");
    expect(finding.flipped).toBe(true);
  });
});

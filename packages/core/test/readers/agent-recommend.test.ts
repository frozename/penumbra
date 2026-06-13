import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, migrate } from "../../src/index.js";
import {
  buildSuccessPredicate,
  routeAgent,
  type AgentRecommendation,
} from "../../src/services/agent-routing.js";
import { AgentPerformanceWriter } from "../../src/writers/agent-performance.js";
import { AgentRecommendInputSchema } from "../../src/schemas/agent-recommend.js";

function getRecommendationsViaRoute(
  input: Parameters<typeof routeAgent>[0],
): AgentRecommendation[] {
  const out = routeAgent({ ...input, detail: "summary" });
  if (out.detail !== "summary")
    throw new Error(`routeAgent returned detail="${out.detail}", expected "summary"`);
  return out.recommendations;
}

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {}
}

const NOW = new Date("2026-05-01T12:00:00Z");

describe("agent recommendations", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const writer = new AgentPerformanceWriter(db);

    // alpha: implement_small — 2 successes @ 80000ms (success_rate=1.0, avg=80s)
    writer.upsert({
      performance_id: "a1",
      ts: "2026-04-29T10:00:00Z",
      handoff_id: "h-a1",
      conversation_id: "c-a1",
      project_id: "proj",
      agent_name: "alpha",
      task_type: "implement_small",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 80000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "a2",
      ts: "2026-04-30T10:00:00Z",
      handoff_id: "h-a2",
      conversation_id: "c-a2",
      project_id: "proj",
      agent_name: "alpha",
      task_type: "implement_small",
      outcome: "pr_opened",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 80000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    // beta: implement_small — 2 successes @ 60000ms (success_rate=1.0, avg=60s)
    writer.upsert({
      performance_id: "b1",
      ts: "2026-04-29T11:00:00Z",
      handoff_id: "h-b1",
      conversation_id: "c-b1",
      project_id: "proj",
      agent_name: "beta",
      task_type: "implement_small",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 60000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "b2",
      ts: "2026-04-30T11:00:00Z",
      handoff_id: "h-b2",
      conversation_id: "c-b2",
      project_id: "proj",
      agent_name: "beta",
      task_type: "implement_small",
      outcome: "merged_with_concerns",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 1,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 60000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    // gamma: implement_small — 2 failures @ 20000ms (success_rate=0.0, avg=20s)
    writer.upsert({
      performance_id: "g1",
      ts: "2026-04-29T12:00:00Z",
      handoff_id: "h-g1",
      conversation_id: "c-g1",
      project_id: "proj",
      agent_name: "gamma",
      task_type: "implement_small",
      outcome: "test_failed",
      rounds: 2,
      smoke_pass: "n",
      reviewer_findings: 3,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 20000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "g2",
      ts: "2026-04-30T12:00:00Z",
      handoff_id: "h-g2",
      conversation_id: "c-g2",
      project_id: "proj",
      agent_name: "gamma",
      task_type: "implement_small",
      outcome: "failed",
      rounds: 2,
      smoke_pass: "n",
      reviewer_findings: 4,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 20000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    // Cross-task rows: each agent gets one row in 'implement_substantial' to ensure filter excludes.
    writer.upsert({
      performance_id: "a-sub",
      ts: "2026-04-29T15:00:00Z",
      handoff_id: "h-a-sub",
      conversation_id: "c-a-sub",
      project_id: "proj",
      agent_name: "alpha",
      task_type: "implement_substantial",
      outcome: "failed",
      rounds: 3,
      smoke_pass: "n",
      reviewer_findings: 5,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 999999,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "b-sub",
      ts: "2026-04-29T15:30:00Z",
      handoff_id: "h-b-sub",
      conversation_id: "c-b-sub",
      project_id: "proj",
      agent_name: "beta",
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 999999,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "g-sub",
      ts: "2026-04-29T16:00:00Z",
      handoff_id: "h-g-sub",
      conversation_id: "c-g-sub",
      project_id: "proj",
      agent_name: "gamma",
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 999999,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
  });

  test("filters by task_type", () => {
    const out = getRecommendationsViaRoute({
      db,
      taskType: "implement_small",
      now: NOW,
    });

    expect(out.length).toBe(3);
    for (const row of out) {
      expect(row.task_type).toBe("implement_small");
      expect(row.samples).toBe(2);
    }
  });

  test("sorts by success_rate DESC, then avg_latency_seconds ASC", () => {
    const out = getRecommendationsViaRoute({
      db,
      taskType: "implement_small",
      now: NOW,
    });

    expect(out[0]!.agent_name).toBe("beta");
    expect(out[1]!.agent_name).toBe("alpha");
    expect(out[0]!.success_rate).toBe(1);
    expect(out[1]!.success_rate).toBe(1);
    expect(out[0]!.avg_latency_seconds!).toBeLessThan(out[1]!.avg_latency_seconds!);
  });

  test("window cutoff excludes rows older than windowDays", () => {
    // Insert a row 30 days before NOW for alpha — should not be counted under default 7-day window.
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "a-old",
      ts: "2026-04-01T10:00:00Z",
      handoff_id: "h-a-old",
      conversation_id: "c-a-old",
      project_id: "proj",
      agent_name: "alpha",
      task_type: "implement_small",
      outcome: "failed",
      rounds: 5,
      smoke_pass: "n",
      reviewer_findings: 9,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 500000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    const out = getRecommendationsViaRoute({
      db,
      taskType: "implement_small",
      now: NOW,
    });

    const alpha = out.find((r) => r.agent_name === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.samples).toBe(2);
    expect(alpha!.success_rate).toBe(1);
  });

  test("returned shape: latency_ms=60000 → avg_latency_seconds=60", () => {
    const out = getRecommendationsViaRoute({
      db,
      taskType: "implement_small",
      now: NOW,
    });

    const beta = out.find((r) => r.agent_name === "beta")!;
    expect(beta.agent_name).toBe("beta");
    expect(beta.task_type).toBe("implement_small");
    expect(beta.samples).toBe(2);
    expect(beta.success_rate).toBeGreaterThanOrEqual(0);
    expect(beta.success_rate).toBeLessThanOrEqual(1);
    expect(beta.avg_latency_seconds).toBe(60);
    expect(typeof beta.last_observed_at).toBe("string");
    expect(beta.last_observed_at).toBe("2026-04-30T11:00:00Z");
  });

  test("wrapper returns the same shape as direct reader input", () => {
    const parsed = AgentRecommendInputSchema.parse({
      task_type: "implement_small",
    });
    const out = getRecommendationsViaRoute({
      db,
      taskType: parsed.task_type,
      now: NOW,
    });

    expect(out[0]!.agent_name).toBe("beta");
    expect(out[0]!.task_type).toBe("implement_small");
    expect(out[0]!.samples).toBe(2);
  });

  test("gate outcome success predicate is cutoff-aware and exposes coverage", () => {
    const writer = new AgentPerformanceWriter(db);
    db.exec(`
      INSERT INTO lane_ledger (
        lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff, gate_status, metadata_json
      ) VALUES
        ('lane-legacy-null', '2026-06-11T09:00:00Z', NULL, 'STANDARD', 'h-legacy-null', NULL, 'open', '{}'),
        ('lane-post-null', '2026-06-12T09:00:00Z', NULL, 'STANDARD', 'h-post-null', NULL, 'open', '{}'),
        ('lane-post-skipped', '2026-06-12T09:00:00Z', '2026-06-12T09:05:00Z', 'TRIVIAL', 'h-post-skipped', NULL, 'skipped', '{}'),
        ('lane-post-failed', '2026-06-12T09:00:00Z', '2026-06-12T09:05:00Z', 'STANDARD', 'h-post-failed', 'h-reviewer', 'failed', '{}');
    `);
    for (const row of [
      {
        performance_id: "legacy-null",
        ts: "2026-06-11T10:00:00Z",
        handoff_id: "h-legacy-null",
        agent_name: "legacy-null",
        gate_outcome: null,
        latency_ms: 40000,
      },
      {
        performance_id: "post-null",
        ts: "2026-06-12T10:00:00Z",
        handoff_id: "h-post-null",
        agent_name: "post-null",
        gate_outcome: null,
        latency_ms: 30000,
      },
      {
        performance_id: "post-skipped",
        ts: "2026-06-12T10:00:00Z",
        handoff_id: "h-post-skipped",
        agent_name: "post-skipped",
        gate_outcome: "skipped",
        latency_ms: 20000,
      },
      {
        performance_id: "post-failed",
        ts: "2026-06-12T10:00:00Z",
        handoff_id: "h-post-failed",
        agent_name: "post-failed",
        gate_outcome: "failed",
        latency_ms: 10000,
      },
    ] as const) {
      writer.upsert({
        performance_id: row.performance_id,
        ts: row.ts,
        handoff_id: row.handoff_id,
        conversation_id: `c-${row.performance_id}`,
        project_id: "proj",
        agent_name: row.agent_name,
        task_type: "review_adversarial",
        outcome: "completed_with_output",
        gate_outcome: row.gate_outcome,
        rounds: 1,
        smoke_pass: "n/a",
        reviewer_findings: 0,
        maestro_score: null,
        cost_usd: null,
        tokens_used: null,
        latency_ms: row.latency_ms,
        source: "reconciler",
        notes: null,
        metadata_json: "{}",
      });
    }

    const out = getRecommendationsViaRoute({
      db,
      taskType: "review_adversarial",
      now: new Date("2026-06-13T12:00:00Z"),
    });

    expect(out).toHaveLength(4);
    expect(out.map((row) => row.agent_name)).toEqual([
      "post-skipped",
      "legacy-null",
      "post-failed",
      "post-null",
    ]);
    expect(out.find((row) => row.agent_name === "legacy-null")?.success_rate).toBe(1);
    expect(out.find((row) => row.agent_name === "post-null")?.success_rate).toBe(0);
    expect(out.find((row) => row.agent_name === "post-skipped")?.success_rate).toBe(1);
    expect(out.find((row) => row.agent_name === "post-failed")?.success_rate).toBe(0);
    expect(out.find((row) => row.agent_name === "legacy-null")?.gate_verdict_coverage).toBe(0);
    expect(out.find((row) => row.agent_name === "post-skipped")?.gate_verdict_coverage).toBe(1);
    expect(out.find((row) => row.agent_name === "legacy-null")?.gate_pass_rate).toBe(0);
    expect(out.find((row) => row.agent_name === "post-skipped")?.gate_pass_rate).toBe(1);
  });

  test("post-cutover rejected success scores below a no-data agent", () => {
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "clean",
      ts: "2026-06-12T10:00:00Z",
      handoff_id: "h-clean",
      conversation_id: "c-clean",
      project_id: "proj",
      agent_name: "clean",
      task_type: "review_adversarial",
      outcome: "completed_with_output",
      gate_outcome: "passed",
      rounds: 1,
      smoke_pass: "n/a",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "rejected",
      ts: "2026-06-12T10:00:00Z",
      handoff_id: "h-rejected",
      conversation_id: "c-rejected",
      project_id: "proj",
      agent_name: "rejected",
      task_type: "review_adversarial",
      outcome: "completed_with_output",
      gate_outcome: "failed",
      rounds: 1,
      smoke_pass: "n/a",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });
    writer.upsert({
      performance_id: "neutral",
      ts: "2026-06-12T10:00:00Z",
      handoff_id: "h-neutral",
      conversation_id: "c-neutral",
      project_id: "proj",
      agent_name: "neutral",
      task_type: "review_adversarial",
      outcome: "bypassed",
      gate_outcome: "skipped",
      rounds: 1,
      smoke_pass: "n/a",
      reviewer_findings: 0,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: 1000,
      source: "reconciler",
      notes: null,
      metadata_json: "{}",
    });

    const out = routeAgent({
      db,
      detail: "rank",
      taskType: "review_adversarial",
      includeNeutral: true,
      now: new Date("2026-06-13T12:00:00Z"),
    });
    if (out.detail !== "rank") throw new Error("expected rank output");
    const clean = out.candidates.candidates.find((row) => row.agent_name === "clean");
    const rejected = out.candidates.candidates.find((row) => row.agent_name === "rejected");
    const neutral = out.candidates.candidates.find((row) => row.agent_name === "neutral");
    expect(clean).toBeDefined();
    expect(rejected).toBeDefined();
    expect(neutral).toBeDefined();
    expect(clean!.score).toBeGreaterThan(neutral!.score);
    expect(neutral!.score).toBeGreaterThan(rejected!.score);
  });

  test("success predicate binds the gate cutover by name", () => {
    const previousCutover = process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO;
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "2026-05-01T00:00:00.000Z";
    try {
      const writer = new AgentPerformanceWriter(db);
      for (const row of [
        {
          performance_id: "predicate-legacy-null",
          ts: "2026-04-30T12:00:00Z",
          gate_outcome: null,
        },
        {
          performance_id: "predicate-post-null",
          ts: "2026-05-02T12:00:00Z",
          gate_outcome: null,
        },
      ] as const) {
        writer.upsert({
          performance_id: row.performance_id,
          ts: row.ts,
          handoff_id: `h-${row.performance_id}`,
          conversation_id: `c-${row.performance_id}`,
          project_id: "proj",
          agent_name: row.performance_id,
          task_type: "health_check",
          outcome: "completed_with_output",
          gate_outcome: row.gate_outcome,
          rounds: 1,
          smoke_pass: "n/a",
          reviewer_findings: 0,
          maestro_score: null,
          cost_usd: null,
          tokens_used: null,
          latency_ms: 1000,
          source: "reconciler",
          notes: null,
          metadata_json: "{}",
        });
      }

      const predicate = buildSuccessPredicate();
      expect(predicate.sql).toContain("$gateOutcomeCutover");
      expect(predicate.params).toEqual({
        $gateOutcomeCutover: "2026-05-01T00:00:00.000Z",
      });

      const rows = db
        .query<{ performance_id: string; success: number }, typeof predicate.params>(
          `SELECT performance_id, CASE WHEN ${predicate.sql} THEN 1 ELSE 0 END AS success
             FROM agent_performance
            WHERE performance_id IN ('predicate-legacy-null', 'predicate-post-null')
            ORDER BY performance_id`,
        )
        .all(predicate.params);
      expect(rows).toEqual([
        { performance_id: "predicate-legacy-null", success: 1 },
        { performance_id: "predicate-post-null", success: 0 },
      ]);
    } finally {
      if (previousCutover === undefined) delete process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO;
      else process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = previousCutover;
    }
  });

  test("gate outcome cutover can be overridden by environment", () => {
    const previousCutover = process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO;
    process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = "2026-05-01T00:00:00.000Z";
    try {
      const writer = new AgentPerformanceWriter(db);
      writer.upsert({
        performance_id: "override-post-null",
        ts: "2026-05-12T12:00:00Z",
        handoff_id: "h-override-post-null",
        conversation_id: "c-override-post-null",
        project_id: "proj",
        agent_name: "override-post-null",
        task_type: "health_check",
        outcome: "completed_with_output",
        gate_outcome: null,
        rounds: 1,
        smoke_pass: "n/a",
        reviewer_findings: 0,
        maestro_score: null,
        cost_usd: null,
        tokens_used: null,
        latency_ms: 1000,
        source: "reconciler",
        notes: null,
        metadata_json: "{}",
      });

      const out = getRecommendationsViaRoute({
        db,
        taskType: "health_check",
        now: new Date("2026-05-12T13:00:00Z"),
      });

      expect(out[0]?.success_rate).toBe(0);
    } finally {
      if (previousCutover === undefined) delete process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO;
      else process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO = previousCutover;
    }
  });

  test("success predicate excludes post-cutover classifier declines from SQL recommendation denominators", () => {
    const previousCutover = process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO;
    process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = "2026-06-13T00:00:00.000Z";
    try {
      const writer = new AgentPerformanceWriter(db);
      writer.upsert({
        performance_id: "classifier-sql-success",
        ts: "2026-06-13T10:00:00.000Z",
        handoff_id: "h-classifier-sql-success",
        conversation_id: "c-classifier-sql-success",
        project_id: "proj",
        agent_name: "classifier-sql-agent",
        task_type: "health_check",
        outcome: "completed_with_output",
        gate_outcome: "passed",
        rounds: 1,
        smoke_pass: "n/a",
        reviewer_findings: 0,
        maestro_score: null,
        cost_usd: null,
        tokens_used: null,
        latency_ms: 1000,
        source: "reconciler",
        notes: null,
        metadata_json: "{}",
      });
      writer.upsert({
        performance_id: "classifier-sql-declined",
        ts: "2026-06-13T10:01:00.000Z",
        handoff_id: "h-classifier-sql-declined",
        conversation_id: "c-classifier-sql-declined",
        project_id: "proj",
        agent_name: "classifier-sql-agent",
        task_type: "health_check",
        outcome: "failed",
        failure_class: "classifier_declined",
        gate_outcome: null,
        rounds: 1,
        smoke_pass: "n",
        reviewer_findings: 0,
        maestro_score: null,
        cost_usd: null,
        tokens_used: null,
        latency_ms: 1000,
        source: "worker",
        notes: null,
        metadata_json: "{}",
      });

      const out = routeAgent({
        db,
        detail: "summary",
        taskType: "health_check",
        now: new Date("2026-06-13T12:00:00.000Z"),
      });
      const agent = (out as any).recommendations.find(
        (r: any) => r.agent_name === "classifier-sql-agent",
      );

      expect(agent.samples).toBe(1);
      expect(agent.success_rate).toBe(1);
    } finally {
      if (previousCutover === undefined) delete process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO;
      else process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO = previousCutover;
    }
  });
});

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RoutingDecision } from "../../src/routing/schemas.js";

import { migrate } from "../../src/db/migrations.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { computeCalibration } from "../../src/routing/calibration.js";
import { writeRoutingDecision } from "../../src/routing/decision-log.js";
import { AgentPerformanceWriter } from "../../src/writers/agent-performance.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

const NOW = new Date("2026-08-25T12:00:00.000Z");
const AGENT = "quality-seat";

function baseDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    selected: { agent: AGENT, provider: "openai", routeId: `openai:${AGENT}` },
    taskProfile: {
      schemaVersion: "1",
      taskTypes: ["coding"],
      complexity: 0.5,
      risk: 0.3,
      ambiguity: 0.2,
      codingDemand: 0.8,
      reasoningDemand: 0.6,
      agenticDemand: 0.4,
      contextDemand: 0.5,
      latencySensitivity: 0.3,
      costSensitivity: 0.3,
      reliabilityDemand: 0.7,
      requiredCapabilities: [],
      preferredCapabilities: [],
      disallowedCapabilities: [],
      confidence: 0.8,
      rationale: ["fixture"],
    },
    score: 0.8,
    confidence: 0.8,
    alternatives: [],
    factors: [],
    fallbackChain: [],
    dataFreshness: {},
    explanation: [],
    routerSchemaVersion: "1",
    ...overrides,
  };
}

function seedDecision(
  db: Database,
  handoffId: string,
  ts: string,
  predictedCostUsd: number,
  predictedLatencyMs: number,
): void {
  writeRoutingDecision(db, baseDecision(), {
    decisionId: `decision-${handoffId}`,
    ts,
    handoffId,
    mode: "auto",
    applied: true,
    predictedCostUsd,
    predictedLatencyMs,
  });
}

function seedActual(
  db: Database,
  handoffId: string,
  ts: string,
  actualCostUsd: number,
  actualLatencyMs: number,
): void {
  const writer = new AgentPerformanceWriter(db);
  writer.upsert({
    performance_id: `perf-${handoffId}`,
    ts,
    handoff_id: handoffId,
    conversation_id: "conv",
    project_id: "project",
    agent_name: AGENT,
    task_type: "implement_substantial",
    outcome: "merged",
    rounds: 1,
    smoke_pass: "y",
    reviewer_findings: 0,
    maestro_score: 5,
    cost_usd: actualCostUsd,
    tokens_used: 1_000,
    latency_ms: actualLatencyMs,
    source: "manual_seed",
    notes: null,
    metadata_json: "{}",
  });
}

describe("routing calibration", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  afterEach(() => {
    db.close();
  });

  test("joins routing_decisions.predicted_* with agent_performance actuals on handoff_id", () => {
    seedDecision(db, "handoff-1", "2026-08-20T00:00:00.000Z", 0.1, 1_000);
    seedActual(db, "handoff-1", "2026-08-20T00:05:00.000Z", 0.2, 2_000);

    const report = computeCalibration(db, AGENT, 30, NOW);

    expect(report.cost.sampleCount).toBe(1);
    expect(report.cost.meanRatio).toBe(2);
    expect(report.cost.ewmaRatio).toBe(2);
    expect(report.latency.sampleCount).toBe(1);
    expect(report.latency.meanRatio).toBe(2);
    expect(report.latency.ewmaRatio).toBe(2);
  });

  test("a routing_decisions row with no matching agent_performance row contributes no sample", () => {
    seedDecision(db, "handoff-orphan", "2026-08-20T00:00:00.000Z", 0.1, 1_000);

    const report = computeCalibration(db, AGENT, 30, NOW);

    expect(report.cost.sampleCount).toBe(0);
    expect(report.cost.meanRatio).toBeNull();
    expect(report.cost.ewmaRatio).toBeNull();
  });

  test("only decisions where this agent was selected and applied contribute samples", () => {
    seedDecision(db, "handoff-1", "2026-08-20T00:00:00.000Z", 0.1, 1_000);
    seedActual(db, "handoff-1", "2026-08-20T00:05:00.000Z", 0.1, 1_000);

    writeRoutingDecision(
      db,
      baseDecision({
        selected: { agent: "fast-seat", provider: "google", routeId: "google:fast-seat" },
      }),
      {
        decisionId: "decision-handoff-2",
        ts: "2026-08-20T01:00:00.000Z",
        handoffId: "handoff-2",
        mode: "auto",
        applied: true,
        predictedCostUsd: 999,
        predictedLatencyMs: 999,
      },
    );
    const writer = new AgentPerformanceWriter(db);
    writer.upsert({
      performance_id: "perf-handoff-2",
      ts: "2026-08-20T01:05:00.000Z",
      handoff_id: "handoff-2",
      conversation_id: "conv",
      project_id: "project",
      agent_name: "fast-seat",
      task_type: "implement_substantial",
      outcome: "merged",
      rounds: 1,
      smoke_pass: "y",
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: 0.01,
      tokens_used: 100,
      latency_ms: 10,
      source: "manual_seed",
      notes: null,
      metadata_json: "{}",
    });

    const report = computeCalibration(db, AGENT, 30, NOW);

    expect(report.cost.sampleCount).toBe(1);
    expect(report.cost.meanRatio).toBe(1);
  });

  test("samples outside the trailing window are excluded", () => {
    seedDecision(db, "handoff-old", "2026-06-01T00:00:00.000Z", 0.1, 1_000);
    seedActual(db, "handoff-old", "2026-06-01T00:05:00.000Z", 0.5, 5_000);

    const report = computeCalibration(db, AGENT, 7, NOW);

    expect(report.cost.sampleCount).toBe(0);
    expect(report.since).toBe("2026-08-18T12:00:00.000Z");
    expect(report.until).toBe(NOW.toISOString());
  });

  test("bounded EWMA weights recent samples more and clamps outlier ratios", () => {
    seedDecision(db, "handoff-1", "2026-08-01T00:00:00.000Z", 0.1, 1_000);
    seedActual(db, "handoff-1", "2026-08-01T00:05:00.000Z", 0.1, 1_000); // ratio 1
    seedDecision(db, "handoff-2", "2026-08-10T00:00:00.000Z", 0.01, 1_000);
    seedActual(db, "handoff-2", "2026-08-10T00:05:00.000Z", 10, 1_000); // ratio 1000 -> clamped to 20

    const report = computeCalibration(db, AGENT, 30, NOW);

    expect(report.cost.sampleCount).toBe(2);
    // clamped ratios are [1, 20]; EWMA (alpha 0.3) stays well below the raw 1000 ratio
    // and below the unclamped mean, proving the outlier was bounded before smoothing.
    expect(report.cost.ewmaRatio).toBeLessThan(20);
    expect(report.cost.ewmaRatio).toBeGreaterThan(1);
    expect(report.cost.ewmaRatio).toBeCloseTo(1 + 0.3 * (20 - 1), 6);
  });

  test("computeCalibration performs no writes and is reversible across repeated runs", () => {
    seedDecision(db, "handoff-1", "2026-08-20T00:00:00.000Z", 0.1, 1_000);
    seedActual(db, "handoff-1", "2026-08-20T00:05:00.000Z", 0.2, 2_000);

    const countBefore = db
      .query<
        { n: number },
        []
      >("SELECT (SELECT COUNT(*) FROM routing_decisions) + (SELECT COUNT(*) FROM agent_performance) AS n")
      .get()!.n;

    const first = computeCalibration(db, AGENT, 30, NOW);
    const second = computeCalibration(db, AGENT, 30, NOW);

    const countAfter = db
      .query<
        { n: number },
        []
      >("SELECT (SELECT COUNT(*) FROM routing_decisions) + (SELECT COUNT(*) FROM agent_performance) AS n")
      .get()!.n;

    expect(countAfter).toBe(countBefore);
    expect(second).toEqual(first);
  });

  test("an agent with zero history returns a report with null ratios, not fabricated defaults", () => {
    const report = computeCalibration(db, "never-routed-agent", 30, NOW);

    expect(report.cost).toEqual({ sampleCount: 0, meanRatio: null, ewmaRatio: null });
    expect(report.latency).toEqual({ sampleCount: 0, meanRatio: null, ewmaRatio: null });
  });
});

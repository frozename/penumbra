import type { RoutingDecision } from "@src/routing/schemas.js";

import { migrate } from "@src/db/migrations.js";
import { SCHEMA_VERSION } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { readRoutingDecisions, writeRoutingDecision } from "@src/routing/decision-log.js";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // ignore: fall back to bundled SQLite if Homebrew lib is unavailable
  }
}

function makeDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    selected: {
      agent: "codex-acp-fast",
      provider: "openai",
      reasoningLevel: "medium",
      routeId: "openai:codex-acp-fast",
    },
    taskProfile: {
      schemaVersion: "1",
      taskTypes: ["coding"],
      complexity: 0.4,
      risk: 0.3,
      ambiguity: 0.2,
      codingDemand: 0.8,
      reasoningDemand: 0.7,
      agenticDemand: 0.5,
      contextDemand: 0.6,
      latencySensitivity: 0.1,
      costSensitivity: 0.2,
      reliabilityDemand: 0.9,
      requiredCapabilities: ["typescript"],
      preferredCapabilities: ["sqlite"],
      disallowedCapabilities: ["no-tools"],
      confidence: 0.85,
      rationale: ["Needs schema-level validation."],
    },
    score: 0.88,
    confidence: 0.8,
    alternatives: [
      {
        routeId: "anthropic:claude-acp-sonnet",
        score: 0.72,
        excluded: false,
        reasons: ["Lower coding score."],
      },
    ],
    factors: [
      {
        name: "coding",
        rawValue: 0.81,
        normalizedValue: 0.81,
        weight: 0.4,
        contribution: 0.324,
        source: "artificial_analysis",
      },
      {
        name: "quota",
        source: "harness",
      },
    ],
    fallbackChain: ["claude-acp-sonnet"],
    dataFreshness: {
      artificial_analysis: "2026-08-23T00:00:00.000Z",
    },
    explanation: ["Selected highest scoring available agent."],
    routerSchemaVersion: "1",
    ...overrides,
  };
}

describe("routing decision log", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
  });

  afterEach(() => {
    db.close();
  });

  test("write then read round-trips routing metadata and JSON exactly", () => {
    const decision = makeDecision();

    writeRoutingDecision(db, decision, {
      decisionId: "decision-1",
      ts: "2026-08-24T12:00:00.000Z",
      handoffId: "handoff-1",
      mode: "live",
      applied: true,
      role: "executor",
      predictedCostUsd: 0.12,
      predictedLatencyMs: 240,
    });

    const [record] = readRoutingDecisions(db, { handoffId: "handoff-1" });

    expect(record?.taskProfile).toEqual(decision.taskProfile);
    expect(record?.factors).toEqual(decision.factors);
    expect(record?.alternatives).toEqual(decision.alternatives);
    expect(record?.fallbackChain).toEqual(decision.fallbackChain);
    expect(record?.dataFreshness).toEqual(decision.dataFreshness);
    expect(record?.explanation).toEqual(decision.explanation);
    expect(record?.role).toBe("executor");
    expect(record?.predictedCostUsd).toBe(0.12);
    expect(record?.predictedLatencyMs).toBe(240);
  });

  test("two decisions for the same handoff_id both persist", () => {
    const first = makeDecision({ score: 0.7 });
    const second = makeDecision({ score: 0.9 });

    writeRoutingDecision(db, first, {
      decisionId: "decision-1",
      ts: "2026-08-24T12:00:00.000Z",
      handoffId: "handoff-1",
      mode: "shadow",
      applied: false,
    });
    writeRoutingDecision(db, second, {
      decisionId: "decision-2",
      ts: "2026-08-24T12:01:00.000Z",
      handoffId: "handoff-1",
      mode: "retry",
      applied: true,
    });

    const records = readRoutingDecisions(db, { handoffId: "handoff-1" });

    expect(records).toHaveLength(2);
    expect(records.map((record) => record.decisionId)).toEqual(["decision-2", "decision-1"]);
  });

  test("a decision with handoff_id null (replay mode) is writable and readable", () => {
    writeRoutingDecision(db, makeDecision({ selected: null }), {
      decisionId: "replay-1",
      ts: "2026-08-24T12:00:00.000Z",
      handoffId: null,
      mode: "replay",
      applied: false,
    });

    const records = readRoutingDecisions(db, { handoffId: null });

    expect(records).toHaveLength(1);
    expect(records[0]?.handoffId).toBeNull();
    expect(records[0]?.selectedAgent).toBeNull();
    expect(records[0]?.role).toBeNull();
    expect(records[0]?.predictedCostUsd).toBeNull();
    expect(records[0]?.predictedLatencyMs).toBeNull();
  });

  test("read filters by sinceIso and applies limit after newest-first ordering", () => {
    for (const [decisionId, ts] of [
      ["decision-1", "2026-08-24T12:00:00.000Z"],
      ["decision-2", "2026-08-24T12:30:00.000Z"],
      ["decision-3", "2026-08-24T13:00:00.000Z"],
    ] as const) {
      writeRoutingDecision(db, makeDecision(), {
        decisionId,
        ts,
        handoffId: "handoff-1",
        mode: "live",
        applied: true,
      });
    }

    const since = readRoutingDecisions(db, {
      handoffId: "handoff-1",
      sinceIso: "2026-08-24T12:30:00.000Z",
    });
    const limited = readRoutingDecisions(db, { handoffId: "handoff-1", limit: 2 });

    expect(since.map((record) => record.decisionId)).toEqual(["decision-3", "decision-2"]);
    expect(limited.map((record) => record.decisionId)).toEqual(["decision-3", "decision-2"]);
  });

  test("read path uses the composite handoff and timestamp index without a temp sort", () => {
    const plan = db
      .query<{ detail: string }, [string]>(
        `EXPLAIN QUERY PLAN
         SELECT decision_id
         FROM routing_decisions
         WHERE handoff_id = ?
         ORDER BY ts DESC`,
      )
      .all("handoff-1");
    const details = plan.map((row) => row.detail).join("\n");

    expect(details).toContain("idx_routing_decisions_handoff_id_ts");
    expect(details).not.toContain("USE TEMP B-TREE");
  });

  test("migrate replaces the legacy handoff index and preserves decisions", () => {
    writeRoutingDecision(db, makeDecision(), {
      decisionId: "legacy-index-row",
      ts: "2026-08-24T12:00:00.000Z",
      handoffId: "handoff-1",
      mode: "live",
      applied: true,
    });
    db.run("DROP INDEX IF EXISTS idx_routing_decisions_handoff_id_ts");
    db.run("DROP INDEX IF EXISTS idx_routing_decisions_handoff_id");
    db.run("CREATE INDEX idx_routing_decisions_handoff_id ON routing_decisions(handoff_id)");

    migrate(db, { embeddingDim: 384 });

    const columns = db
      .query<{ name: string }, []>("PRAGMA index_info('idx_routing_decisions_handoff_id_ts')")
      .all()
      .map((column) => column.name);
    expect(columns).toEqual(["handoff_id", "ts"]);
    expect(readRoutingDecisions(db, { handoffId: "handoff-1" })).toHaveLength(1);
  });

  test("re-migrating a v40 database preserves existing routing decisions", () => {
    writeRoutingDecision(db, makeDecision(), {
      decisionId: "persisted-before-remigrate",
      ts: "2026-08-24T12:00:00.000Z",
      handoffId: "handoff-1",
      mode: "live",
      applied: true,
      role: "executor",
      predictedCostUsd: 0.12,
      predictedLatencyMs: 240,
    });

    migrate(db, { embeddingDim: 384 });

    const [record] = readRoutingDecisions(db, { handoffId: "handoff-1" });
    expect(record?.decisionId).toBe("persisted-before-remigrate");
    expect(record?.role).toBe("executor");
    expect(record?.predictedCostUsd).toBe(0.12);
    expect(record?.predictedLatencyMs).toBe(240);
  });

  test("applySchema/migrate is idempotent", () => {
    migrate(db, { embeddingDim: 384 });

    const table = db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'routing_decisions'")
      .get();

    expect(table?.name).toBe("routing_decisions");
  });

  test("migrate reaches the bumped SCHEMA_VERSION", () => {
    expect(SCHEMA_VERSION).toBe(42);

    const marker = db
      .query<{ value: string }, []>("SELECT value FROM db_meta WHERE key = 'schema_version'")
      .get();

    expect(marker?.value).toBe(String(SCHEMA_VERSION));
  });
});

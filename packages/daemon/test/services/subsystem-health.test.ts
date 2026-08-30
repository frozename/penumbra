import { DispatchEventLog, loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  buildRequiredLlmRoleFloors,
  computeSubsystemAlerts,
  DREAM_QUERY_REWRITE_SUBSYSTEM,
  evaluateLlmRoleFloors,
  readSubsystemHealth,
  recordSubsystemOutcome,
} from "../../src/services/subsystem-health.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // Optional Homebrew SQLite is unavailable in some CI images.
}

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

describe("subsystem health", () => {
  test("records a failure against a real schema-migrated DB", () => {
    const db = setupDb();
    const table = db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subsystem_health'")
      .get();
    expect(table).not.toBeNull();

    const log = new DispatchEventLog(db);
    log.record({
      handoff_id: "dream-cycle-1",
      source: "daemon",
      kind: "dream_p4_query_rewrite_failed",
      ts: "2026-08-18T10:00:00.000Z",
      meta: { model: "rewriter-a", reason: "http_error", status: 503 },
    });

    recordSubsystemOutcome(db, {
      subsystem: "dream.query_rewrite",
      tier: "fallback",
      ok: false,
      ts: "2026-08-18T10:00:00.000Z",
      model: "rewriter-a",
      reason: "http_error",
      status: 503,
    });

    const row = readSubsystemHealth(db, "dream.query_rewrite");
    expect(row).not.toBeNull();
    expect(row?.tier).toBe("fallback");
    expect(row?.consecutive_failures).toBe(1);
    expect(row?.last_failure_ts).toBe("2026-08-18T10:00:00.000Z");
    expect(row?.last_failure_reason).toBe("http_error");
    expect(row?.last_failure_status).toBe(503);
    expect(row?.first_non_primary_ts).toBe("2026-08-18T10:00:00.000Z");
  });

  test("first_non_primary_ts is set once and not refreshed on subsequent failures", () => {
    const db = setupDb();

    recordSubsystemOutcome(db, {
      subsystem: "dream.query_rewrite",
      tier: "fallback",
      ok: false,
      ts: "2026-08-18T10:00:00.000Z",
      reason: "timeout",
    });
    recordSubsystemOutcome(db, {
      subsystem: "dream.query_rewrite",
      tier: "fallback",
      ok: false,
      ts: "2026-08-18T11:30:00.000Z",
      reason: "http_error",
      status: 429,
    });

    const row = readSubsystemHealth(db, "dream.query_rewrite");
    expect(row?.consecutive_failures).toBe(2);
    expect(row?.last_failure_ts).toBe("2026-08-18T11:30:00.000Z");
    expect(row?.first_non_primary_ts).toBe("2026-08-18T10:00:00.000Z");
  });

  test("emits permanent_fallback after the lease window even while the subsystem is currently succeeding", () => {
    const db = setupDb();

    recordSubsystemOutcome(db, {
      subsystem: "dream.query_rewrite",
      tier: "fallback",
      ok: true,
      ts: "2026-08-18T05:00:00.000Z",
      model: "fallback-title",
    });
    recordSubsystemOutcome(db, {
      subsystem: "dream.query_rewrite",
      tier: "fallback",
      ok: true,
      ts: "2026-08-18T12:00:00.000Z",
      model: "fallback-title",
    });

    expect(computeSubsystemAlerts(db, { now: new Date("2026-08-18T12:00:00.000Z") })).toContain(
      "dream.health.rewrite_permanent_fallback",
    );
  });

  test("alerts on consecutive query rewrite failures before the 24h rate crosses the alert threshold", () => {
    const db = setupDb();

    for (let i = 0; i < 4; i += 1) {
      recordSubsystemOutcome(db, {
        subsystem: DREAM_QUERY_REWRITE_SUBSYSTEM,
        tier: "fallback",
        ok: false,
        ts: `2026-08-18T12:0${String(i)}:00.000Z`,
        reason: "timeout",
      });
    }

    expect(
      computeSubsystemAlerts(db, {
        now: new Date("2026-08-18T12:05:00.000Z"),
        queryRewriteFailed24h: 4,
        queryRewriteSuccess24h: 100,
        queryRewriteConsecutiveFailuresAlertThreshold: 3,
      }),
    ).toContain("dream.health.rewrite_failing");
  });

  test("does not alert on recovered query rewrite failure volume with no recent failures", () => {
    const db = setupDb();

    recordSubsystemOutcome(db, {
      subsystem: DREAM_QUERY_REWRITE_SUBSYSTEM,
      tier: "fallback",
      ok: false,
      ts: "2026-08-18T03:00:00.000Z",
      reason: "timeout",
    });
    recordSubsystemOutcome(db, {
      subsystem: DREAM_QUERY_REWRITE_SUBSYSTEM,
      tier: "primary",
      ok: true,
      ts: "2026-08-18T12:00:00.000Z",
      model: "rewriter-a",
    });

    const opts = {
      now: new Date("2026-08-18T12:05:00.000Z"),
      queryRewriteFailed24h: 200,
      queryRewriteSuccess24h: 10,
      queryRewriteFailedRecent: 0,
      queryRewriteConsecutiveFailuresAlertThreshold: 3,
    };

    expect(computeSubsystemAlerts(db, opts)).not.toContain("dream.health.rewrite_failing");
  });

  test("alerts when a required LLM role has zero holders", () => {
    const db = setupDb();

    expect(
      computeSubsystemAlerts(db, {
        requiredLlmRoleFloors: [
          {
            role: "brief-synthesizer",
            consumer: "dreaming.brief_synthesizer",
            minimumHolders: 1,
          },
        ],
        agentchatConfig: { agents: [{ name: "judge", roles: ["dreaming-judge"] }] },
      }),
    ).toContain("llm.role_floor.brief-synthesizer.required_1.actual_0");
  });

  test("alerts when a required LLM role has fewer holders than its consumer quorum", () => {
    const db = setupDb();

    expect(
      computeSubsystemAlerts(db, {
        requiredLlmRoleFloors: [
          { role: "memory-refiner", consumer: "t2.promotion", minimumHolders: 2 },
        ],
        agentchatConfig: { agents: [{ name: "solo-refiner", roles: ["memory-refiner"] }] },
      }),
    ).toContain("llm.role_floor.memory-refiner.required_2.actual_1");
  });

  test("uses the real t2 promotion memory-refiner floor of one holder", () => {
    const db = setupDb();

    const alerts = computeSubsystemAlerts(db, {
      requiredLlmRoleFloors: buildRequiredLlmRoleFloors({
        dreamingAutoPromoteMinJudges: 2,
      }),
      agentchatConfig: {
        agents: [
          { name: "brief-synthesizer-1", roles: ["brief-synthesizer"] },
          { name: "memory-refiner-1", roles: ["memory-refiner"] },
          { name: "dreaming-judge-1", roles: ["dreaming-judge"] },
          { name: "dreaming-judge-2", roles: ["dreaming-judge"] },
          { name: "dreaming-rewriter-1", roles: ["dreaming-rewriter"] },
          { name: "refiner-1", roles: ["refiner"] },
        ],
      },
    });

    expect(alerts.filter((alert) => alert.startsWith("llm.role_floor."))).toEqual([]);
  });

  test("does not alert when a required LLM role is at or above its floor", () => {
    const db = setupDb();

    expect(
      computeSubsystemAlerts(db, {
        requiredLlmRoleFloors: [
          { role: "dreaming-judge", consumer: "dreaming.p1_auto_promote", minimumHolders: 2 },
        ],
        agentchatConfig: {
          agents: [
            { name: "judge-a", roles: ["dreaming-judge"] },
            { name: "judge-b", roles: ["dreaming-judge"] },
            { name: "judge-c", roles: ["dreaming-judge"] },
          ],
        },
      }),
    ).not.toContain("llm.role_floor.dreaming-judge.required_2.actual_3");
  });

  test("does not alert for the current live production role floor counts", () => {
    const db = setupDb();
    const agents = [
      { name: "brief-synthesizer-1", roles: ["brief-synthesizer"] },
      { name: "memory-refiner-1", roles: ["memory-refiner"] },
      { name: "dreaming-judge-1", roles: ["dreaming-judge"] },
      { name: "dreaming-judge-2", roles: ["dreaming-judge"] },
      { name: "dreaming-judge-3", roles: ["dreaming-judge"] },
      { name: "dreaming-rewriter-1", roles: ["dreaming-rewriter"] },
      { name: "dreaming-rewriter-2", roles: ["dreaming-rewriter"] },
      { name: "dreaming-rewriter-3", roles: ["dreaming-rewriter"] },
      { name: "refiner-1", roles: ["refiner"] },
      { name: "refiner-2", roles: ["refiner"] },
      { name: "refiner-3", roles: ["refiner"] },
      { name: "embedder-1", roles: ["embedder"] },
      ...Array.from({ length: 35 }, (_, idx) => ({
        name: `non-role-seat-${String(idx + 1)}`,
        roles: ["executor"],
      })),
    ];

    const alerts = computeSubsystemAlerts(db, {
      requiredLlmRoleFloors: buildRequiredLlmRoleFloors({
        dreamingAutoPromoteMinJudges: 2,
      }),
      agentchatConfig: { agents },
    });

    expect(agents).toHaveLength(47);
    expect(alerts.filter((alert) => alert.startsWith("llm.role_floor."))).toEqual([]);
  });

  test("default role floors include only source-consumed LLM roles", () => {
    expect(
      buildRequiredLlmRoleFloors({
        env: {},
        dreamingAutoPromoteMinJudges: 2,
      }),
    ).toEqual([
      { role: "brief-synthesizer", consumer: "dreaming.brief_synthesizer", minimumHolders: 1 },
      { role: "memory-refiner", consumer: "t2.promotion", minimumHolders: 1 },
      { role: "dreaming-judge", consumer: "dreaming.p1_auto_promote", minimumHolders: 2 },
      { role: "dreaming-rewriter", consumer: "dreaming.p4_query_rewrite", minimumHolders: 1 },
      { role: "refiner", consumer: "dispatch.refiner", minimumHolders: 1 },
    ]);
  });

  test("alerts when the dispatch refiner role consumer has no holders", () => {
    const evaluation = evaluateLlmRoleFloors({
      requiredRoles: buildRequiredLlmRoleFloors({
        env: {},
        dreamingAutoPromoteMinJudges: 2,
      }),
      agentchatConfig: {
        agents: [
          { name: "brief-synthesizer-1", roles: ["brief-synthesizer"] },
          { name: "memory-refiner-1", roles: ["memory-refiner"] },
          { name: "dreaming-judge-1", roles: ["dreaming-judge"] },
          { name: "dreaming-judge-2", roles: ["dreaming-judge"] },
          { name: "dreaming-rewriter-1", roles: ["dreaming-rewriter"] },
        ],
      },
    });

    expect(evaluation.violations).toContainEqual({
      role: "refiner",
      consumer: "dispatch.refiner",
      requiredHolders: 1,
      actualHolders: 0,
      holderNames: [],
    });
  });

  test("alerts fail-closed when the role registry is unparseable", () => {
    const db = setupDb();

    expect(
      computeSubsystemAlerts(db, {
        requiredLlmRoleFloors: [
          { role: "memory-refiner", consumer: "t2.promotion", minimumHolders: 2 },
        ],
        agentchatConfig: { agents: [{ name: "broken", roles: "memory-refiner" }] },
      }),
    ).toContain("llm.role_floor.memory-refiner.required_2.actual_0");
  });
});

import { DispatchEventLog, loadSqliteVec, migrate } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  computeSubsystemAlerts,
  DREAM_QUERY_REWRITE_SUBSYSTEM,
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
        ts: `2026-08-18T12:0${i}:00.000Z`,
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
});

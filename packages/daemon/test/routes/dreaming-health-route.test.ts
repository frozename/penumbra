import {
  buildServices,
  DispatchEventLog,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { dreamingHealthRoute } from "@src/routes/dreaming.js";
import { recordSubsystemOutcome } from "@src/services/subsystem-health.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // Optional Homebrew SQLite is unavailable in some CI images.
}

function makeServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/dreaming-health-route-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date(),
    uuid: (() => {
      let n = 0;
      return (): string => `evt-${String(++n)}`;
    })(),
  });
}

async function routeBody(services: Services): Promise<{
  alerts: string[];
  health_recency_window_ms: number;
  cycles_crash_status: string;
  query_rewrite_failed_24h: number;
  query_rewrite_failed_recent: number;
  query_rewritten_24h: number;
  query_rewrite_status: string;
  cycles_crashed_24h: number;
  cycles_crashed_recent: number;
  subsystem_health: null | {
    subsystem: string;
    tier: string;
    seat: string | null;
    model: string | null;
    consecutive_failures: number;
    last_success_ts: string | null;
    last_failure_ts: string | null;
    last_failure_reason: string | null;
  };
}> {
  const response = dreamingHealthRoute(new Request("http://x/dreaming/health"), services);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    alerts: string[];
    health_recency_window_ms: number;
    cycles_crash_status: string;
    query_rewrite_failed_24h: number;
    query_rewrite_failed_recent: number;
    query_rewritten_24h: number;
    query_rewrite_status: string;
    cycles_crashed_24h: number;
    cycles_crashed_recent: number;
    subsystem_health: null | {
      subsystem: string;
      tier: string;
      seat: string | null;
      model: string | null;
      consecutive_failures: number;
      last_success_ts: string | null;
      last_failure_ts: string | null;
      last_failure_reason: string | null;
    };
  };
}

function isoOffset(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function insertDreamCycle(
  services: Services,
  input: { cycle_id: string; started_at: number; outcome: string },
): void {
  services.db
    .prepare(
      `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
       VALUES(?, ?, 'cron', 0, ?, '[]')`,
    )
    .run(input.cycle_id, input.started_at, input.outcome);
}

describe("dreamingHealthRoute", () => {
  test("alerts on high model rewrite failure rate while excluding cache-hit rewrites", async () => {
    const services = makeServices();
    const log = new DispatchEventLog(services.db);
    const ts = new Date().toISOString();
    for (let i = 0; i < 256; i += 1) {
      log.record({
        handoff_id: `dream-cycle-fail-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_rewrite_failed",
        ts,
        meta: { model: "rewriter-a", reason: "http_error", status: 503, cache_hit: false },
      });
    }
    for (let i = 0; i < 5; i += 1) {
      log.record({
        handoff_id: `dream-cycle-success-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_rewritten",
        ts,
        meta: { model: "rewriter-a", latency_ms: 123, cache_hit: false },
      });
    }
    for (let i = 0; i < 4; i += 1) {
      log.record({
        handoff_id: `dream-cycle-cache-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_rewritten",
        ts,
        meta: { model: "rewriter-a", latency_ms: 0, cache_hit: true },
      });
    }

    const body = await routeBody(services);

    expect(body.query_rewrite_failed_24h).toBe(256);
    expect(body.query_rewritten_24h).toBe(5);
    expect(body).not.toHaveProperty("query_rewrite_degraded_24h");
    expect(body.alerts).toContain("dream.health.rewrite_failing");
  });

  test("marks recovered query rewrite failures without stale rewrite alert", async () => {
    const services = makeServices();
    const log = new DispatchEventLog(services.db);
    const staleFailureTs = isoOffset(7 * 60 * 60 * 1000);
    const recentSuccessTs = isoOffset(5 * 60 * 1000);

    for (let i = 0; i < 15; i += 1) {
      log.record({
        handoff_id: `dream-cycle-recovered-fail-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_rewrite_failed",
        ts: staleFailureTs,
        meta: { model: "rewriter-a", reason: "timeout" },
      });
    }
    for (let i = 0; i < 10; i += 1) {
      log.record({
        handoff_id: `dream-cycle-recovered-success-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_rewritten",
        ts: recentSuccessTs,
        meta: { model: "rewriter-a", latency_ms: 123, cache_hit: false },
      });
    }
    recordSubsystemOutcome(services.db, {
      subsystem: "dream.query_rewrite",
      tier: "fallback",
      ok: false,
      ts: staleFailureTs,
      model: "rewriter-a",
      reason: "timeout",
    });
    recordSubsystemOutcome(services.db, {
      subsystem: "dream.query_rewrite",
      tier: "primary",
      ok: true,
      ts: recentSuccessTs,
      model: "rewriter-a",
    });

    const body = await routeBody(services);

    expect(body.query_rewrite_failed_24h).toBe(15);
    expect(body.query_rewrite_failed_recent).toBe(0);
    expect(body.query_rewrite_status).toBe("recovered");
    expect(body.alerts).not.toContain("dream.health.rewrite_failing");
  });

  test("alerts on currently failing query rewrites", async () => {
    const services = makeServices();
    const ts = isoOffset(5 * 60 * 1000);

    for (let i = 0; i < 3; i += 1) {
      services.dispatchEventLog.record({
        handoff_id: `dream-cycle-active-fail-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_rewrite_failed",
        ts,
        meta: { model: "rewriter-a", reason: "timeout" },
      });
      recordSubsystemOutcome(services.db, {
        subsystem: "dream.query_rewrite",
        tier: "fallback",
        ok: false,
        ts,
        model: "rewriter-a",
        reason: "timeout",
      });
    }

    const body = await routeBody(services);

    expect(body.query_rewrite_failed_recent).toBe(3);
    expect(body.query_rewrite_status).toBe("active_failure");
    expect(body.alerts).toContain("dream.health.rewrite_failing");
  });

  test("keeps a fresh rewrite regression visible inside an already-lit 24h window", async () => {
    const services = makeServices();
    const log = new DispatchEventLog(services.db);
    const staleFailureTs = isoOffset(7 * 60 * 60 * 1000);
    const recentSuccessTs = isoOffset(10 * 60 * 1000);
    const freshFailureTs = isoOffset(2 * 60 * 1000);

    for (let i = 0; i < 200; i += 1) {
      log.record({
        handoff_id: `dream-cycle-masked-fail-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_rewrite_failed",
        ts: staleFailureTs,
        meta: { model: "rewriter-a", reason: "timeout" },
      });
    }
    for (let i = 0; i < 10; i += 1) {
      log.record({
        handoff_id: `dream-cycle-masked-success-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_rewritten",
        ts: recentSuccessTs,
        meta: { model: "rewriter-a", latency_ms: 123, cache_hit: false },
      });
    }
    log.record({
      handoff_id: "dream-cycle-masked-fresh-fail",
      source: "daemon",
      kind: "dream_p4_query_rewrite_failed",
      ts: freshFailureTs,
      meta: { model: "rewriter-a", reason: "timeout" },
    });

    const body = await routeBody(services);

    expect(body.query_rewrite_failed_24h).toBe(201);
    expect(body.query_rewrite_failed_recent).toBe(1);
    expect(body.query_rewrite_status).toBe("active_failure");
    expect(body.alerts).toContain("dream.health.rewrite_failing");
  });

  test("uses recency for crashed cycle alerts", async () => {
    const services = makeServices();
    const now = Date.now();
    const staleCrashStartedAt = now - 7 * 60 * 60 * 1000;
    const completedStartedAt = now - 5 * 60 * 60 * 1000;

    for (let i = 0; i < 15; i += 1) {
      insertDreamCycle(services, {
        cycle_id: `stale-crash-${String(i)}`,
        started_at: staleCrashStartedAt + i,
        outcome: "crashed",
      });
    }
    for (let i = 0; i < 10; i += 1) {
      insertDreamCycle(services, {
        cycle_id: `recent-completed-${String(i)}`,
        started_at: completedStartedAt + i,
        outcome: "completed",
      });
    }

    const recovered = await routeBody(services);
    expect(recovered.cycles_crashed_24h).toBe(15);
    expect(recovered.cycles_crashed_recent).toBe(0);
    expect(recovered.cycles_crash_status).toBe("recovered");
    expect(recovered.alerts).not.toContain("dream.health.crashed_high");

    insertDreamCycle(services, {
      cycle_id: "fresh-crash",
      started_at: now - 2 * 60 * 1000,
      outcome: "crashed",
    });

    const active = await routeBody(services);
    expect(active.cycles_crashed_24h).toBe(16);
    expect(active.cycles_crashed_recent).toBe(1);
    expect(active.cycles_crash_status).toBe("active_failure");
    expect(active.alerts).toContain("dream.health.crashed_high");
  });

  test("surfaces query rewrite subsystem health details", async () => {
    const services = makeServices();
    services.dispatchEventLog.record({
      handoff_id: "dream-cycle-2",
      source: "daemon",
      kind: "dream_p4_query_rewrite_failed",
      ts: new Date().toISOString(),
      meta: { model: "rewriter-a", reason: "timeout" },
    });
    recordSubsystemOutcome(services.db, {
      subsystem: "dream.query_rewrite",
      tier: "fallback",
      ok: false,
      ts: "2026-08-18T12:00:00.000Z",
      seat: "rewrite-seat-a",
      model: "rewriter-a",
      reason: "timeout",
    });
    recordSubsystemOutcome(services.db, {
      subsystem: "dream.query_rewrite",
      tier: "fallback",
      ok: true,
      ts: "2026-08-18T12:05:00.000Z",
      seat: "rewrite-seat-a",
      model: "memory-title",
    });

    const body = await routeBody(services);

    expect(body.query_rewrite_failed_24h).toBe(1);
    expect(body.alerts).toContain("dream.health.rewrite_failing");
    expect(body.subsystem_health).toEqual({
      subsystem: "dream.query_rewrite",
      tier: "fallback",
      seat: "rewrite-seat-a",
      model: "memory-title",
      consecutive_failures: 1,
      last_success_ts: "2026-08-18T12:05:00.000Z",
      last_failure_ts: "2026-08-18T12:00:00.000Z",
      last_failure_reason: "timeout",
    });
  });
});

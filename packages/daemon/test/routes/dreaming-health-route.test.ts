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

import type { DreamConfig } from "@src/dreaming/config.js";
import { runDreamCycle } from "@src/dreaming/cycle.js";
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
  query_rewrite_rejected_24h: number;
  query_rewrite_rejected_recent: number;
  query_rewritten_24h: number;
  query_rewritten_recent: number;
  query_skipped_24h: number;
  query_skipped_recent: number;
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
    last_skip_ts: string | null;
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
    query_rewrite_rejected_24h: number;
    query_rewrite_rejected_recent: number;
    query_rewritten_24h: number;
    query_rewritten_recent: number;
    query_skipped_24h: number;
    query_skipped_recent: number;
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
      last_skip_ts: string | null;
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

type RewriterTestProject = {
  project_id: string;
  dreaming: { research_provider: string };
};

function makeRewriterProjectRegistry(projects: RewriterTestProject[]): {
  get: (id: string) => RewriterTestProject | null;
  list: () => RewriterTestProject[];
} {
  return {
    get: (id: string): RewriterTestProject | null =>
      projects.find((p) => p.project_id === id) ?? null,
    list: (): RewriterTestProject[] => projects,
  };
}

function rewriterCycleConfig(): DreamConfig {
  return {
    enabled: true,
    cronMinutes: 30,
    perCycleUsd: 1.0,
    dailyUsd: 100.0,
    curatorEnabled: false,
    pressureGuardEnabled: true,
    perCycleEmbeddingUsd: 0.1,
    perCycleResearchUsd: 0.25,
    linkAutoThreshold: 0.75,
    p1BatchSize: 10,
    t2PromotionMinEvents: 5,
    rewriterEnabled: true,
    rewriterBaseUrl: "http://127.0.0.1:7944",
    rewriterModel: "rewriter-a",
    rewriterTimeoutMs: 5000,
    rewriterCacheTtlMs: 30 * 24 * 60 * 60 * 1000,
    rewriterConcurrency: 4,
    skipPhases: new Set(["P1", "P2", "P3", "P5", "P6", "P7", "P8", "PC1", "PC2"]),
  };
}

function seedRewriterMemory(
  services: Services,
  opts: { project_id: string; title: string },
): string {
  const memoryId = crypto.randomUUID();
  const now = new Date().toISOString();
  services.db
    .prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, project_id)
       VALUES(?, 'test-user', 'knowledge', ?, ?, ?, 'body', ?, ?, ?)`,
    )
    .run(memoryId, now, now, opts.title, now, now, opts.project_id);
  return memoryId;
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
    for (let i = 0; i < 13; i += 1) {
      log.record({
        handoff_id: `dream-cycle-skip-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_skipped",
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
    log.record({
      handoff_id: "dream-cycle-cache-skip",
      source: "daemon",
      kind: "dream_p4_query_skipped",
      ts,
      meta: { model: "rewriter-a", latency_ms: 0, cache_hit: true },
    });

    const body = await routeBody(services);

    expect(body.query_rewrite_failed_24h).toBe(256);
    expect(body.query_rewritten_24h).toBe(5);
    expect(body.query_skipped_24h).toBe(13);
    expect(body.query_rewritten_recent).toBe(5);
    expect(body.query_skipped_recent).toBe(13);
    expect(body).not.toHaveProperty("query_rewrite_degraded_24h");
    expect(body.alerts).toContain("dream.health.rewrite_failing");
  });

  test("excludes skipped rewrites from the failure-rate denominator", async () => {
    const services = makeServices();
    const log = new DispatchEventLog(services.db);
    const ts = new Date().toISOString();
    for (let i = 0; i < 9; i += 1) {
      log.record({
        handoff_id: `dream-cycle-dilute-fail-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_rewrite_failed",
        ts,
        meta: { model: "rewriter-a", reason: "http_error", status: 503, cache_hit: false },
      });
    }
    log.record({
      handoff_id: "dream-cycle-dilute-success",
      source: "daemon",
      kind: "dream_p4_query_rewritten",
      ts,
      meta: { model: "rewriter-a", latency_ms: 123, cache_hit: false },
    });
    for (let i = 0; i < 90; i += 1) {
      log.record({
        handoff_id: `dream-cycle-dilute-skip-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_skipped",
        ts,
        meta: { model: "rewriter-a", latency_ms: 123, cache_hit: false },
      });
    }

    const body = await routeBody(services);

    expect(body.query_rewrite_failed_24h).toBe(9);
    expect(body.query_rewritten_24h).toBe(1);
    expect(body.query_skipped_24h).toBe(90);
    expect(body.alerts).toContain("dream.health.rewrite_failing");
    expect(body.alerts).not.toContain("dream.health.rewrite_unsearchable");
  });

  test("excludes skipped rewrites from the unsearchable-rate denominator", async () => {
    const services = makeServices();
    const log = new DispatchEventLog(services.db);
    const ts = new Date().toISOString();
    for (let i = 0; i < 9; i += 1) {
      log.record({
        handoff_id: `dream-cycle-dilute-reject-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_rejected_unsearchable",
        ts,
        meta: {
          stage: "post_rewrite",
          model: "rewriter-a",
          reason: "code_identifier",
          cache_hit: false,
        },
      });
    }
    log.record({
      handoff_id: "dream-cycle-dilute-reject-success",
      source: "daemon",
      kind: "dream_p4_query_rewritten",
      ts,
      meta: { model: "rewriter-a", latency_ms: 123, cache_hit: false },
    });
    for (let i = 0; i < 90; i += 1) {
      log.record({
        handoff_id: `dream-cycle-dilute-reject-skip-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_skipped",
        ts,
        meta: { model: "rewriter-a", latency_ms: 123, cache_hit: false },
      });
    }

    const body = await routeBody(services);

    expect(body.query_rewrite_rejected_24h).toBe(9);
    expect(body.query_rewritten_24h).toBe(1);
    expect(body.query_skipped_24h).toBe(90);
    expect(body.alerts).toContain("dream.health.rewrite_unsearchable");
    expect(body.alerts).not.toContain("dream.health.rewrite_failing");
  });

  test("query_rewrite_status still counts skipped rewrites as recent liveness", async () => {
    const services = makeServices();
    const log = new DispatchEventLog(services.db);
    log.record({
      handoff_id: "dream-cycle-status-stale-fail",
      source: "daemon",
      kind: "dream_p4_query_rewrite_failed",
      ts: isoOffset(7 * 60 * 60 * 1000),
      meta: { model: "rewriter-a", reason: "timeout" },
    });
    log.record({
      handoff_id: "dream-cycle-status-skip",
      source: "daemon",
      kind: "dream_p4_query_skipped",
      ts: isoOffset(5 * 60 * 1000),
      meta: { model: "rewriter-a", latency_ms: 123, cache_hit: false },
    });

    const body = await routeBody(services);

    expect(body.query_rewrite_status).toBe("recovered");
  });

  test("counts only post-rewrite unsearchable rejections and alerts without rewrite_failing", async () => {
    const services = makeServices();
    const log = new DispatchEventLog(services.db);
    const ts = new Date().toISOString();
    for (let i = 0; i < 12; i += 1) {
      log.record({
        handoff_id: `dream-cycle-post-reject-${String(i)}`,
        source: "daemon",
        kind: "dream_p4_query_rejected_unsearchable",
        ts,
        meta: {
          stage: "post_rewrite",
          model: "rewriter-a",
          reason: "code_identifier",
          cache_hit: false,
        },
      });
    }
    log.record({
      handoff_id: "dream-cycle-pre-reject",
      source: "daemon",
      kind: "dream_p4_query_rejected_unsearchable",
      ts,
      meta: { model: "memory-title", reason: "conventional_commit", cache_hit: false },
    });

    const body = await routeBody(services);

    expect(body.query_rewrite_failed_24h).toBe(0);
    expect(body.query_rewrite_failed_recent).toBe(0);
    expect(body.query_rewrite_rejected_24h).toBe(12);
    expect(body.query_rewrite_rejected_recent).toBe(12);
    expect(body.query_rewrite_status).toBe("unknown");
    expect(body.alerts).toContain("dream.health.rewrite_unsearchable");
    expect(body.alerts).not.toContain("dream.health.rewrite_failing");
    expect(body.subsystem_health).toBeNull();
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

  test("alerts no_recent_success when real skips land and a real failure follows through the cycle path", async () => {
    const services = makeServices();
    const projectId = "proj-route-skip-liveness";
    const projectRegistry = makeRewriterProjectRegistry([
      { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
    ]);
    seedRewriterMemory(services, {
      project_id: projectId,
      title: "How to keep this stable under high load",
    });

    await runDreamCycle(services.db, rewriterCycleConfig(), {
      projectRegistry,
      dispatchEventLog: services.dispatchEventLog,
      llmInvoke: () =>
        Promise.resolve({
          ok: true as const,
          value: { kind: "skip", reason: "too-internal" },
          raw: '{"kind":"skip","reason":"too-internal"}',
        }),
    });

    seedRewriterMemory(services, {
      project_id: projectId,
      title: "TypeScript strict null checks in async systems",
    });

    await runDreamCycle(services.db, rewriterCycleConfig(), {
      projectRegistry,
      dispatchEventLog: services.dispatchEventLog,
      llmInvoke: () =>
        Promise.resolve({
          ok: false as const,
          reason: "timeout" as const,
          failureMessage: "request timed out",
        }),
    });

    const body = await routeBody(services);

    expect(body.query_rewrite_failed_recent).toBe(1);
    expect(body.query_skipped_recent).toBe(1);
    expect(body.subsystem_health?.last_success_ts).toBeNull();
    expect(body.alerts).toContain("dream.health.rewrite_no_recent_success");
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
    // Five failures sit exactly at the min-sample floor, so the rate alert still fires.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      services.dispatchEventLog.record({
        handoff_id: `dream-cycle-${String(attempt)}`,
        source: "daemon",
        kind: "dream_p4_query_rewrite_failed",
        ts: new Date().toISOString(),
        meta: { model: "rewriter-a", reason: "timeout" },
      });
    }
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

    expect(body.query_rewrite_failed_24h).toBe(5);
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
      last_skip_ts: null,
    });
  });
});

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

import { dreamingHealthRoute } from "../../src/routes/dreaming.js";
import { recordSubsystemOutcome } from "../../src/services/subsystem-health.js";

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
  query_rewrite_failed_24h: number;
  query_rewritten_24h: number;
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
    query_rewrite_failed_24h: number;
    query_rewritten_24h: number;
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

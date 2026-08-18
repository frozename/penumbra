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
  query_rewrite_degraded_24h: number;
}> {
  const response = dreamingHealthRoute(new Request("http://x/dreaming/health"), services);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    alerts: string[];
    query_rewrite_failed_24h: number;
    query_rewritten_24h: number;
    query_rewrite_degraded_24h: number;
  };
}

describe("dreamingHealthRoute", () => {
  test("the served route surfaces dream.health.rewrite_failing in the HTTP body", async () => {
    const services = makeServices();
    new DispatchEventLog(services.db).record({
      handoff_id: "dream-cycle-1",
      source: "daemon",
      kind: "dream_p4_query_rewrite_failed",
      ts: new Date().toISOString(),
      meta: { model: "rewriter-a", reason: "http_error", status: 503 },
    });

    const body = await routeBody(services);

    expect(body.query_rewrite_failed_24h).toBe(1);
    expect(body.query_rewritten_24h).toBe(0);
    expect(body.query_rewrite_degraded_24h).toBe(0);
    expect(body.alerts).toContain("dream.health.rewrite_failing");
  });

  test("the alert does NOT clear merely because a degraded/fallback result was produced", async () => {
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
      ts: new Date().toISOString(),
      model: "rewriter-a",
      reason: "timeout",
    });
    recordSubsystemOutcome(services.db, {
      subsystem: "dream.query_rewrite",
      tier: "fallback",
      ok: true,
      ts: new Date().toISOString(),
      model: "memory-title",
    });

    const body = await routeBody(services);

    expect(body.query_rewrite_failed_24h).toBe(1);
    expect(body.alerts).toContain("dream.health.rewrite_failing");
  });
});

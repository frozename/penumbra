import { applySchema, loadSqliteVec } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { beforeAll, expect, it } from "bun:test";

import type { DreamConfig } from "../../src/dreaming/config.js";

import { isDreamSpendAffordable, runDreamCycle } from "../../src/dreaming/cycle.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

function openTestDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  return db;
}

function seedMemory(db: Database, body: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
     VALUES(?, 'test-user', 'feedback', ?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), now, now, "memory", body, now, now);
}

function testConfig(overrides?: Partial<DreamConfig>): DreamConfig {
  return {
    enabled: true,
    cronMinutes: 30,
    perCycleUsd: 1.0,
    dailyUsd: 100.0,
    pressureGuardEnabled: false,
    perCycleEmbeddingUsd: 0.1,
    perCycleResearchUsd: 0.25,
    linkAutoThreshold: 0.75,
    p1BatchSize: 10,
    curatorEnabled: false,
    contentQualityThreshold: 0.5,
    reembedBatchSize: 50,
    skipPhases: new Set<string>(),
    eventTriggerEnabled: false,
    idleMinutes: 10,
    triggerCooldownMinutes: 5,
    briefRefreshHours: 24,
    pc1BatchSize: 100,
    pc2MinClusterSize: 3,
    pc2ClusterLinkThreshold: 0.85,
    pc2AutoThreshold: 0.97,
    rewriterEnabled: false,
    rewriterBaseUrl: "http://127.0.0.1:7944",
    rewriterModel: "qwen-test",
    rewriterTimeoutMs: 1000,
    rewriterCacheTtlMs: 1000,
    rewriterConcurrency: 1,
    ...overrides,
  };
}

it("treats zero dream spend caps as disabled and enforces positive caps independently", () => {
  expect(
    isDreamSpendAffordable({
      perCycleUsd: 0,
      dailyUsd: 0,
      laneFraction: 0.65,
      cycleSpentLaneUsd: 999,
      dailySpentLaneUsd: 999,
      usd: 0.01,
    }),
  ).toBe(true);
  expect(
    isDreamSpendAffordable({
      perCycleUsd: 1,
      dailyUsd: 20,
      laneFraction: 0.65,
      cycleSpentLaneUsd: 0,
      dailySpentLaneUsd: 0,
      usd: 0.01,
    }),
  ).toBe(true);
  expect(
    isDreamSpendAffordable({
      perCycleUsd: 1,
      dailyUsd: 20,
      laneFraction: 0.65,
      cycleSpentLaneUsd: 0.65,
      dailySpentLaneUsd: 0,
      usd: 0.01,
    }),
  ).toBe(false);
  expect(
    isDreamSpendAffordable({
      perCycleUsd: 0,
      dailyUsd: 20,
      laneFraction: 0.25,
      cycleSpentLaneUsd: 999,
      dailySpentLaneUsd: 5.0,
      usd: 0.01,
    }),
  ).toBe(false);
  expect(
    isDreamSpendAffordable({
      perCycleUsd: 10,
      dailyUsd: 0,
      laneFraction: 0.5,
      cycleSpentLaneUsd: 0,
      dailySpentLaneUsd: 999,
      usd: 1,
    }),
  ).toBe(true);
  expect(
    isDreamSpendAffordable({
      perCycleUsd: 1,
      dailyUsd: 1,
      laneFraction: 0.5,
      cycleSpentLaneUsd: 1,
      dailySpentLaneUsd: 1,
      usd: 0,
    }),
  ).toBe(true);
  expect(
    isDreamSpendAffordable({
      perCycleUsd: 1,
      dailyUsd: 1,
      laneFraction: 0.5,
      cycleSpentLaneUsd: 1,
      dailySpentLaneUsd: 1,
      usd: -1,
    }),
  ).toBe(true);
});

it("records llm spend on dream_cycles and trips daily cap on the next cycle", async () => {
  const db = openTestDb();
  seedMemory(db, "quality scoring candidate");

  const scorer = {
    score: (): Promise<{
      verdict: "keep";
      composite: number;
      should_auto_retire: boolean;
      estimated_cost_usd: number;
    }> =>
      Promise.resolve({
        verdict: "keep" as const,
        composite: 0.4,
        should_auto_retire: false,
        estimated_cost_usd: 0.04,
      }),
  };

  const firstCycleId = await runDreamCycle(db, testConfig({ dailyUsd: 1 }), { scorer });
  const firstCycle = db
    .prepare(`SELECT llm_spent_usd FROM dream_cycles WHERE cycle_id=?`)
    .get(firstCycleId) as { llm_spent_usd: number };
  expect(firstCycle.llm_spent_usd).toBeGreaterThan(0);

  const secondCycleId = await runDreamCycle(
    db,
    testConfig({ dailyUsd: firstCycle.llm_spent_usd }),
    {
      scorer,
    },
  );
  const secondCycle = db
    .prepare(`SELECT outcome, bail_reason FROM dream_cycles WHERE cycle_id=?`)
    .get(secondCycleId) as { outcome: string; bail_reason: string | null };
  expect(secondCycle.outcome).toBe("bailed");
  expect(secondCycle.bail_reason ?? "").toMatch(/daily/i);
});

it("defers a phase when its per-phase budget would be exceeded and still completes the cycle", async () => {
  const db = openTestDb();
  seedMemory(db, "another quality scoring candidate");

  const scorer = {
    estimateCostUsd: (): number => 0.1,
    score: (): Promise<{
      verdict: "rewrite";
      composite: number;
      should_auto_retire: boolean;
      estimated_cost_usd: number;
    }> =>
      Promise.resolve({
        verdict: "rewrite" as const,
        composite: 0.91,
        should_auto_retire: false,
        estimated_cost_usd: 0.1,
      }),
  };

  const cycleId = await runDreamCycle(
    db,
    testConfig({
      perCycleUsd: 0.2,
      dailyUsd: 5,
      phaseBudgetFractions: { llm: 0.1, embedding: 0.45, research: 0.45 },
    }),
    { scorer },
  );

  const cycle = db
    .prepare(`SELECT outcome, phases_run FROM dream_cycles WHERE cycle_id=?`)
    .get(cycleId) as { outcome: string; phases_run: string };
  const phasesRun = JSON.parse(cycle.phases_run) as string[];

  expect(cycle.outcome).toBe("completed");
  expect(phasesRun).not.toContain("P3");
});

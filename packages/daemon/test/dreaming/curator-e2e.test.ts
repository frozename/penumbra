import { describe, it, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema, loadSqliteVec } from "@penumbra/core";
import { runDreamCycle } from "../../src/dreaming/cycle.js";
import { revertDreamAction } from "../../src/dreaming/reembed.js";
import type { DreamConfig } from "../../src/dreaming/config.js";

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

function makeConfig(overrides?: Partial<DreamConfig>): DreamConfig {
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
    reembedBatchSize: 100,
    skipPhases: new Set<string>(),
    eventTriggerEnabled: true,
    idleMinutes: 15,
    triggerCooldownMinutes: 5,
    briefRefreshHours: 24,
    pc1BatchSize: 100,
    pc2MinClusterSize: 3,
    pc2ClusterLinkThreshold: 0.85,
    pc2AutoThreshold: 2.0,
    contentQualityThreshold: 0.5,
    curatorEnabled: true,
    ...overrides,
  } as DreamConfig;
}

function openTestDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  return db;
}

describe("curator e2e", () => {
  it("runDreamCycle skips PC phases when curatorEnabled=false", async () => {
    const db = openTestDb();
    // Seed an obvious-junk t2 (UUID body) that PC1 WOULD retire if enabled.
    const memId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id,user_id,kind,window_start,window_end,title,body,created_at,updated_at)
       VALUES(?, 'u', 'promoted', ?, ?, 't', '429c79cc-6240-43bb-bd97-4ef675382c35', ?, ?)`,
    ).run(memId, nowIso, nowIso, nowIso, nowIso);

    await runDreamCycle(db, makeConfig({ curatorEnabled: false }));

    const phases = (
      db
        .prepare(`SELECT phases_run FROM dream_cycles ORDER BY started_at DESC LIMIT 1`)
        .get() as any
    ).phases_run;
    const arr = JSON.parse(phases) as string[];
    expect(arr).not.toContain("PC1");
    expect(arr).not.toContain("PC2");
    const action = db
      .prepare(`SELECT * FROM dream_actions WHERE action_type='ephemera_retire'`)
      .get();
    expect(action).toBeNull();
  });

  it("full dream cycle with curatorEnabled=true produces PC1 ephemera_retire", async () => {
    const db = openTestDb();
    const memId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id,user_id,kind,window_start,window_end,title,body,created_at,updated_at)
       VALUES(?, 'u', 'promoted', ?, ?, 't', '429c79cc-6240-43bb-bd97-4ef675382c35', ?, ?)`,
    ).run(memId, nowIso, nowIso, nowIso, nowIso);

    await runDreamCycle(db, makeConfig({ curatorEnabled: true }));

    const row = db
      .prepare(`SELECT phases_run FROM dream_cycles ORDER BY started_at DESC LIMIT 1`)
      .get() as any;
    const arr = JSON.parse(row.phases_run) as string[];
    expect(arr).toContain("PC1");
    expect(arr).toContain("PC2");
    const action = db
      .prepare(
        `SELECT * FROM dream_actions WHERE action_type='ephemera_retire' AND status='auto_applied'`,
      )
      .get();
    expect(action).toBeDefined();
    const mem = db
      .prepare(`SELECT retired_at FROM t2_memories WHERE memory_id=?`)
      .get(memId) as any;
    expect(mem.retired_at).toBeTruthy();
  });

  it("revert ephemera_retire un-retires the memory", async () => {
    const db = openTestDb();
    const memId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id,user_id,kind,window_start,window_end,title,body,created_at,updated_at)
       VALUES(?, 'u', 'promoted', ?, ?, 't', '429c79cc-6240-43bb-bd97-4ef675382c35', ?, ?)`,
    ).run(memId, nowIso, nowIso, nowIso, nowIso);

    await runDreamCycle(db, makeConfig({ curatorEnabled: true }));
    const action = db
      .prepare(`SELECT action_id FROM dream_actions WHERE action_type='ephemera_retire' LIMIT 1`)
      .get() as any;
    expect(action).toBeDefined();

    revertDreamAction(db, action.action_id, "none");
    const mem = db
      .prepare(`SELECT retired_at FROM t2_memories WHERE memory_id=?`)
      .get(memId) as any;
    expect(mem.retired_at).toBeNull();
  });
});

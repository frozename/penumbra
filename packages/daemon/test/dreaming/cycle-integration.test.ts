import { expect, it, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec, applySchema } from "@penumbra/core";
import { runDreamCycle } from "../../src/dreaming/cycle.js";
import { makeFakeJudgePool } from "../../src/dreaming/judge-pool.js";
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

function openTestDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  return db;
}

function testConfig(overrides?: Partial<DreamConfig>): DreamConfig {
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
    ...overrides,
  };
}

function seedUnpromotedRollups(db: Database, n: number): void {
  const excerpt =
    "This prompt excerpt is intentionally long enough to pass the P1 minimum-length gate.";
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events, first_prompt_excerpt)
       VALUES(?, 'test-user', ?, '2026-01-01T00:00:00Z', 1, ?)`,
    ).run(`R${i + 1}`, `session-${i + 1}`, excerpt);
  }
}

it("P1 with REAL judge produces well-formed dream_actions rows (no parse failure)", async () => {
  const db = openTestDb();
  seedUnpromotedRollups(db, 2);
  const realJudge = makeFakeJudgePool([{ promote: true, confidence: 1 }]);
  const cycleId = await runDreamCycle(db, testConfig(), { judgePool: realJudge });
  const actions = db.prepare(`SELECT * FROM dream_actions WHERE phase='P1'`).all() as Array<{
    status: string;
    confidence: number;
    target_ids: string;
  }>;
  expect(actions.length).toBeGreaterThanOrEqual(1);
  for (const a of actions) {
    expect(["queued", "auto_applied"]).toContain(a.status);
    expect(a.confidence).toBeGreaterThanOrEqual(0);
    expect(a.confidence).toBeLessThanOrEqual(1);
    // target_ids must be valid JSON array
    expect(() => JSON.parse(a.target_ids)).not.toThrow();
  }
});

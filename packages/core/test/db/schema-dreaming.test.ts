import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";

import { applySchema, releaseT1RollupClaims, runStartupZombieSweep } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

interface ColumnInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface DreamCycleRow {
  outcome: string | null;
  ended_at: number | null;
  llm_spent_usd: number;
  embedding_spent_usd: number;
  research_spent_usd: number;
  project_id: string | null;
  last_phase_completed: string | null;
}

interface IndexSchemaRow {
  sql: string;
}

interface PromotionFieldsRow {
  promotion_skipped_at: string | null;
  promotion_filtered_at: string | null;
}

interface CycleStateRow {
  outcome: string;
  bail_reason: string | null;
}

interface CountRow {
  n: number;
}

function openTestDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  db.prepare(
    `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events)
     VALUES('R1','u1','s1','2026-01-01T00:00:00Z',1)`,
  ).run();
  return db;
}

function seedCycleAndMemories(db: Database): void {
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id,started_at,trigger,budget_usd_cap) VALUES('C1',1,'cron',0.5)`,
  ).run();
  const now = new Date().toISOString();
  for (const id of ["M1", "M2"]) {
    db.prepare(
      `INSERT INTO t2_memories(memory_id,user_id,kind,window_start,window_end,title,body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(id, "u1", "feedback", now, now, "title", "body", now, now);
  }
}

function tableColumnNames(db: Database, table: string): string[] {
  return db
    .prepare<ColumnInfoRow, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

it("five new tables exist after applySchema", () => {
  const db = openTestDb();
  for (const tbl of [
    "dream_cycles",
    "dream_actions",
    "memory_links",
    "t2_vec_history",
    "dream_research_cache",
  ]) {
    expect(db.prepare(`SELECT 1 FROM ${tbl} LIMIT 1`).all()).toBeDefined();
  }
});

it("dream_cycles: outcome defaults 'running', ended_at nullable, split cost buckets, project_id nullable, last_phase_completed nullable", () => {
  const db = openTestDb();
  const row = db
    .prepare<
      DreamCycleRow,
      [string, number, string, number]
    >("INSERT INTO dream_cycles(cycle_id,started_at,trigger,budget_usd_cap) VALUES(?,?,?,?) RETURNING *")
    .get("c1", Date.now(), "cron", 0.5);
  expect(row?.outcome).toBe("running");
  expect(row?.ended_at).toBeNull();
  expect(row?.llm_spent_usd).toBe(0);
  expect(row?.embedding_spent_usd).toBe(0);
  expect(row?.research_spent_usd).toBe(0);
  expect(row?.project_id).toBeNull();
  expect(row?.last_phase_completed).toBeNull();
});

it("dream_actions: status is sole state field; untrusted_source, expires_at, reverted_by present; NO auto_applied column", () => {
  const db = openTestDb();
  const cols = tableColumnNames(db, "dream_actions");
  expect(cols).toContain("untrusted_source");
  expect(cols).toContain("expires_at");
  expect(cols).toContain("reverted_by");
  expect(cols).not.toContain("auto_applied");
  expect(cols).toContain("status");
});

it("dream_actions has queued link target index", () => {
  const db = openTestDb();
  const row = db
    .prepare<
      IndexSchemaRow,
      []
    >("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_dream_actions_queued_link_target'")
    .get();
  expect(row?.sql).toContain(
    "CREATE INDEX idx_dream_actions_queued_link_target ON dream_actions(target_ids) WHERE action_type = 'link' AND status = 'queued'",
  );
});

it("memory_links UNIQUE(src_id, dst_id, link_type) prevents duplicate edges from concurrent cycles", () => {
  const db = openTestDb();
  seedCycleAndMemories(db);
  db.prepare(
    `INSERT INTO memory_links(link_id,src_id,dst_id,link_type,weight,minted_at,minted_by_cycle) VALUES('L1','M1','M2','semantic_near',0.9,1,'C1')`,
  ).run();
  expect(() =>
    db
      .prepare(
        `INSERT INTO memory_links(link_id,src_id,dst_id,link_type,weight,minted_at,minted_by_cycle) VALUES('L2','M1','M2','semantic_near',0.8,2,'C1')`,
      )
      .run(),
  ).toThrow();
});

it("t1_rollups gains claimed_at, claimed_by_cycle, embedding_model_version, promotion_filtered_at; t2_memories gains embedding_model_version", () => {
  const db = openTestDb();
  const t1cols = tableColumnNames(db, "t1_rollups");
  const t2cols = tableColumnNames(db, "t2_memories");
  expect(t1cols).toContain("claimed_at");
  expect(t1cols).toContain("claimed_by_cycle");
  expect(t1cols).toContain("embedding_model_version");
  expect(t1cols).toContain("promotion_filtered_at");
  expect(t2cols).toContain("embedding_model_version");
});

it("promotion_filtered_at migration preserves legacy promotion_skipped_at values and is idempotent", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  db.run(`
    CREATE TABLE t1_rollups (
      rollup_id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      n_events INTEGER NOT NULL,
      lane_breakdown_json TEXT NOT NULL DEFAULT '{}',
      provider_breakdown_json TEXT NOT NULL DEFAULT '{}',
      cost_usd_total REAL,
      tokens_in_total INTEGER,
      tokens_out_total INTEGER,
      first_prompt_excerpt TEXT,
      last_response_excerpt TEXT,
      tool_calls_summary TEXT,
      source_event_ids TEXT NOT NULL DEFAULT '[]',
      t2_promoted_at TEXT,
      failed_promotion_attempts INTEGER NOT NULL DEFAULT 0,
      promotion_skipped_at TEXT
    );
    INSERT INTO t1_rollups(
      rollup_id, user_id, session_id, started_at, n_events, promotion_skipped_at
    ) VALUES (
      'r1', 'u1', 's1', '2026-01-01T00:00:00Z', 1, '2026-02-02T03:04:05.000Z'
    );
  `);

  applySchema(db, { embeddingDim: 384 });

  let cols = tableColumnNames(db, "t1_rollups");
  expect(cols).toContain("promotion_filtered_at");

  let row = db
    .prepare<
      PromotionFieldsRow,
      []
    >("SELECT promotion_skipped_at, promotion_filtered_at FROM t1_rollups WHERE rollup_id = 'r1'")
    .get();
  expect(row?.promotion_skipped_at).toBe("2026-02-02T03:04:05.000Z");
  expect(row?.promotion_filtered_at).toBe("2026-02-02T03:04:05.000Z");

  applySchema(db, { embeddingDim: 384 });
  cols = tableColumnNames(db, "t1_rollups");
  expect(cols.filter((name) => name === "promotion_filtered_at")).toHaveLength(1);
  row = db
    .prepare<
      PromotionFieldsRow,
      []
    >("SELECT promotion_skipped_at, promotion_filtered_at FROM t1_rollups WHERE rollup_id = 'r1'")
    .get();
  expect(row?.promotion_filtered_at).toBe("2026-02-02T03:04:05.000Z");
});

it("startup zombie sweep marks outcome='running' rows as 'crashed' and clears claimed_at", () => {
  const db = openTestDb();
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id,started_at,trigger,budget_usd_cap) VALUES('zombie',1,'cron',0.5)`,
  ).run();
  db.prepare(
    `UPDATE t1_rollups SET claimed_by_cycle='zombie', claimed_at=1 WHERE rowid=(SELECT rowid FROM t1_rollups LIMIT 1)`,
  ).run();
  runStartupZombieSweep(db);
  const cycle = db
    .prepare<
      CycleStateRow,
      []
    >(`SELECT outcome, bail_reason FROM dream_cycles WHERE cycle_id='zombie'`)
    .get();
  expect(cycle?.outcome).toBe("crashed");
  expect(cycle?.bail_reason).toMatch(/daemon_respawn/i);
  const claimed = db
    .prepare<CountRow, []>(`SELECT COUNT(*) as n FROM t1_rollups WHERE claimed_at IS NOT NULL`)
    .get();
  expect(claimed?.n).toBe(0);
});

it("shared claim reset path releases terminal-cycle and stale leases", () => {
  const db = openTestDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id,started_at,ended_at,trigger,budget_usd_cap,outcome,phases_run)
     VALUES
       ('done', ?, ?, 'cron', 0.5, 'completed', '["P0","P1"]'),
       ('running-keep', ?, NULL, 'cron', 0.5, 'running', '["P0"]')`,
  ).run(now - 10_000, now - 5_000, now - 2_000);
  db.prepare(
    `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events, claimed_at, claimed_by_cycle)
     VALUES
       ('terminal', 'u1', 's-terminal', '2026-01-01T00:00:00Z', 1, ?, 'done'),
       ('stale', 'u1', 's-stale', '2026-01-01T00:00:00Z', 1, ?, 'running-keep'),
       ('fresh', 'u1', 's-fresh', '2026-01-01T00:00:00Z', 1, ?, 'running-keep')`,
  ).run(now - 1_000, now - 5_000, now - 200);

  const released = releaseT1RollupClaims(db, {
    terminalOutcomes: ["completed"],
    staleBeforeMs: now - 1_000,
  });
  expect(released).toBeGreaterThanOrEqual(2);

  const rows = db
    .prepare<
      { rollup_id: string; claimed_by_cycle: string | null },
      []
    >(`SELECT rollup_id, claimed_by_cycle FROM t1_rollups WHERE rollup_id IN ('terminal','stale','fresh') ORDER BY rollup_id`)
    .all();
  expect(rows).toEqual([
    { rollup_id: "fresh", claimed_by_cycle: "running-keep" },
    { rollup_id: "stale", claimed_by_cycle: null },
    { rollup_id: "terminal", claimed_by_cycle: null },
  ]);
});

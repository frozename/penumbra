import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { applySchema, runStartupZombieSweep } from "../../src/db/schema.js";

async function openTestDb(): Promise<Database> {
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

it("five new tables exist after applySchema", async () => {
  const db = await openTestDb();
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

it("dream_cycles: outcome defaults 'running', ended_at nullable, split cost buckets, project_id nullable, last_phase_completed nullable", async () => {
  const db = await openTestDb();
  const row = db
    .prepare(
      "INSERT INTO dream_cycles(cycle_id,started_at,trigger,budget_usd_cap) VALUES(?,?,?,?) RETURNING *",
    )
    .get("c1", Date.now(), "cron", 0.5) as any;
  expect(row.outcome).toBe("running");
  expect(row.ended_at).toBeNull();
  expect(row.llm_spent_usd).toBe(0);
  expect(row.embedding_spent_usd).toBe(0);
  expect(row.research_spent_usd).toBe(0);
  expect(row.project_id).toBeNull();
  expect(row.last_phase_completed).toBeNull();
});

it("dream_actions: status is sole state field; untrusted_source, expires_at, reverted_by present; NO auto_applied column", async () => {
  const db = await openTestDb();
  const cols = db
    .prepare("PRAGMA table_info(dream_actions)")
    .all()
    .map((r: any) => r.name);
  expect(cols).toContain("untrusted_source");
  expect(cols).toContain("expires_at");
  expect(cols).toContain("reverted_by");
  expect(cols).not.toContain("auto_applied");
  expect(cols).toContain("status");
});

it("memory_links UNIQUE(src_id, dst_id, link_type) prevents duplicate edges from concurrent cycles", async () => {
  const db = await openTestDb();
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

it("t1_rollups gains claimed_at, claimed_by_cycle, embedding_model_version; t2_memories gains embedding_model_version", async () => {
  const db = await openTestDb();
  const t1cols = db
    .prepare("PRAGMA table_info(t1_rollups)")
    .all()
    .map((r: any) => r.name);
  const t2cols = db
    .prepare("PRAGMA table_info(t2_memories)")
    .all()
    .map((r: any) => r.name);
  expect(t1cols).toContain("claimed_at");
  expect(t1cols).toContain("claimed_by_cycle");
  expect(t1cols).toContain("embedding_model_version");
  expect(t2cols).toContain("embedding_model_version");
});

it("startup zombie sweep marks outcome='running' rows as 'crashed' and clears claimed_at", async () => {
  const db = await openTestDb();
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id,started_at,trigger,budget_usd_cap) VALUES('zombie',1,'cron',0.5)`,
  ).run();
  db.prepare(
    `UPDATE t1_rollups SET claimed_by_cycle='zombie', claimed_at=1 WHERE rowid=(SELECT rowid FROM t1_rollups LIMIT 1)`,
  ).run();
  runStartupZombieSweep(db);
  const cycle = db
    .prepare(`SELECT outcome, bail_reason FROM dream_cycles WHERE cycle_id='zombie'`)
    .get() as any;
  expect(cycle.outcome).toBe("crashed");
  expect(cycle.bail_reason).toMatch(/daemon_respawn/i);
  const claimed = db
    .prepare(`SELECT COUNT(*) as n FROM t1_rollups WHERE claimed_at IS NOT NULL`)
    .get() as any;
  expect(claimed.n).toBe(0);
});

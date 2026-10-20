import { applySchema, loadSqliteVec, T2Promotion } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import type { DreamConfig } from "@src/dreaming/config.js";
import { runDreamCycle } from "@src/dreaming/cycle.js";
import { makeFakeJudgePool } from "@src/dreaming/judge-pool.js";
import { revertDreamAction } from "@src/dreaming/reembed.js";

interface RollupPromotedRow {
  t2_promoted_at: string | null;
}

interface RollupClaimRow {
  t2_promoted_at: string | null;
  promotion_filtered_at: string | null;
  claimed_by_cycle: string | null;
}

interface MemoryRetiredRow {
  retired_at: number | null;
}

interface ActionRevertedRow {
  reverted_by: string | null;
}

interface LinkRetiredRow {
  retired_at: number | null;
}

interface ProjectBriefGeneratedAtRow {
  generated_at: number;
}

interface RowidRow {
  rowid: number;
}

interface VectorRow {
  embedding: Uint8Array;
}

interface EmbeddingVersionRow {
  embedding_model_version: string;
}

function getTestDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  // Ensure dreaming runtime columns exist (mirrors cycle.ts P0 migration)
  try {
    db.run("ALTER TABLE t2_memories ADD COLUMN retired_at INTEGER");
  } catch {
    /* already present */
  }
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
       VALUES('cycle-test', 0, 'cron', 10, 'running', '[]')`,
  ).run();
  return db;
}

function seedAction(
  db: Database,
  opts: {
    action_id: string;
    phase: string;
    action_type: string;
    status: string;
    target_ids: string[];
    payload: Record<string, unknown>;
    decided_at?: number;
  },
): void {
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json, decided_at)
     VALUES(?, 'cycle-test', ?, ?, 1.0, ?, ?, ?, ?)`,
  ).run(
    opts.action_id,
    opts.phase,
    opts.action_type,
    opts.status,
    JSON.stringify(opts.target_ids),
    JSON.stringify(opts.payload),
    opts.decided_at ?? Date.now(),
  );
}

function seedMemory(
  db: Database,
  opts: { memory_id: string; body?: string; retired_at?: number | null },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
     VALUES(?, 'system', 'promoted', ?, ?, 'title', ?, ?, ?)`,
  ).run(opts.memory_id, now, now, opts.body ?? "body-text", now, now);
  if (opts.retired_at !== undefined && opts.retired_at !== null) {
    db.prepare("UPDATE t2_memories SET retired_at = ? WHERE memory_id = ?").run(
      opts.retired_at,
      opts.memory_id,
    );
  }
}

function getRetired(db: Database, memId: string): MemoryRetiredRow {
  return db
    .prepare("SELECT retired_at FROM t2_memories WHERE memory_id = ?")
    .get(memId) as MemoryRetiredRow;
}

function getRevertedBy(db: Database, actionId: string): ActionRevertedRow {
  return db
    .prepare("SELECT reverted_by FROM dream_actions WHERE action_id = ?")
    .get(actionId) as ActionRevertedRow;
}

// File-local typed factory for DreamConfig stubs: runDreamCycle consumes only a
// small subset (spend caps, p1BatchSize, autoPromoteMinJudges, skipPhases), so
// hand-stubbing every env-derived field would dwarf the test bodies. ONE
// documented `as unknown as` per the strict-bar helper rule.
function makeCycleConfig(extra: Partial<DreamConfig> = {}): DreamConfig {
  return {
    enabled: true,
    cronMinutes: 30,
    perCycleUsd: 1.0,
    dailyUsd: 100.0,
    curatorEnabled: false,
    pressureGuardEnabled: false,
    perCycleEmbeddingUsd: 0.1,
    perCycleResearchUsd: 0.25,
    linkAutoThreshold: 0.75,
    p1BatchSize: 10,
    autoPromoteMinJudges: 1,
    reembedBatchSize: 100,
    rewriterEnabled: false,
    rewriterBaseUrl: "http://127.0.0.1:7944",
    rewriterModel: "stub-model",
    rewriterTimeoutMs: 5000,
    rewriterCacheTtlMs: 30 * 24 * 60 * 60 * 1000,
    rewriterConcurrency: 4,
    skipPhases: new Set<string>(),
    ...extra,
  } as unknown as DreamConfig;
}

// P7 is env-gated; a stray PENUMBRA_T2_REEMBED_ENABLED would let the cycle
// re-embed the seeded memory and add noise rows under the assertions.
async function withReembedDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PENUMBRA_T2_REEMBED_ENABLED;
  delete process.env.PENUMBRA_T2_REEMBED_ENABLED;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PENUMBRA_T2_REEMBED_ENABLED;
    else process.env.PENUMBRA_T2_REEMBED_ENABLED = prev;
  }
}

const PROMOTABLE_EXCERPT =
  "durable decision about rollout ordering and dispatch backoff policy for handoffs";

function seedPromotedRollup(
  db: Database,
  opts: { rollupId: string; t2MemoryId: string; actionId: string },
): void {
  db.prepare(
    `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, ended_at, n_events, first_prompt_excerpt, t2_promoted_at)
     VALUES(?, 'system', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 6, ?, ?)`,
  ).run(opts.rollupId, crypto.randomUUID(), PROMOTABLE_EXCERPT, new Date().toISOString());
  seedMemory(db, { memory_id: opts.t2MemoryId });
  seedAction(db, {
    action_id: opts.actionId,
    phase: "P1",
    action_type: "promote_t1",
    status: "auto_applied",
    target_ids: [opts.rollupId],
    payload: { t2_memory_id: opts.t2MemoryId, votes: [] },
  });
}

function getRollupClaimRow(db: Database, rollupId: string): RollupClaimRow {
  return db
    .prepare(
      "SELECT t2_promoted_at, promotion_filtered_at, claimed_by_cycle FROM t1_rollups WHERE rollup_id = ?",
    )
    .get(rollupId) as RollupClaimRow;
}

function countPromoteActions(db: Database, rollupId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM dream_actions
         WHERE phase='P1' AND action_type='promote_t1' AND target_ids=?`,
      )
      .get(JSON.stringify([rollupId])) as { n: number }
  ).n;
}

function makeT2Promotion(db: Database): T2Promotion {
  return new T2Promotion({
    db,
    embedder: { name: "stub", dim: 384, embed: () => Promise.resolve([]) },
    clock: () => new Date(),
    uuid: () => crypto.randomUUID(),
    llm: () => Promise.resolve([]),
  });
}

function runPromoteVotingCycle(db: Database): Promise<string> {
  return withReembedDisabled(() =>
    runDreamCycle(db, makeCycleConfig(), {
      judgePool: makeFakeJudgePool([{ promote: true, confidence: 0.9 }]),
      onReembed: () => Promise.resolve(new Float32Array(384).fill(0.01)),
    }),
  );
}

describe("revertDreamAction — per-phase compensation", () => {
  let db: Database;

  beforeEach(() => {
    db = getTestDb();
  });

  // ── P1 ──────────────────────────────────────────────────────────────────

  it("P1 revert: clears t2_promoted_at on rollup and retires the t2 memory", () => {
    const rollupId = crypto.randomUUID();
    const t2MemoryId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, ended_at, n_events, first_prompt_excerpt, t2_promoted_at)
       VALUES(?, 'system', ?, ?, ?, 0, 'excerpt-text', ?)`,
    ).run(rollupId, crypto.randomUUID(), now, now, now);

    seedMemory(db, { memory_id: t2MemoryId });

    seedAction(db, {
      action_id: "p1-action",
      phase: "P1",
      action_type: "promote_t1",
      status: "auto_applied",
      target_ids: [rollupId],
      payload: { t2_memory_id: t2MemoryId, votes: [] },
    });

    revertDreamAction(db, "p1-action", "none");

    const rollup = db
      .prepare("SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id = ?")
      .get(rollupId) as RollupPromotedRow;
    expect(rollup.t2_promoted_at).toBeNull();

    const mem = getRetired(db, t2MemoryId);
    expect(mem.retired_at).not.toBeNull();

    const action = getRevertedBy(db, "p1-action");
    expect(action.reverted_by).toBe("user");
  });

  it("P1 revert: retires EXACT t2_memory_id even if another memory has same body", () => {
    const rollupId = crypto.randomUUID();
    const targetMemId = crypto.randomUUID();
    const decoyMemId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, ended_at, n_events, first_prompt_excerpt, t2_promoted_at)
       VALUES(?, 'system', ?, ?, ?, 0, 'shared-body', ?)`,
    ).run(rollupId, crypto.randomUUID(), now, now, now);

    seedMemory(db, { memory_id: targetMemId, body: "shared-body" });
    seedMemory(db, { memory_id: decoyMemId, body: "shared-body" });

    seedAction(db, {
      action_id: "p1-action-exact",
      phase: "P1",
      action_type: "promote_t1",
      status: "auto_applied",
      target_ids: [rollupId],
      payload: { t2_memory_id: targetMemId, votes: [] },
    });

    revertDreamAction(db, "p1-action-exact", "none");

    const targetMem = getRetired(db, targetMemId);
    expect(targetMem.retired_at).not.toBeNull();

    const decoyMem = getRetired(db, decoyMemId);
    expect(decoyMem.retired_at).toBeNull();
  });

  it("P1 revert: throws if payload is missing t2_memory_id", () => {
    seedAction(db, {
      action_id: "p1-action-missing",
      phase: "P1",
      action_type: "promote_t1",
      status: "auto_applied",
      target_ids: ["some-rollup"],
      payload: { votes: [] },
    });
    expect(() => {
      revertDreamAction(db, "p1-action-missing", "none");
    }).toThrow("p1_revert_missing_t2_memory_id");
  });

  it("P1 revert: stamps promotion_filtered_at on the rollup", () => {
    const rollupId = crypto.randomUUID();
    const t2MemoryId = crypto.randomUUID();

    seedPromotedRollup(db, { rollupId, t2MemoryId, actionId: "p1-action-filtered" });

    revertDreamAction(db, "p1-action-filtered", "none");

    const rollup = getRollupClaimRow(db, rollupId);
    expect(rollup.t2_promoted_at).toBeNull();
    // Same ISO-8601 format cycle.ts writes for judged-NO rollups.
    expect(rollup.promotion_filtered_at).not.toBeNull();
    expect(Number.isNaN(Date.parse(rollup.promotion_filtered_at!))).toBe(false);

    const mem = getRetired(db, t2MemoryId);
    expect(mem.retired_at).not.toBeNull();

    const action = getRevertedBy(db, "p1-action-filtered");
    expect(action.reverted_by).toBe("user");
  });

  it("P1 revert: the next dream cycle cannot re-claim or re-mint the rollup", async () => {
    const rollupId = crypto.randomUUID();
    const t2MemoryId = crypto.randomUUID();

    seedPromotedRollup(db, { rollupId, t2MemoryId, actionId: "p1-action-reclaim" });
    revertDreamAction(db, "p1-action-reclaim", "none");

    const cycleId = await runPromoteVotingCycle(db);

    const cycle = db
      .prepare("SELECT outcome FROM dream_cycles WHERE cycle_id = ?")
      .get(cycleId) as { outcome: string };
    expect(cycle.outcome).toBe("completed");

    const rollup = getRollupClaimRow(db, rollupId);
    expect(rollup.claimed_by_cycle).toBeNull();
    expect(rollup.t2_promoted_at).toBeNull();
    expect(countPromoteActions(db, rollupId)).toBe(1);

    const memoryCount = db.prepare("SELECT COUNT(*) AS n FROM t2_memories").get() as { n: number };
    expect(memoryCount.n).toBe(1);

    // The T2-extraction claim path filters on the same column.
    expect(makeT2Promotion(db).detectEligibleRollups(1, new Date())).not.toContain(rollupId);
  });

  it("P1 revert: resetPromotionFilter re-arms the rollup for the next cycle", async () => {
    const rollupId = crypto.randomUUID();
    const t2MemoryId = crypto.randomUUID();

    seedPromotedRollup(db, { rollupId, t2MemoryId, actionId: "p1-action-rearm" });
    revertDreamAction(db, "p1-action-rearm", "none");

    makeT2Promotion(db).resetPromotionFilter(rollupId);
    expect(makeT2Promotion(db).detectEligibleRollups(1, new Date())).toContain(rollupId);

    const cycleId = await runPromoteVotingCycle(db);

    const cycle = db
      .prepare("SELECT outcome FROM dream_cycles WHERE cycle_id = ?")
      .get(cycleId) as { outcome: string };
    expect(cycle.outcome).toBe("completed");

    const rollup = getRollupClaimRow(db, rollupId);
    expect(rollup.claimed_by_cycle).toBe(cycleId);
    expect(rollup.t2_promoted_at).not.toBeNull();

    const actions = db
      .prepare(
        `SELECT action_id, status, reverted_by FROM dream_actions
         WHERE phase='P1' AND action_type='promote_t1' AND target_ids=?
         ORDER BY rowid`,
      )
      .all(JSON.stringify([rollupId])) as {
      action_id: string;
      status: string;
      reverted_by: string | null;
    }[];
    expect(actions).toHaveLength(2);
    const rePromote = actions.find((a) => a.action_id !== "p1-action-rearm");
    expect(rePromote?.status).toBe("auto_applied");
    expect(rePromote?.reverted_by).toBeNull();

    const liveMemoryCount = db
      .prepare("SELECT COUNT(*) AS n FROM t2_memories WHERE retired_at IS NULL")
      .get() as { n: number };
    expect(liveMemoryCount.n).toBe(1);
  });

  // ── P2 ──────────────────────────────────────────────────────────────────

  it("P2 revert: sets retired_at on the matching memory_link", () => {
    const srcId = crypto.randomUUID();
    const dstId = crypto.randomUUID();

    seedMemory(db, { memory_id: srcId });
    seedMemory(db, { memory_id: dstId });

    db.prepare(
      `INSERT INTO memory_links(link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle)
       VALUES(?, ?, ?, 'semantic_near', 0.9, ?, 'cycle-test')`,
    ).run(crypto.randomUUID(), srcId, dstId, Date.now());

    seedAction(db, {
      action_id: "p2-action",
      phase: "P2",
      action_type: "link",
      status: "auto_applied",
      target_ids: [srcId, dstId],
      payload: { link_type: "semantic_near" },
    });

    revertDreamAction(db, "p2-action", "none");

    const link = db
      .prepare("SELECT retired_at FROM memory_links WHERE src_id = ? AND dst_id = ?")
      .get(srcId, dstId) as LinkRetiredRow;
    expect(link.retired_at).not.toBeNull();

    const action = getRevertedBy(db, "p2-action");
    expect(action.reverted_by).toBe("user");
  });

  // ── P3 retire ────────────────────────────────────────────────────────────

  it("P3 retire revert: clears retired_at on the memory", () => {
    const memId = crypto.randomUUID();
    seedMemory(db, { memory_id: memId, retired_at: Date.now() - 1000 });

    const mem0 = getRetired(db, memId);
    expect(mem0.retired_at).not.toBeNull();

    seedAction(db, {
      action_id: "p3-retire-action",
      phase: "P3",
      action_type: "retire",
      status: "auto_applied",
      target_ids: [memId],
      payload: { source: "quality_signal" },
    });

    revertDreamAction(db, "p3-retire-action", "none");

    const mem = getRetired(db, memId);
    expect(mem.retired_at).toBeNull();

    const action = getRevertedBy(db, "p3-retire-action");
    expect(action.reverted_by).toBe("user");
  });

  it("P3 retire revert is idempotent after the action has already been reverted", () => {
    const memId = crypto.randomUUID();
    seedMemory(db, { memory_id: memId, retired_at: Date.now() - 1000 });

    seedAction(db, {
      action_id: "p3-retire-idempotent",
      phase: "P3",
      action_type: "retire",
      status: "auto_applied",
      target_ids: [memId],
      payload: { source: "quality_signal" },
    });

    revertDreamAction(db, "p3-retire-idempotent", "none");

    db.prepare("UPDATE t2_memories SET retired_at = ? WHERE memory_id = ?").run(Date.now(), memId);
    db.prepare("UPDATE dream_actions SET reverted_by = 'user' WHERE action_id = ?").run(
      "p3-retire-idempotent",
    );

    const retiredBefore = getRetired(db, memId);
    expect(retiredBefore.retired_at).not.toBeNull();

    revertDreamAction(db, "p3-retire-idempotent", "none");

    const retiredAfter = getRetired(db, memId);
    expect(retiredAfter.retired_at).toBe(retiredBefore.retired_at);

    const action = getRevertedBy(db, "p3-retire-idempotent");
    expect(action.reverted_by).toBe("user");
  });

  // ── P6 ──────────────────────────────────────────────────────────────────

  it("P6 revert: deletes the project_briefs row, preserving newer ones", () => {
    const projectId = "proj-test-" + crypto.randomUUID();

    const t0 = Date.now() - 10000;
    const t1 = Date.now() - 5000;
    const t2 = Date.now();

    // The brief generated at T0
    db.prepare(
      `INSERT INTO project_briefs(project_id, brief_md, source_memory_ids, generated_at, generated_by_cycle)
       VALUES(?, 'brief text', '[]', ?, 'cycle-test')`,
    ).run(projectId, t0);

    // The action happened at T1
    seedAction(db, {
      action_id: "p6-action",
      phase: "P6",
      action_type: "brief_generation",
      status: "auto_applied",
      target_ids: [projectId],
      payload: {},
      decided_at: t1,
    });

    // P6 revert should delete the brief since t0 <= t1
    revertDreamAction(db, "p6-action", "none");
    const briefMissing = db
      .prepare("SELECT 1 FROM project_briefs WHERE project_id = ?")
      .get(projectId);
    expect(briefMissing).toBeNull();

    // Now insert a newer brief at T2
    db.prepare(
      `INSERT INTO project_briefs(project_id, brief_md, source_memory_ids, generated_at, generated_by_cycle)
       VALUES(?, 'newer brief text', '[]', ?, 'cycle-test')`,
    ).run(projectId, t2);

    // Revert the T1 action again
    db.prepare("UPDATE dream_actions SET reverted_by = NULL WHERE action_id = ?").run("p6-action");
    revertDreamAction(db, "p6-action", "none");

    // It should NOT delete the T2 brief
    const briefAfter = db
      .prepare("SELECT generated_at FROM project_briefs WHERE project_id = ?")
      .get(projectId) as ProjectBriefGeneratedAtRow;
    expect(briefAfter.generated_at).toBe(t2);

    const action = getRevertedBy(db, "p6-action");
    expect(action.reverted_by).toBe("user");
  });

  // ── P5 soft stamp ────────────────────────────────────────────────────────

  it("queued revert of state-changing phase: stamps reverted_by only, no other state change", () => {
    const rollupId = crypto.randomUUID();
    const t2MemoryId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, ended_at, n_events, first_prompt_excerpt, t2_promoted_at)
       VALUES(?, 'system', ?, ?, ?, 0, 'excerpt-text', ?)`,
    ).run(rollupId, crypto.randomUUID(), now, now, now);

    seedMemory(db, { memory_id: t2MemoryId });

    seedAction(db, {
      action_id: "p1-action-queued",
      phase: "P1",
      action_type: "promote_t1",
      status: "queued",
      target_ids: [rollupId],
      payload: { t2_memory_id: t2MemoryId, votes: [] },
    });

    revertDreamAction(db, "p1-action-queued", "none");

    const rollup = db
      .prepare("SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id = ?")
      .get(rollupId) as RollupPromotedRow;
    expect(rollup.t2_promoted_at).not.toBeNull(); // didn't clear it

    const action = getRevertedBy(db, "p1-action-queued");
    expect(action.reverted_by).toBe("user");
  });

  it("P5 queued revert: stamps reverted_by only, no other state change", () => {
    seedAction(db, {
      action_id: "p5-action",
      phase: "P5",
      action_type: "mint_research",
      status: "queued",
      target_ids: ["proj-x"],
      payload: { query: "test query" },
    });

    revertDreamAction(db, "p5-action", "none");

    const action = getRevertedBy(db, "p5-action");
    expect(action.reverted_by).toBe("user");
  });

  // ── Unknown phase soft stamp ──────────────────────────────────────────────

  it("unknown phase revert: stamps reverted_by only", () => {
    seedAction(db, {
      action_id: "unknown-action",
      phase: "P99",
      action_type: "mystery",
      status: "auto_applied",
      target_ids: [],
      payload: {},
    });

    revertDreamAction(db, "unknown-action", "none");

    const action = getRevertedBy(db, "unknown-action");
    expect(action.reverted_by).toBe("user");
  });

  // ── P7 regression ────────────────────────────────────────────────────────

  it("P7 revert: still restores vector from t2_vec_history (regression)", () => {
    const memId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, embedding_model_version)
       VALUES(?, 'system', 'promoted', ?, ?, 'title', 'body', ?, ?, 'v2')`,
    ).run(memId, now, now, now, now);

    const rowRow = db
      .prepare("SELECT rowid FROM t2_memories WHERE memory_id = ?")
      .get(memId) as RowidRow;
    const newVec = Buffer.from(new Float32Array(new Array(384).fill(0.2)).buffer);
    db.prepare("INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)").run(rowRow.rowid, newVec);

    const oldVec = Buffer.from(new Float32Array(new Array(384).fill(0.1)).buffer);
    db.prepare(
      `INSERT INTO t2_vec_history(history_id, memory_id, embedding, embedding_model_version, snapshotted_at, snapshotted_by_cycle)
       VALUES(?, ?, ?, 'v1', ?, 'cycle-test')`,
    ).run(crypto.randomUUID(), memId, oldVec, Date.now() - 1000);

    seedAction(db, {
      action_id: "p7-action",
      phase: "P7",
      action_type: "reembed",
      status: "auto_applied",
      target_ids: [memId],
      payload: { previous_version: "v1" },
      decided_at: Date.now(),
    });

    revertDreamAction(db, "p7-action", "none");

    const mem = db
      .prepare("SELECT embedding_model_version FROM t2_memories WHERE memory_id = ?")
      .get(memId) as EmbeddingVersionRow;
    expect(mem.embedding_model_version).toBe("v1");

    const vec = db
      .prepare(
        "SELECT embedding FROM t2_vec WHERE rowid = (SELECT rowid FROM t2_memories WHERE memory_id = ?)",
      )
      .get(memId) as VectorRow;
    const arr = new Float32Array(
      vec.embedding.buffer,
      vec.embedding.byteOffset,
      vec.embedding.byteLength / 4,
    );
    expect(arr[0]).toBeCloseTo(0.1);
  });
});

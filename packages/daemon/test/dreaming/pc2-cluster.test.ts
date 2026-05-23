import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { findSimilarityClusters } from "../../src/dreaming/curator/cluster-detection.js";
import { runPC2Phase } from "../../src/dreaming/curator/pc2-cluster.js";
import { revertDreamAction } from "../../src/dreaming/reembed.js";
import type { DreamConfig } from "../../src/dreaming/config.js";

function openTestDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE t2_memories (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT UNIQUE NOT NULL,
      body TEXT NOT NULL,
      embedding_model_version TEXT,
      retired_at INTEGER,
      created_at INTEGER
    )
  `);

  db.run(`
    CREATE TABLE t2_vec (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      embedding BLOB
    )
  `);

  db.run(`
    CREATE TABLE t2_vec_history (
      history_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      embedding BLOB,
      embedding_model_version TEXT,
      snapshotted_at INTEGER,
      snapshotted_by_cycle TEXT
    )
  `);

  db.run(`
    CREATE TABLE memory_links (
      link_id TEXT PRIMARY KEY,
      src_id TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      weight REAL NOT NULL,
      retired_at INTEGER
    )
  `);

  db.run(`
    CREATE TABLE dream_actions (
      action_id TEXT PRIMARY KEY,
      cycle_id TEXT,
      phase TEXT,
      action_type TEXT,
      confidence REAL,
      status TEXT,
      target_ids TEXT,
      payload_json TEXT,
      decided_at INTEGER DEFAULT (CAST((julianday('now') - 2440587.5)*86400000 AS INTEGER)),
      reverted_by TEXT
    )
  `);

  db.run(`
    CREATE TABLE t1_rollups (
      rollup_id TEXT PRIMARY KEY,
      t2_promoted_at INTEGER
    )
  `);

  db.run(`
    CREATE TABLE project_briefs (
      project_id TEXT,
      generated_at INTEGER
    )
  `);

  return db;
}

let counter = 1;
function insertMemories(db: Database, ids: string[]) {
  const stmt = db.prepare(`INSERT INTO t2_memories(memory_id, body, created_at) VALUES(?, 'body', ?)`);
  db.transaction(() => {
    for (const id of ids) {
      stmt.run(id, counter++); // older first
    }
  })();
}

function insertLink(db: Database, opts: { src: string; dst: string; weight: number }) {
  db.prepare(`
    INSERT INTO memory_links(link_id, src_id, dst_id, link_type, weight)
    VALUES(?, ?, ?, 'semantic_near', ?)
  `).run(crypto.randomUUID(), opts.src, opts.dst, opts.weight);
}

function seedCluster(db: Database, ids: string[], opts: { similarity: number; canonical?: string }) {
  if (opts.canonical) {
    // Insert non-canonicals first so they are older
    insertMemories(db, ids.filter(id => id !== opts.canonical));
    insertMemories(db, [opts.canonical]);
  } else {
    insertMemories(db, ids);
  }

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      insertLink(db, { src: ids[i], dst: ids[j], weight: opts.similarity });
    }
  }
}

function testConfig(overrides?: Partial<DreamConfig>): DreamConfig {
  return {
    enabled: true,
    cronMinutes: 30,
    perCycleUsd: 0.5,
    dailyUsd: 5.0,
    pressureGuardEnabled: true,
    perCycleEmbeddingUsd: 0.1,
    perCycleResearchUsd: 0.25,
    linkAutoThreshold: 0.75,
    p1BatchSize: 10,
    reembedBatchSize: 100,
    skipPhases: new Set(),
    eventTriggerEnabled: true,
    idleMinutes: 15,
    triggerCooldownMinutes: 5,
    briefRefreshHours: 24,
    curatorEnabled: false,
    pc2MinClusterSize: 3,
    pc2ClusterLinkThreshold: 0.85,
    pc2AutoThreshold: 0.97,
    ...overrides,
  };
}

function withPC2AutoApply<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.PENUMBRA_DREAMING_PC2_AUTO_APPLY;
  if (value === undefined) {
    delete process.env.PENUMBRA_DREAMING_PC2_AUTO_APPLY;
  } else {
    process.env.PENUMBRA_DREAMING_PC2_AUTO_APPLY = value;
  }

  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) {
      delete process.env.PENUMBRA_DREAMING_PC2_AUTO_APPLY;
    } else {
      process.env.PENUMBRA_DREAMING_PC2_AUTO_APPLY = prev;
    }
  });
}

it("findSimilarityClusters groups memory_links semantic_near edges", () => {
  const db = openTestDb();
  insertMemories(db, ["A","B","C","D","E"]);
  insertLink(db, { src:"A", dst:"B", weight:0.97 });
  insertLink(db, { src:"A", dst:"C", weight:0.95 });
  insertLink(db, { src:"B", dst:"C", weight:0.96 });
  insertLink(db, { src:"D", dst:"E", weight:0.94 });  // pair — below minSize
  const clusters = findSimilarityClusters(db, { minSize: 3, minWeight: 0.90 });
  expect(clusters).toHaveLength(1);
  expect(clusters[0].sort()).toEqual(["A","B","C"]);
});

it("runPC2Phase inserts cluster_retire for non-canonicals (queued by default)", async () => {
  await withPC2AutoApply(undefined, async () => {
    const db = openTestDb();
    seedCluster(db, ["A","B","C"], { similarity: 0.96, canonical: "A" });
    await runPC2Phase(db, "cycle-1", testConfig(), {});
    const actions = db.prepare(`SELECT * FROM dream_actions WHERE action_type='cluster_retire'`).all() as any[];
    expect(actions).toHaveLength(2);
    actions.forEach(a => {
      expect(JSON.parse(a.payload_json).canonical_id).toBe("A");
      expect(a.status).toBe("queued");
    });
  });
});

it("runPC2Phase auto-applies when env is enabled and similarity is above threshold", async () => {
  await withPC2AutoApply('1', async () => {
    const db = openTestDb();
    seedCluster(db, ["A","B","C"], { similarity: 0.98 });
    await runPC2Phase(db, "cycle-1", testConfig({ pc2AutoThreshold: 0.97 }), {});
    const retired = db.prepare(`SELECT * FROM t2_memories WHERE retired_at IS NOT NULL`).all() as any[];
    expect(retired).toHaveLength(2);
    const actions = db.prepare(`SELECT status FROM dream_actions WHERE action_type='cluster_retire'`).all() as any[];
    expect(actions.every(a => a.status === "auto_applied")).toBe(true);
  });
});

it("runPC2Phase does not auto-apply when env is unset even if similarity exceeds threshold", async () => {
  await withPC2AutoApply(undefined, async () => {
    const db = openTestDb();
    seedCluster(db, ["D","E","F"], { similarity: 0.98 });
    await runPC2Phase(db, "cycle-2", testConfig({ pc2AutoThreshold: 0.97 }), {});
    const actions = db.prepare(`SELECT status FROM dream_actions WHERE action_type='cluster_retire'`).all() as any[];
    expect(actions.every(a => a.status === "queued")).toBe(true);
  });
});

it("runPC2Phase avoids per-member SELECTs for 5-member cluster", async () => {
  const db = openTestDb();
  const originalPrepare = (db as any).prepare.bind(db);
  let totalSelects = 0;
  let similarityScanSelects = 0;
  (db as any).prepare = (query: string, ...params: unknown[]) => {
    const upper = query.toUpperCase();
    if (upper.startsWith("SELECT ")) {
      totalSelects += 1;
      if (upper.includes("SELECT SRC_ID, DST_ID")) {
        similarityScanSelects += 1;
      }
    }
    return originalPrepare(query, ...params);
  };

  try {
    seedCluster(db, ["A", "B", "C", "D", "E"], { similarity: 0.98, canonical: "A" });

    await runPC2Phase(db, "cluster-5-members", testConfig({ pc2AutoThreshold: 0.97 }), {});

    expect(totalSelects - similarityScanSelects).toBeLessThanOrEqual(3);
  } finally {
    (db as any).prepare = originalPrepare;
  }
});

it("runPC2Phase dedup: second cycle does not re-queue cluster_retire for same target", async () => {
  const db = openTestDb();
  seedCluster(db, ["A","B","C"], { similarity: 0.88 });
  await runPC2Phase(db, "cycle-1", testConfig(), {});
  await runPC2Phase(db, "cycle-2", testConfig(), {});
  const count = (db.prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE action_type='cluster_retire'`).get() as any).n;
  expect(count).toBe(2);  // 2 non-canonicals × 1 cycle, not × 2
});

it("runPC2Phase uses only intra-cluster non-retired edges — retired external link does not inflate max similarity", async () => {
  const db = openTestDb();
  // cluster [A,B,C] all-internal 0.86; retired external link A→Z at 0.99
  // findSimilarityClusters excludes retired_at IS NOT NULL links, so Z stays outside [A,B,C]
  // old OR-based query would pick up A-Z (0.99) since A ∈ cluster; new AND query excludes it
  seedCluster(db, ["A","B","C"], { similarity: 0.86 });
  insertMemories(db, ["Z"]);
  db.prepare(
    `INSERT INTO memory_links(link_id, src_id, dst_id, link_type, weight, retired_at) VALUES(?, 'A', 'Z', 'semantic_near', 0.99, 1)`
  ).run(crypto.randomUUID());
  // pc2AutoThreshold=0.92: intra-cluster max is 0.86 < 0.92 → queued, NOT auto_applied
  await runPC2Phase(db, "cycle-1", testConfig({ pc2AutoThreshold: 0.92 }), {});
  const actions = db.prepare(`SELECT status FROM dream_actions WHERE action_type='cluster_retire'`).all() as any[];
  expect(actions.length).toBeGreaterThan(0);
  expect(actions.every(a => a.status === "queued")).toBe(true);
});

it("runPC2Phase skips already-retired cluster members (no cluster_retire emitted for them)", async () => {
  const db = openTestDb();
  seedCluster(db, ["A","B","C"], { similarity: 0.96, canonical: "C" });
  // Pre-retire B
  db.prepare(`UPDATE t2_memories SET retired_at = 1 WHERE memory_id = 'B'`).run();
  await runPC2Phase(db, "cycle-1", testConfig(), {});
  // Only A should get cluster_retire (B is retired, C is canonical)
  const actions = db.prepare(`SELECT target_ids FROM dream_actions WHERE action_type='cluster_retire'`).all() as any[];
  expect(actions).toHaveLength(1);
  expect(JSON.parse(actions[0].target_ids)[0]).toBe("A");
});

it("revertDreamAction un-retires cluster_retire target", async () => {
  await withPC2AutoApply('1', async () => {
    const db = openTestDb();
    seedCluster(db, ["A","B","C"], { similarity: 0.98 });
    await runPC2Phase(db, "cycle-1", testConfig({ pc2AutoThreshold: 0.97 }), {});
    const action = db
      .prepare(
        `SELECT action_id, target_ids FROM dream_actions WHERE action_type='cluster_retire' AND status='auto_applied' LIMIT 1`,
      )
      .get() as any;
    const targetId = JSON.parse(action.target_ids)[0];
    revertDreamAction(db, action.action_id, "none");
    const mem = db.prepare(`SELECT retired_at FROM t2_memories WHERE memory_id=?`).get(targetId) as any;
    expect(mem.retired_at).toBeNull();
  });
});

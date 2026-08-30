import type { DreamConfig } from "@src/dreaming/config.js";
import type { DreamCycleDeps } from "@src/dreaming/cycle.js";

import { applySchema, loadSqliteVec } from "@penumbra/core";
import { runDreamCycle } from "@src/dreaming/cycle.js";
import { revertDreamAction, runReembedPhase } from "@src/dreaming/reembed.js";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

// File-local typed factory for DreamConfig stubs. DreamConfig has 30+ env-derived
// fields; runReembedPhase / runDreamCycle in these tests only consume a small
// subset (reembedBatchSize, skipPhases, perCycleUsd, dailyUsd, p1BatchSize), so
// hand-stubbing every field would dwarf the test bodies. ONE documented
// `as unknown as` per the strict-bar helper rule.
function makeConfig(extra: Partial<DreamConfig> = {}): DreamConfig {
  return {
    reembedBatchSize: 100,
    skipPhases: new Set<string>(),
    p1BatchSize: 10,
    perCycleUsd: 1.0,
    dailyUsd: 10.0,
    ...extra,
  } as unknown as DreamConfig;
}

interface CountRow {
  c: number;
}
interface MemoryVersionRow {
  embedding_model_version: string | null;
}
interface MemoryRowidVersionRow {
  rowid: number;
  embedding_model_version: string | null;
}
interface ActionIdRow {
  action_id: string;
}
interface EmbeddingHistoryRow {
  embedding: Uint8Array;
  embedding_model_version: string;
}
interface EmbeddingRow {
  embedding: Uint8Array;
}
interface RowidRow {
  rowid: number;
}
interface PhasesRunRow {
  phases_run: string;
}

function getTestDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  for (const cycleId of ["cycle-test", "cycle11", "cycle22", "cycle33"]) {
    db.prepare(
      `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
         VALUES(?, 0, 'cron', 10, 'running', '[]')`,
    ).run(cycleId);
  }
  return db;
}

function vectorToBuffer(vec: number[]): Buffer {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function seedMemoryWithEmbeddingVersion(
  db: Database,
  opts: { memory_id?: string; embeddingModelVersion: string | null; vector: number[] },
): string {
  const memoryId = opts.memory_id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, embedding_model_version)
     VALUES(?, 'hting', 'decision', ?, ?, 'test-title', 'test-body', ?, ?, ?)`,
  ).run(memoryId, now, now, now, now, opts.embeddingModelVersion);

  const row = db
    .prepare(`SELECT rowid FROM t2_memories WHERE memory_id = ?`)
    .get(memoryId) as RowidRow;
  db.prepare(`INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)`).run(
    row.rowid,
    vectorToBuffer(opts.vector),
  );
  return memoryId;
}

function seedMemoryWithoutVector(
  db: Database,
  opts: { memory_id?: string; embeddingModelVersion: string | null; title?: string; body?: string },
): string {
  const memoryId = opts.memory_id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, embedding_model_version)
     VALUES(?, 'hting', 'decision', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    memoryId,
    now,
    now,
    opts.title ?? "test-title",
    opts.body ?? "test-body",
    now,
    now,
    opts.embeddingModelVersion,
  );
  return memoryId;
}

function fixedVec(value: number, length = 384): Float32Array {
  return new Float32Array(new Array(length).fill(value) as number[]);
}

type ManagedEnvKey =
  | "PENUMBRA_T2_REEMBED_ENABLED"
  | "PENUMBRA_T2_EMBED_RECIPE"
  | "PENUMBRA_EMBEDDING_MODEL_VERSION";

function restoreEnv(key: ManagedEnvKey, prior: string | undefined): void {
  if (prior !== undefined) {
    process.env[key] = prior;
    return;
  }
  switch (key) {
    case "PENUMBRA_T2_REEMBED_ENABLED":
      delete process.env.PENUMBRA_T2_REEMBED_ENABLED;
      return;
    case "PENUMBRA_T2_EMBED_RECIPE":
      delete process.env.PENUMBRA_T2_EMBED_RECIPE;
      return;
    case "PENUMBRA_EMBEDDING_MODEL_VERSION":
      delete process.env.PENUMBRA_EMBEDDING_MODEL_VERSION;
      return;
  }
}

describe("Dreaming P7 re-embed", () => {
  it("P7 is a no-op when PENUMBRA_T2_REEMBED_ENABLED is false", async () => {
    const db = getTestDb();
    seedMemoryWithEmbeddingVersion(db, {
      embeddingModelVersion: "v1",
      vector: new Array(384).fill(0.1) as number[],
    });
    const prevEnabled = process.env.PENUMBRA_T2_REEMBED_ENABLED;
    process.env.PENUMBRA_T2_REEMBED_ENABLED = "false";
    let called = false;

    try {
      const out = await runReembedPhase(db, "cycle11", makeConfig(), {
        onReembed: () => {
          called = true;
          return Promise.resolve(fixedVec(0.3));
        },
      });

      expect(out).toEqual({ deferred: false, processed: 0 });
      expect(called).toBe(false);
      const actionCount = db
        .prepare("SELECT COUNT(*) as c FROM dream_actions WHERE phase='P7'")
        .get() as CountRow;
      expect(actionCount.c).toBe(0);
    } finally {
      restoreEnv("PENUMBRA_T2_REEMBED_ENABLED", prevEnabled);
    }
  });

  it("P7 only re-embeds memories with stale embedding_model_version", async () => {
    const db = getTestDb();
    seedMemoryWithEmbeddingVersion(db, {
      embeddingModelVersion: "v2",
      vector: new Array(384).fill(0.1) as number[],
    });
    const staleId = seedMemoryWithEmbeddingVersion(db, {
      embeddingModelVersion: "v1",
      vector: new Array(384).fill(0.1) as number[],
    });

    let embededCount = 0;

    const prevEnabled = process.env.PENUMBRA_T2_REEMBED_ENABLED;
    const prevRecipe = process.env.PENUMBRA_T2_EMBED_RECIPE;
    process.env.PENUMBRA_T2_REEMBED_ENABLED = "true";
    process.env.PENUMBRA_T2_EMBED_RECIPE = "body_v1";
    process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = "v2";
    await runReembedPhase(db, "cycle11", makeConfig(), {
      onReembed: (id, text) => {
        embededCount++;
        expect(id).toBe(staleId); // Should only be called for stale memory
        expect(text).toBe("test-body");
        return Promise.resolve(fixedVec(0.3));
      },
    });

    restoreEnv("PENUMBRA_T2_REEMBED_ENABLED", prevEnabled);
    restoreEnv("PENUMBRA_T2_EMBED_RECIPE", prevRecipe);

    expect(embededCount).toBe(1);
  });

  it("P7 re-embeds full batch even when cost meter cannot afford", async () => {
    const db = getTestDb();
    for (let i = 0; i < 3; i++) {
      seedMemoryWithEmbeddingVersion(db, {
        embeddingModelVersion: "v1",
        vector: new Array(384).fill(0.1) as number[],
      });
    }

    const config = makeConfig({ reembedBatchSize: 3 });
    const prevEnabled = process.env.PENUMBRA_T2_REEMBED_ENABLED;
    const prevModelVersion = process.env.PENUMBRA_EMBEDDING_MODEL_VERSION;
    process.env.PENUMBRA_T2_REEMBED_ENABLED = "true";
    process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = "v2";

    let onReembedCalls = 0;
    try {
      const deps: DreamCycleDeps = {
        phaseCostEstimates: {
          p3ScorerLlmUsd: 0,
          p4RewriterLlmUsd: 0,
          p5ResearchUsd: 0,
          p6BriefSynthLlmUsd: 0,
          p7EmbedUsd: 0.01,
        },
        costMeter: {
          canAfford: () => false,
          record: () => {
            /* test stub: cost recording is a no-op */
          },
        },
        onReembed: () => {
          onReembedCalls++;
          return Promise.resolve(fixedVec(0.3));
        },
      };
      const out = await runReembedPhase(db, "cycle11", config, deps);

      expect(out).toEqual({ deferred: false, processed: 3 });
      expect(onReembedCalls).toBe(3);
    } finally {
      restoreEnv("PENUMBRA_T2_REEMBED_ENABLED", prevEnabled);
      restoreEnv("PENUMBRA_EMBEDDING_MODEL_VERSION", prevModelVersion);
    }
  });

  it("P7 repairs orphaned rows by creating missing t2_vec entries", async () => {
    const db = getTestDb();
    const staleId = seedMemoryWithoutVector(db, {
      embeddingModelVersion: "v1",
      title: "orphan-title",
      body: "orphan-body",
    });
    const prevEnabled = process.env.PENUMBRA_T2_REEMBED_ENABLED;
    const prevModelVersion = process.env.PENUMBRA_EMBEDDING_MODEL_VERSION;
    process.env.PENUMBRA_T2_REEMBED_ENABLED = "true";
    process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = "v2";

    try {
      const out = await runReembedPhase(db, "cycle11", makeConfig(), {
        onReembed: () => Promise.resolve(fixedVec(0.4)),
      });
      expect(out).toEqual({ deferred: false, processed: 1 });
    } finally {
      restoreEnv("PENUMBRA_T2_REEMBED_ENABLED", prevEnabled);
      restoreEnv("PENUMBRA_EMBEDDING_MODEL_VERSION", prevModelVersion);
    }

    const row = db
      .prepare(`SELECT rowid, embedding_model_version FROM t2_memories WHERE memory_id = ?`)
      .get(staleId) as MemoryRowidVersionRow;
    expect(row.embedding_model_version).toBe("v2");
    const vecRow = db
      .prepare(`SELECT embedding FROM t2_vec WHERE rowid = ?`)
      .get(row.rowid) as EmbeddingRow | null;
    expect(vecRow).toBeTruthy();
  });

  it("P7 routes re-embed input through title recipe when enabled", async () => {
    const db = getTestDb();
    seedMemoryWithEmbeddingVersion(db, {
      embeddingModelVersion: "v1",
      vector: new Array(384).fill(0.1) as number[],
    });
    const prevEnabled = process.env.PENUMBRA_T2_REEMBED_ENABLED;
    const prevRecipe = process.env.PENUMBRA_T2_EMBED_RECIPE;
    process.env.PENUMBRA_T2_REEMBED_ENABLED = "true";
    process.env.PENUMBRA_T2_EMBED_RECIPE = "title_only";
    const seen: string[] = [];

    try {
      await runReembedPhase(db, "cycle11", makeConfig(), {
        onReembed: (_id, text) => {
          seen.push(text);
          return Promise.resolve(fixedVec(0.3));
        },
      });

      expect(seen).toEqual(["test-title"]);
    } finally {
      restoreEnv("PENUMBRA_T2_REEMBED_ENABLED", prevEnabled);
      restoreEnv("PENUMBRA_T2_EMBED_RECIPE", prevRecipe);
    }
  });

  it("P7 snapshots old vector to t2_vec_history BEFORE overwriting", async () => {
    const db = getTestDb();
    const id = seedMemoryWithEmbeddingVersion(db, {
      embeddingModelVersion: "v1",
      vector: new Array(384).fill(0.1) as number[],
    });

    const prevEnabled = process.env.PENUMBRA_T2_REEMBED_ENABLED;
    process.env.PENUMBRA_T2_REEMBED_ENABLED = "true";
    process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = "v2";

    await runReembedPhase(db, "cycle22", makeConfig(), {
      onReembed: () => Promise.resolve(fixedVec(0.2)),
    });
    restoreEnv("PENUMBRA_T2_REEMBED_ENABLED", prevEnabled);

    const mem = db
      .prepare(`SELECT embedding_model_version FROM t2_memories WHERE memory_id = ?`)
      .get(id) as MemoryVersionRow;
    expect(mem.embedding_model_version).toBe("v2");

    const historyCount = db.prepare(`SELECT COUNT(*) as c FROM t2_vec_history`).get() as CountRow;
    expect(historyCount.c).toBe(1);

    const historicVec = db
      .prepare(`SELECT embedding, embedding_model_version FROM t2_vec_history LIMIT 1`)
      .get() as EmbeddingHistoryRow;
    expect(historicVec.embedding_model_version).toBe("v1");
    const oldVecArray = new Float32Array(
      historicVec.embedding.buffer,
      historicVec.embedding.byteOffset,
      historicVec.embedding.byteLength / 4,
    );
    expect(oldVecArray[0]).toBeCloseTo(0.1);
    expect(oldVecArray[1]).toBeCloseTo(0.1);
  });

  it("P7 does not stamp embedding_model_version when vec upsert fails", async () => {
    const db = getTestDb();
    const id = seedMemoryWithEmbeddingVersion(db, {
      embeddingModelVersion: "v1",
      vector: new Array(384).fill(0.1) as number[],
    });
    const prevEnabled = process.env.PENUMBRA_T2_REEMBED_ENABLED;
    const prevModelVersion = process.env.PENUMBRA_EMBEDDING_MODEL_VERSION;
    process.env.PENUMBRA_T2_REEMBED_ENABLED = "true";
    process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = "v2";

    try {
      const out = await runReembedPhase(db, "cycle22", makeConfig(), {
        // wrong dimension (1 instead of 384) should fail vec write
        onReembed: () => Promise.resolve(new Float32Array([0.2])),
      });
      expect(out).toEqual({ deferred: false, processed: 0 });
    } finally {
      restoreEnv("PENUMBRA_T2_REEMBED_ENABLED", prevEnabled);
      restoreEnv("PENUMBRA_EMBEDDING_MODEL_VERSION", prevModelVersion);
    }

    const mem = db
      .prepare(`SELECT embedding_model_version FROM t2_memories WHERE memory_id = ?`)
      .get(id) as MemoryVersionRow;
    expect(mem.embedding_model_version).toBe("v1");
    const actionCount = db
      .prepare(`SELECT COUNT(*) AS c FROM dream_actions WHERE phase='P7' AND target_ids = ?`)
      .get(JSON.stringify([id])) as CountRow;
    expect(actionCount.c).toBe(0);
  });

  it("P7 revert: restores pre-action vector from t2_vec_history", async () => {
    const db = getTestDb();
    const id = seedMemoryWithEmbeddingVersion(db, {
      embeddingModelVersion: "v1",
      vector: new Array(384).fill(0.1) as number[],
    });

    const prevEnabled = process.env.PENUMBRA_T2_REEMBED_ENABLED;
    process.env.PENUMBRA_T2_REEMBED_ENABLED = "true";
    process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = "v2";

    await runReembedPhase(db, "cycle33", makeConfig(), {
      onReembed: () => Promise.resolve(fixedVec(0.2)),
    });
    restoreEnv("PENUMBRA_T2_REEMBED_ENABLED", prevEnabled);

    const action = db
      .prepare(`SELECT action_id FROM dream_actions WHERE phase='P7'`)
      .get() as ActionIdRow | null;
    expect(action).toBeTruthy();

    // Verify it is v2 currently
    const mem = db
      .prepare(`SELECT embedding_model_version FROM t2_memories WHERE memory_id = ?`)
      .get(id) as MemoryVersionRow;
    expect(mem.embedding_model_version).toBe("v2");

    revertDreamAction(db, action!.action_id, "none");

    // Verify it was reverted to v1
    const revertedMem = db
      .prepare(`SELECT embedding_model_version FROM t2_memories WHERE memory_id = ?`)
      .get(id) as MemoryVersionRow;
    expect(revertedMem.embedding_model_version).toBe("v1");

    const revertedVec = db
      .prepare(
        `SELECT embedding FROM t2_vec WHERE rowid = (SELECT rowid FROM t2_memories WHERE memory_id = ?)`,
      )
      .get(id) as EmbeddingRow;
    const revertedVecArray = new Float32Array(
      revertedVec.embedding.buffer,
      revertedVec.embedding.byteOffset,
      revertedVec.embedding.byteLength / 4,
    );
    expect(revertedVecArray[0]).toBeCloseTo(0.1);
    expect(revertedVecArray[1]).toBeCloseTo(0.1);
  });

  it("daemon wiring contract: onReembed adapter calls embedder.embed for stale memories", async () => {
    const db = getTestDb();
    seedMemoryWithEmbeddingVersion(db, {
      embeddingModelVersion: "v1",
      vector: new Array(384).fill(0.1) as number[],
    });

    let embedCallCount = 0;
    const stubEmbedder = {
      embed(strings: string[]): Promise<Float32Array[]> {
        embedCallCount++;
        return Promise.resolve(strings.map(() => fixedVec(0.5)));
      },
    };

    const prevEnabled = process.env.PENUMBRA_T2_REEMBED_ENABLED;
    const prevRecipe = process.env.PENUMBRA_T2_EMBED_RECIPE;
    process.env.PENUMBRA_T2_REEMBED_ENABLED = "true";
    process.env.PENUMBRA_T2_EMBED_RECIPE = "title_only";
    process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = "v2";

    await runDreamCycle(db, makeConfig(), {
      onReembed: (_id, text) => stubEmbedder.embed([text]).then((arr) => arr[0]!),
    });

    restoreEnv("PENUMBRA_T2_REEMBED_ENABLED", prevEnabled);
    restoreEnv("PENUMBRA_T2_EMBED_RECIPE", prevRecipe);

    expect(embedCallCount).toBe(1);
  });

  it("SKIP_PHASES short-circuits P7", async () => {
    const db = getTestDb();
    const config = makeConfig({ skipPhases: new Set(["P7"]) });
    let onReembedCalled = false;
    await runDreamCycle(db, config, {
      onReembed: () => {
        onReembedCalled = true;
        return Promise.resolve(new Float32Array([]));
      },
    });
    expect(onReembedCalled).toBe(false);

    const cycle = db.prepare(`SELECT phases_run FROM dream_cycles LIMIT 1`).get() as PhasesRunRow;
    expect(cycle.phases_run).not.toInclude("P7");
  });
});

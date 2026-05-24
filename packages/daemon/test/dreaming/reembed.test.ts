import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '@penumbra/core';
import { loadSqliteVec } from '@penumbra/core';
import { runReembedPhase, revertDreamAction } from '../../src/dreaming/reembed.js';
import { runDreamCycle } from '../../src/dreaming/cycle.js';
import type { DreamConfig } from '../../src/dreaming/config.js';

function getTestDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db);
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
       VALUES('cycle-test', 0, 'cron', 10, 'running', '[]')`,
  ).run();
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
       VALUES('cycle11', 0, 'cron', 10, 'running', '[]')`,
  ).run();
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
       VALUES('cycle22', 0, 'cron', 10, 'running', '[]')`,
  ).run();
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
       VALUES('cycle33', 0, 'cron', 10, 'running', '[]')`,
  ).run();
  return db;
}

function vectorToBuffer(vec: number[]): Buffer {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function seedMemoryWithEmbeddingVersion(db, opts: { memory_id?: string; embeddingModelVersion: string | null; vector: number[] }) {
  const memoryId = opts.memory_id || crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, embedding_model_version)
     VALUES(?, 'hting', 'decision', ?, ?, 'test-title', 'test-body', ?, ?, ?)`
  ).run(memoryId, now, now, now, now, opts.embeddingModelVersion);

  const row = db.prepare(`SELECT rowid FROM t2_memories WHERE memory_id = ?`).get(memoryId) as any;
  db.prepare(`INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)`).run(row.rowid, vectorToBuffer(opts.vector));
  return memoryId;
}


describe('Dreaming P7 re-embed', () => {
  it('P7 only re-embeds memories with stale embedding_model_version', async () => {
    const db = getTestDb();
    const uptoDateId = seedMemoryWithEmbeddingVersion(db, { embeddingModelVersion: 'v2', vector: new Array(384).fill(0.1) });
    const staleId = seedMemoryWithEmbeddingVersion(db, { embeddingModelVersion: 'v1', vector: new Array(384).fill(0.1) });

    const config = { reembedBatchSize: 100, skipPhases: new Set([]), p1BatchSize: 10 } as any;
    let embededCount = 0;

    process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = 'v2';
    await runReembedPhase(db, 'cycle11', config, {
      onReembed: async (id, body) => {
        embededCount++;
        expect(id).toBe(staleId); // Should only be called for stale memory
        return new Float32Array(new Array(384).fill(0.3));
      }
    });

    expect(embededCount).toBe(1);
  });

  it('P7 snapshots old vector to t2_vec_history BEFORE overwriting', async () => {
    const db = getTestDb();
    const id = seedMemoryWithEmbeddingVersion(db, { embeddingModelVersion: 'v1', vector: new Array(384).fill(0.1) });

    const config = { reembedBatchSize: 100, skipPhases: new Set([]), p1BatchSize: 10 } as any;
    process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = 'v2';

    await runReembedPhase(db, 'cycle22', config, {
      onReembed: async () => new Float32Array(new Array(384).fill(0.2))
    });

    const mem = db.prepare(`SELECT embedding_model_version FROM t2_memories WHERE memory_id = ?`).get(id) as any;
    expect(mem.embedding_model_version).toBe('v2');

    const historyCount = db.prepare(`SELECT COUNT(*) as c FROM t2_vec_history`).get() as any;
    expect(historyCount.c).toBe(1);

    const historicVec = db.prepare(`SELECT embedding, embedding_model_version FROM t2_vec_history LIMIT 1`).get() as any;
    expect(historicVec.embedding_model_version).toBe('v1');
    const oldVecArray = new Float32Array(historicVec.embedding.buffer, historicVec.embedding.byteOffset, historicVec.embedding.byteLength / 4);
    expect(oldVecArray[0]).toBeCloseTo(0.1);
    expect(oldVecArray[1]).toBeCloseTo(0.1);
  });

  it('P7 revert: restores pre-action vector from t2_vec_history', async () => {
    const db = getTestDb();
    const id = seedMemoryWithEmbeddingVersion(db, { embeddingModelVersion: 'v1', vector: new Array(384).fill(0.1) });

    const config = { reembedBatchSize: 100, skipPhases: new Set([]), p1BatchSize: 10 } as any;
    process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = 'v2';

    await runReembedPhase(db, 'cycle33', config, {
      onReembed: async () => new Float32Array(new Array(384).fill(0.2))
    });

    const action = db.prepare(`SELECT action_id FROM dream_actions WHERE phase='P7'`).get() as any;
    expect(action).toBeTruthy();

    // Verify it is v2 currently
    const mem = db.prepare(`SELECT embedding_model_version FROM t2_memories WHERE memory_id = ?`).get(id) as any;
    expect(mem.embedding_model_version).toBe('v2');

    revertDreamAction(db, action.action_id, 'none');

    // Verify it was reverted to v1
    const revertedMem = db.prepare(`SELECT embedding_model_version FROM t2_memories WHERE memory_id = ?`).get(id) as any;
    expect(revertedMem.embedding_model_version).toBe('v1');

    const revertedVec = db.prepare(`SELECT embedding FROM t2_vec WHERE rowid = (SELECT rowid FROM t2_memories WHERE memory_id = ?)`).get(id) as any;
    const revertedVecArray = new Float32Array(revertedVec.embedding.buffer, revertedVec.embedding.byteOffset, revertedVec.embedding.byteLength / 4);
    expect(revertedVecArray[0]).toBeCloseTo(0.1);
    expect(revertedVecArray[1]).toBeCloseTo(0.1);
  });

  it('daemon wiring contract: onReembed adapter calls embedder.embed for stale memories', async () => {
    const db = getTestDb();
    seedMemoryWithEmbeddingVersion(db, { embeddingModelVersion: 'v1', vector: new Array(384).fill(0.1) });

    let embedCallCount = 0;
    const stubEmbedder = {
      async embed(strings: string[]): Promise<Float32Array[]> {
        embedCallCount++;
        return strings.map(() => new Float32Array(new Array(384).fill(0.5)));
      },
    };

    process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = 'v2';

    await runDreamCycle(
      db,
      { perCycleUsd: 1.0, dailyUsd: 10.0, skipPhases: new Set<string>(), p1BatchSize: 10, reembedBatchSize: 100 } as any,
      { onReembed: (_id, body) => stubEmbedder.embed([body]).then(arr => arr[0]!) },
    );

    expect(embedCallCount).toBe(1);
  });

  it('SKIP_PHASES short-circuits P7', async () => {
    const db = getTestDb();
    const config = { perCycleUsd: 1.0, dailyUsd: 10.0, skipPhases: new Set(['P7']), p1BatchSize: 10 } as any;
    let onReembedCalled = false;
    await runDreamCycle(db, config, {
      onReembed: async () => { onReembedCalled = true; return new Float32Array([]); }
    });
    expect(onReembedCalled).toBe(false);
    
    const cycle = db.prepare(`SELECT phases_run FROM dream_cycles LIMIT 1`).get() as any;
    expect(cycle.phases_run).not.toInclude('P7');
  });
});

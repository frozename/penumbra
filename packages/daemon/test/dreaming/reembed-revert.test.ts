import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { applySchema } from '@penumbra/core';
import { revertDreamAction } from '../../src/dreaming/reembed.js';

function getTestDb(): Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  applySchema(db);
  // Ensure dreaming runtime columns exist (mirrors cycle.ts P0 migration)
  try { db.exec('ALTER TABLE t2_memories ADD COLUMN retired_at INTEGER'); } catch { /* already present */ }
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
  }
): void {
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json, decided_at)
     VALUES(?, 'cycle-test', ?, ?, 1.0, ?, ?, ?, ?)`
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
  opts: { memory_id: string; body?: string; retired_at?: number | null }
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
     VALUES(?, 'system', 'promoted', ?, ?, 'title', ?, ?, ?)`
  ).run(opts.memory_id, now, now, opts.body ?? 'body-text', now, now);
  if (opts.retired_at !== undefined && opts.retired_at !== null) {
    db.prepare('UPDATE t2_memories SET retired_at = ? WHERE memory_id = ?').run(opts.retired_at, opts.memory_id);
  }
}

describe('revertDreamAction — per-phase compensation', () => {
  let db: Database;

  beforeEach(() => {
    db = getTestDb();
  });

  // ── P1 ──────────────────────────────────────────────────────────────────

  it('P1 revert: clears t2_promoted_at on rollup and retires the t2 memory', () => {
    const rollupId = crypto.randomUUID();
    const t2MemoryId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, ended_at, n_events, first_prompt_excerpt, t2_promoted_at)
       VALUES(?, 'system', ?, ?, ?, 0, 'excerpt-text', ?)`
    ).run(rollupId, crypto.randomUUID(), now, now, now);

    seedMemory(db, { memory_id: t2MemoryId });

    seedAction(db, {
      action_id: 'p1-action',
      phase: 'P1',
      action_type: 'promote_t1',
      status: 'auto_applied',
      target_ids: [rollupId],
      payload: { t2_memory_id: t2MemoryId, votes: [] },
    });

    revertDreamAction(db, 'p1-action', 'none');

    const rollup = db.prepare('SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id = ?').get(rollupId) as any;
    expect(rollup.t2_promoted_at).toBeNull();

    const mem = db.prepare('SELECT retired_at FROM t2_memories WHERE memory_id = ?').get(t2MemoryId) as any;
    expect(mem.retired_at).not.toBeNull();

    const action = db.prepare('SELECT reverted_by FROM dream_actions WHERE action_id = ?').get('p1-action') as any;
    expect(action.reverted_by).toBe('user');
  });

    it('P1 revert: retires EXACT t2_memory_id even if another memory has same body', () => {
    const rollupId = crypto.randomUUID();
    const targetMemId = crypto.randomUUID();
    const decoyMemId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, ended_at, n_events, first_prompt_excerpt, t2_promoted_at)
       VALUES(?, 'system', ?, ?, ?, 0, 'shared-body', ?)`
    ).run(rollupId, crypto.randomUUID(), now, now, now);

    seedMemory(db, { memory_id: targetMemId, body: 'shared-body' });
    seedMemory(db, { memory_id: decoyMemId, body: 'shared-body' });

    seedAction(db, {
      action_id: 'p1-action-exact',
      phase: 'P1',
      action_type: 'promote_t1',
      status: 'auto_applied',
      target_ids: [rollupId],
      payload: { t2_memory_id: targetMemId, votes: [] },
    });

    revertDreamAction(db, 'p1-action-exact', 'none');

    const targetMem = db.prepare('SELECT retired_at FROM t2_memories WHERE memory_id = ?').get(targetMemId) as any;
    expect(targetMem.retired_at).not.toBeNull();

    const decoyMem = db.prepare('SELECT retired_at FROM t2_memories WHERE memory_id = ?').get(decoyMemId) as any;
    expect(decoyMem.retired_at).toBeNull();
  });

  it('P1 revert: throws if payload is missing t2_memory_id', () => {
    seedAction(db, {
      action_id: 'p1-action-missing',
      phase: 'P1',
      action_type: 'promote_t1',
      status: 'auto_applied',
      target_ids: ['some-rollup'],
      payload: { votes: [] },
    });
    expect(() => revertDreamAction(db, 'p1-action-missing', 'none')).toThrow('p1_revert_missing_t2_memory_id');
  });

  // ── P2 ──────────────────────────────────────────────────────────────────

  it('P2 revert: sets retired_at on the matching memory_link', () => {
    const srcId = crypto.randomUUID();
    const dstId = crypto.randomUUID();

    seedMemory(db, { memory_id: srcId });
    seedMemory(db, { memory_id: dstId });

    db.prepare(
      `INSERT INTO memory_links(link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle)
       VALUES(?, ?, ?, 'semantic_near', 0.9, ?, 'cycle-test')`
    ).run(crypto.randomUUID(), srcId, dstId, Date.now());

    seedAction(db, {
      action_id: 'p2-action',
      phase: 'P2',
      action_type: 'link',
      status: 'auto_applied',
      target_ids: [srcId, dstId],
      payload: { link_type: 'semantic_near' },
    });

    revertDreamAction(db, 'p2-action', 'none');

    const link = db.prepare(
      'SELECT retired_at FROM memory_links WHERE src_id = ? AND dst_id = ?'
    ).get(srcId, dstId) as any;
    expect(link.retired_at).not.toBeNull();

    const action = db.prepare('SELECT reverted_by FROM dream_actions WHERE action_id = ?').get('p2-action') as any;
    expect(action.reverted_by).toBe('user');
  });

  // ── P3 retire ────────────────────────────────────────────────────────────

  it('P3 retire revert: clears retired_at on the memory', () => {
    const memId = crypto.randomUUID();
    seedMemory(db, { memory_id: memId, retired_at: Date.now() - 1000 });

    const mem0 = db.prepare('SELECT retired_at FROM t2_memories WHERE memory_id = ?').get(memId) as any;
    expect(mem0.retired_at).not.toBeNull();

    seedAction(db, {
      action_id: 'p3-retire-action',
      phase: 'P3',
      action_type: 'retire',
      status: 'auto_applied',
      target_ids: [memId],
      payload: { source: 'quality_signal' },
    });

    revertDreamAction(db, 'p3-retire-action', 'none');

    const mem = db.prepare('SELECT retired_at FROM t2_memories WHERE memory_id = ?').get(memId) as any;
    expect(mem.retired_at).toBeNull();

    const action = db.prepare('SELECT reverted_by FROM dream_actions WHERE action_id = ?').get('p3-retire-action') as any;
    expect(action.reverted_by).toBe('user');
  });

  // ── P6 ──────────────────────────────────────────────────────────────────

  it('P6 revert: deletes the project_briefs row, preserving newer ones', () => {
    const projectId = 'proj-test-' + crypto.randomUUID();

    const t0 = Date.now() - 10000;
    const t1 = Date.now() - 5000;
    const t2 = Date.now();

    // The brief generated at T0
    db.prepare(
      `INSERT INTO project_briefs(project_id, brief_md, source_memory_ids, generated_at, generated_by_cycle)
       VALUES(?, 'brief text', '[]', ?, 'cycle-test')`
    ).run(projectId, t0);

    // The action happened at T1
    seedAction(db, {
      action_id: 'p6-action',
      phase: 'P6',
      action_type: 'brief_generation',
      status: 'auto_applied',
      target_ids: [projectId],
      payload: {},
      decided_at: t1
    });

    // P6 revert should delete the brief since t0 <= t1
    revertDreamAction(db, 'p6-action', 'none');
    let brief = db.prepare('SELECT 1 FROM project_briefs WHERE project_id = ?').get(projectId);
    expect(brief).toBeNull();

    // Now insert a newer brief at T2
    db.prepare(
      `INSERT INTO project_briefs(project_id, brief_md, source_memory_ids, generated_at, generated_by_cycle)
       VALUES(?, 'newer brief text', '[]', ?, 'cycle-test')`
    ).run(projectId, t2);

    // Revert the T1 action again
    db.prepare('UPDATE dream_actions SET reverted_by = NULL WHERE action_id = ?').run('p6-action');
    revertDreamAction(db, 'p6-action', 'none');

    // It should NOT delete the T2 brief
    brief = db.prepare('SELECT generated_at FROM project_briefs WHERE project_id = ?').get(projectId) as any;
    expect(brief.generated_at).toBe(t2);

    const action = db.prepare('SELECT reverted_by FROM dream_actions WHERE action_id = ?').get('p6-action') as any;
    expect(action.reverted_by).toBe('user');
  });

  // ── P5 soft stamp ────────────────────────────────────────────────────────

  it('queued revert of state-changing phase: stamps reverted_by only, no other state change', () => {
    const rollupId = crypto.randomUUID();
    const t2MemoryId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, ended_at, n_events, first_prompt_excerpt, t2_promoted_at)
       VALUES(?, 'system', ?, ?, ?, 0, 'excerpt-text', ?)`
    ).run(rollupId, crypto.randomUUID(), now, now, now);

    seedMemory(db, { memory_id: t2MemoryId });

    seedAction(db, {
      action_id: 'p1-action-queued',
      phase: 'P1',
      action_type: 'promote_t1',
      status: 'queued',
      target_ids: [rollupId],
      payload: { t2_memory_id: t2MemoryId, votes: [] },
    });

    revertDreamAction(db, 'p1-action-queued', 'none');

    const rollup = db.prepare('SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id = ?').get(rollupId) as any;
    expect(rollup.t2_promoted_at).not.toBeNull(); // didn't clear it

    const action = db.prepare('SELECT reverted_by FROM dream_actions WHERE action_id = ?').get('p1-action-queued') as any;
    expect(action.reverted_by).toBe('user');
  });

  it('P5 queued revert: stamps reverted_by only, no other state change', () => {
    seedAction(db, {
      action_id: 'p5-action',
      phase: 'P5',
      action_type: 'mint_research',
      status: 'queued',
      target_ids: ['proj-x'],
      payload: { query: 'test query' },
    });

    revertDreamAction(db, 'p5-action', 'none');

    const action = db.prepare('SELECT reverted_by FROM dream_actions WHERE action_id = ?').get('p5-action') as any;
    expect(action.reverted_by).toBe('user');
  });

  // ── Unknown phase soft stamp ──────────────────────────────────────────────

  it('unknown phase revert: stamps reverted_by only', () => {
    seedAction(db, {
      action_id: 'unknown-action',
      phase: 'P99',
      action_type: 'mystery',
      status: 'auto_applied',
      target_ids: [],
      payload: {},
    });

    revertDreamAction(db, 'unknown-action', 'none');

    const action = db.prepare('SELECT reverted_by FROM dream_actions WHERE action_id = ?').get('unknown-action') as any;
    expect(action.reverted_by).toBe('user');
  });

  // ── P7 regression ────────────────────────────────────────────────────────

  it('P7 revert: still restores vector from t2_vec_history (regression)', () => {
    const memId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, embedding_model_version)
       VALUES(?, 'system', 'promoted', ?, ?, 'title', 'body', ?, ?, 'v2')`
    ).run(memId, now, now, now, now);

    const rowRow = db.prepare('SELECT rowid FROM t2_memories WHERE memory_id = ?').get(memId) as any;
    const newVec = Buffer.from(new Float32Array(new Array(384).fill(0.2)).buffer);
    db.prepare('INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)').run(rowRow.rowid, newVec);

    const oldVec = Buffer.from(new Float32Array(new Array(384).fill(0.1)).buffer);
    db.prepare(
      `INSERT INTO t2_vec_history(history_id, memory_id, embedding, embedding_model_version, snapshotted_at, snapshotted_by_cycle)
       VALUES(?, ?, ?, 'v1', ?, 'cycle-test')`
    ).run(crypto.randomUUID(), memId, oldVec, Date.now() - 1000);

    seedAction(db, {
      action_id: 'p7-action',
      phase: 'P7',
      action_type: 'reembed',
      status: 'auto_applied',
      target_ids: [memId],
      payload: { previous_version: 'v1' },
      decided_at: Date.now(),
    });

    revertDreamAction(db, 'p7-action', 'none');

    const mem = db.prepare('SELECT embedding_model_version FROM t2_memories WHERE memory_id = ?').get(memId) as any;
    expect(mem.embedding_model_version).toBe('v1');

    const vec = db.prepare(
      'SELECT embedding FROM t2_vec WHERE rowid = (SELECT rowid FROM t2_memories WHERE memory_id = ?)'
    ).get(memId) as any;
    const arr = new Float32Array(vec.embedding.buffer, vec.embedding.byteOffset, vec.embedding.byteLength / 4);
    expect(arr[0]).toBeCloseTo(0.1);
  });
});

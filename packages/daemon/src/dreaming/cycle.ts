import type { Database } from 'bun:sqlite';
import type { Logger } from '@penumbra/core';
import type { DreamConfig } from './config.js';
import { StubJudgePool, type JudgePool } from './judge-pool.js';

// In-process mutex — prevents concurrent cycles within one daemon process.
// Cross-process safety is handled by runStartupZombieSweep on daemon boot.
export let dreamingCycleInFlight = false;

const MIN_PER_CYCLE_USD = 0.01;
const P2_SCAN_LIMIT = 30;
const P3_SCAN_LIMIT = 20;
const LINK_QUEUE_FLOOR = 0.5;

interface PressureGuard {
  check(): Promise<{ anyThrottled: boolean }>;
}

interface MemoryScorer {
  score(mem: { memory_id: string; body: string }): Promise<{
    verdict: 'retire' | 'rewrite' | 'keep';
    composite: number;
    should_auto_retire: boolean;
  }>;
}

import type { WebResearchAdapter } from '@penumbra/core';
import { runP5Phase } from './research.js';
const { runReembedPhase } = require('./reembed.js');

export interface DreamCycleDeps {
  projectRegistry?: { get(id: string): any; list(): any[] };
  researchAdapter?: WebResearchAdapter;
  memoryObserve?: (briefMarkdown: string, projectId: string, cycleId: string) => Promise<{ memory_id: string }>;
  pressureGuard?: PressureGuard;
  judgePool?: JudgePool;
  scorer?: MemoryScorer;
  onReembed?: (memory_id: string, body: string) => Promise<Float32Array>;
}

export async function runDreamCycle(
  db: Database,
  config: DreamConfig,
  deps: DreamCycleDeps = {},
): Promise<string> {
  const judgePool: JudgePool = deps.judgePool ?? new StubJudgePool();
  const now = Date.now();
  const cycleId = crypto.randomUUID();

  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
     VALUES(?, ?, 'cron', ?, 'running', '[]')`,
  ).run(cycleId, now, config.perCycleUsd);

  const phasesRun: string[] = [];

  function bail(reason: string): string {
    db.prepare(
      `UPDATE dream_cycles
          SET outcome='bailed', bail_reason=?, ended_at=?, phases_run=?, last_phase_completed=?
        WHERE cycle_id=?`,
    ).run(
      reason,
      Date.now(),
      JSON.stringify(phasesRun),
      phasesRun.length > 0 ? phasesRun[phasesRun.length - 1]! : null,
      cycleId,
    );
    return cycleId;
  }

  // ── P0: pre-flight ────────────────────────────────────────────────────────

  // 1. Daily cap
  const todayStartMs = getTodayStartMs();
  const todayRow = db.prepare(
    `SELECT COALESCE(SUM(llm_spent_usd + embedding_spent_usd + research_spent_usd), 0) AS total_today
       FROM dream_cycles
      WHERE started_at >= ? AND outcome != 'crashed'`,
  ).get(todayStartMs) as { total_today: number };

  if ((todayRow?.total_today ?? 0) >= config.dailyUsd) {
    return bail('daily USD cap already reached');
  }

  // 2. Per-cycle sanity floor
  if (config.perCycleUsd < MIN_PER_CYCLE_USD) {
    return bail(`per-cycle USD cap (${config.perCycleUsd}) is too low to run any phase`);
  }

  // 3. Pressure guard
  if (config.pressureGuardEnabled && deps.pressureGuard) {
    const pressure = await deps.pressureGuard.check();
    if (pressure.anyThrottled) {
      return bail('pressure guard: provider throttled or constrained');
    }
  }

  // 4. Mutex acquire
  if (dreamingCycleInFlight) {
    return bail('mutex-held: another cycle is already in flight');
  }
  dreamingCycleInFlight = true;

  phasesRun.push('P0');
  db.prepare(
    `UPDATE dream_cycles SET phases_run=?, last_phase_completed='P0' WHERE cycle_id=?`,
  ).run(JSON.stringify(phasesRun), cycleId);

  // Ensure dreaming Phase B columns are present. This is a no-op on daemons
  // whose schema.ts already includes them; it handles worktrees and daemons
  // that haven't been restarted since the schema migration landed.
  try { db.exec('ALTER TABLE t2_memories ADD COLUMN retired_at INTEGER'); } catch { /* already exists */ }

  try {
    async function checkAdvancement(): Promise<boolean> {
      if (config.pressureGuardEnabled && deps.pressureGuard) {
        const pressure = await deps.pressureGuard.check();
        if (pressure.anyThrottled) return false;
      }
      return true;
    }

    // ── P1: consolidate stale t1 rollups ───────────────────────────────────

    const autoPromoteMinJudges = config.autoPromoteMinJudges ?? 2;

    const claimedRollups = db.prepare(
      `UPDATE t1_rollups
          SET claimed_at = ?, claimed_by_cycle = ?
        WHERE rollup_id IN (
            SELECT rollup_id FROM t1_rollups
             WHERE t2_promoted_at IS NULL AND claimed_at IS NULL
             ORDER BY started_at ASC
             LIMIT ?
        )
        RETURNING rollup_id, first_prompt_excerpt`,
    ).all(now, cycleId, config.p1BatchSize) as Array<{
      rollup_id: string;
      first_prompt_excerpt: string | null;
    }>;

    for (const rollup of claimedRollups) {
      const body = rollup.first_prompt_excerpt ?? rollup.rollup_id;

      // Fan out to all judges; fall back to single judge if judgeAll not available.
      let votes: Array<{ promote: boolean; confidence: number; rationale?: string }>;
      if (judgePool.judgeAll) {
        votes = await judgePool.judgeAll({ body, kind: 'promote_t1' });
      } else {
        const result = await judgePool.judge({ body, kind: 'promote_t1' });
        votes = [{ promote: result.verdict === 'yes', confidence: result.confidence, rationale: result.rationale }];
      }

      const yesCount = votes.filter((v) => v.promote).length;
      const total = votes.length;
      const autoPromote = total >= autoPromoteMinJudges && yesCount >= Math.ceil((total * 2) / 3);
      const avgConfidence = votes.reduce((s, v) => s + v.confidence, 0) / Math.max(total, 1);
      const status = autoPromote ? 'auto_applied' : 'queued';

      if (autoPromote) {
        const nowIso = new Date().toISOString();
        db.prepare(`UPDATE t1_rollups SET t2_promoted_at=? WHERE rollup_id=?`).run(nowIso, rollup.rollup_id);
        const t2Id = crypto.randomUUID();
        db.prepare(
          `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
           VALUES(?, 'system', 'promoted', ?, ?, ?, ?, ?, ?)`,
        ).run(t2Id, nowIso, nowIso, `P1 auto-promote: ${body.slice(0, 80)}`, body, nowIso, nowIso);
      }

      db.prepare(
        `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
         VALUES(?, ?, 'P1', 'promote_t1', ?, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        cycleId,
        avgConfidence,
        status,
        JSON.stringify([rollup.rollup_id]),
        JSON.stringify({ votes: votes.map((v) => ({ promote: v.promote, confidence: v.confidence })) }),
      );
    }

    phasesRun.push('P1');
    db.prepare(
      `UPDATE dream_cycles SET phases_run=?, last_phase_completed='P1' WHERE cycle_id=?`,
    ).run(JSON.stringify(phasesRun), cycleId);

    if (!await checkAdvancement()) {
      return bail('pressure guard: provider throttled after P1');
    }

    // ── P2: link discovery via pairwise cosine ─────────────────────────────

    const recentMemories = db.prepare(
      `SELECT memory_id, rowid FROM t2_memories ORDER BY created_at DESC LIMIT ?`,
    ).all(P2_SCAN_LIMIT) as Array<{ memory_id: string; rowid: number }>;

    const memVecs: Array<{ memory_id: string; vec: Float32Array }> = [];
    for (const mem of recentMemories) {
      const vecRow = db.prepare(
        `SELECT embedding FROM t2_vec WHERE rowid = ?`,
      ).get(mem.rowid) as { embedding: Uint8Array } | null;

      if (vecRow?.embedding) {
        const buf = vecRow.embedding;
        const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        memVecs.push({ memory_id: mem.memory_id, vec: float32 });
      }
    }

    const minted_at = Date.now();
    for (let i = 0; i < memVecs.length; i++) {
      for (let j = i + 1; j < memVecs.length; j++) {
        const src = memVecs[i]!;
        const dst = memVecs[j]!;
        const cosine = computeCosine(src.vec, dst.vec);

        if (cosine >= config.linkAutoThreshold) {
          const existing = db.prepare(
            `SELECT 1 FROM memory_links
              WHERE src_id=? AND dst_id=? AND link_type='semantic_near' LIMIT 1`,
          ).get(src.memory_id, dst.memory_id);

          if (!existing) {
            db.prepare(
              `INSERT OR IGNORE INTO memory_links(link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle)
               VALUES(?, ?, ?, 'semantic_near', ?, ?, ?)`,
            ).run(crypto.randomUUID(), src.memory_id, dst.memory_id, cosine, minted_at, cycleId);

            db.prepare(
              `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
               VALUES(?, ?, 'P2', 'link', ?, 'auto_applied', ?, ?)`,
            ).run(
              crypto.randomUUID(),
              cycleId,
              cosine,
              JSON.stringify([src.memory_id, dst.memory_id]),
              JSON.stringify({ link_type: 'semantic_near' }),
            );
          }
        } else if (cosine >= LINK_QUEUE_FLOOR) {
          db.prepare(
            `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
             VALUES(?, ?, 'P2', 'link', ?, 'queued', ?, ?)`,
          ).run(
            crypto.randomUUID(),
            cycleId,
            cosine,
            JSON.stringify([src.memory_id, dst.memory_id]),
            JSON.stringify({ link_type: 'semantic_near' }),
          );
        }
      }
    }

    phasesRun.push('P2');
    db.prepare(
      `UPDATE dream_cycles SET phases_run=?, last_phase_completed='P2' WHERE cycle_id=?`,
    ).run(JSON.stringify(phasesRun), cycleId);

    if (!await checkAdvancement()) {
      return bail('pressure guard: provider throttled after P2');
    }

    // ── P3: multi-factor quality signal ───────────────────────────────────

    if (deps.scorer) {
      const memories = db.prepare(
        `SELECT memory_id, body FROM t2_memories
          WHERE retired_at IS NULL
          ORDER BY created_at ASC LIMIT ?`,
      ).all(P3_SCAN_LIMIT) as Array<{ memory_id: string; body: string }>;

      for (const mem of memories) {
        const result = await deps.scorer.score(mem);

        if (result.should_auto_retire) {
          db.prepare(`UPDATE t2_memories SET retired_at=? WHERE memory_id=?`).run(
            Date.now(),
            mem.memory_id,
          );
          db.prepare(
            `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
             VALUES(?, ?, 'P3', 'retire', ?, 'auto_applied', ?, ?)`,
          ).run(
            crypto.randomUUID(),
            cycleId,
            result.composite,
            JSON.stringify([mem.memory_id]),
            JSON.stringify({ source: 'quality_signal' }),
          );
        } else if (result.verdict === 'rewrite') {
          db.prepare(
            `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
             VALUES(?, ?, 'P3', 'rewrite', ?, 'queued', ?, ?)`,
          ).run(
            crypto.randomUUID(),
            cycleId,
            result.composite,
            JSON.stringify([mem.memory_id]),
            JSON.stringify({ source: 'quality_signal' }),
          );
        } else if (result.verdict === 'retire') {
          db.prepare(
            `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
             VALUES(?, ?, 'P3', 'retire', ?, 'queued', ?, ?)`,
          ).run(
            crypto.randomUUID(),
            cycleId,
            result.composite,
            JSON.stringify([mem.memory_id]),
            JSON.stringify({ source: 'quality_signal' }),
          );
        }
      }
    }

    phasesRun.push('P3');
    db.prepare(
      `UPDATE dream_cycles SET phases_run=?, last_phase_completed='P3' WHERE cycle_id=?`,
    ).run(JSON.stringify(phasesRun), cycleId);

    if (!await checkAdvancement()) {
      return bail('pressure guard: provider throttled after P3');
    }

    // ── P4: bounded discovery queue ────────────────────────────────────────

    const p4QueueMax = config.p4QueueMax ?? 1000;
    const nowMs = Date.now();

    // Proactive eviction: remove the oldest-expired queued P4 action when at capacity.
    const p4Count = (
      db.prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND status='queued'`).get() as {
        n: number;
      }
    ).n;
    if (p4Count >= p4QueueMax) {
      db.prepare(
        `DELETE FROM dream_actions WHERE action_id = (
           SELECT action_id FROM dream_actions
            WHERE phase='P4' AND status='queued' AND expires_at IS NOT NULL AND expires_at < ?
            ORDER BY expires_at ASC LIMIT 1
         )`,
      ).run(nowMs);
    }

    // Contradiction detection from memory_links.
    const contradictions = db.prepare(
      `SELECT src_id, dst_id FROM memory_links WHERE link_type='contradicts' AND retired_at IS NULL`,
    ).all() as Array<{ src_id: string; dst_id: string }>;

    for (const c of contradictions) {
      // Normalize pair order for stable dedup key.
      const targetIds = JSON.stringify([c.src_id, c.dst_id].sort());
      const existing = db.prepare(
        `SELECT 1 FROM dream_actions
          WHERE action_type='resolve_contradiction' AND status='queued' AND target_ids=? LIMIT 1`,
      ).get(targetIds);
      if (!existing) {
        db.prepare(
          `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
           VALUES(?, ?, 'P4', 'resolve_contradiction', 0.9, 'queued', ?, ?)`,
        ).run(
          crypto.randomUUID(),
          cycleId,
          targetIds,
          JSON.stringify({ link_type: 'contradicts' }),
        );
      }
    }

    // Re-derivation clustering via t1_rollup cosine is deferred: t1_rollups
    // have no embedding vectors in the current schema (Task 2.2 will add them).

    phasesRun.push('P4');
    db.prepare(
      `UPDATE dream_cycles SET phases_run=?, last_phase_completed='P4' WHERE cycle_id=?`,
    ).run(JSON.stringify(phasesRun), cycleId);

    
    // ── P5: active research ──────────────────────────────────────────────────────────

    if (typeof runP5Phase !== 'undefined') await runP5Phase(db, cycleId, config, deps as any);
    phasesRun.push('P5');
    db.prepare(
      "UPDATE dream_cycles SET phases_run=?, last_phase_completed='P5' WHERE cycle_id=?"
    ).run(JSON.stringify(phasesRun), cycleId);

    if (!await checkAdvancement()) {
      return bail('pressure guard: provider throttled after P5');
    }

    // ── P6: brief refresh ────────────────────────────────────────────────────────────

    if (deps.projectRegistry && deps.memoryObserve) {
      const projects = deps.projectRegistry.list();
      for (const p of projects) {
        if (!p.dreaming) continue;
        
        const briefMarkdown = "# Project Brief: " + p.project_id + "\nGenerated by P6.";
        
        try {
          const { memory_id } = await deps.memoryObserve(briefMarkdown, p.project_id, cycleId);
          db.prepare(
            "INSERT OR REPLACE INTO project_briefs(project_id, brief_md, source_memory_ids, generated_at, generated_by_cycle, t2_shadow_memory_id) VALUES(?, ?, '[]', ?, ?, ?)"
          ).run(p.project_id, briefMarkdown, Date.now(), cycleId, memory_id);
        } catch (err) {
          console.error("P6 INSERT ERROR:", err);
        }
      }
    }

    phasesRun.push('P6');
    db.prepare(
      "UPDATE dream_cycles SET phases_run=?, last_phase_completed='P6' WHERE cycle_id=?"
    ).run(JSON.stringify(phasesRun), cycleId);

    if (!await checkAdvancement()) {
      return bail('pressure guard: provider throttled after P6');
    }

    // ── P8: audit ──────────────────────────────────────────────────────────

    phasesRun.push('P8');
    db.prepare(
      `UPDATE dream_cycles
          SET outcome='completed', ended_at=?, phases_run=?, last_phase_completed='P8'
        WHERE cycle_id=?`,
    ).run(Date.now(), JSON.stringify(phasesRun), cycleId);

    return cycleId;
  } finally {
    dreamingCycleInFlight = false;
  }
}

export function startDreamingCron(deps: {
  db: Database;
  config: DreamConfig;
  log?: Logger;
}): () => void {
  const intervalMs = deps.config.cronMinutes * 60 * 1000;
  const timer = setInterval(async () => {
    try {
      await runDreamCycle(deps.db, deps.config);
    } catch (err) {
      (deps.log as any)?.warn?.({ err: String(err) }, 'dreaming: cycle failed unexpectedly');
    }
  }, intervalMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  return () => clearInterval(timer);
}

function getTodayStartMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function computeCosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

import type { Database } from 'bun:sqlite';
import type { Logger } from '@penumbra/core';
import type { DreamConfig } from './config.js';
import { StubJudgePool, type JudgePool } from './judge-pool.js';

// In-process mutex — prevents concurrent cycles within one daemon process.
// Cross-process safety is handled by runStartupZombieSweep on daemon boot.
let dreamingCycleInFlight = false;

const MIN_PER_CYCLE_USD = 0.01;
const P2_SCAN_LIMIT = 30;
const LINK_QUEUE_FLOOR = 0.5;

interface PressureGuard {
  check(): Promise<{ anyThrottled: boolean }>;
}

export interface DreamCycleDeps {
  pressureGuard?: PressureGuard;
  judgePool?: JudgePool;
}

export async function runDreamCycle(
  db: Database,
  config: DreamConfig,
  deps: DreamCycleDeps = {},
): Promise<string> {
  const judgePool = deps.judgePool ?? new StubJudgePool();
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

  try {
    async function checkAdvancement(): Promise<boolean> {
      if (config.pressureGuardEnabled && deps.pressureGuard) {
        const pressure = await deps.pressureGuard.check();
        if (pressure.anyThrottled) return false;
      }
      return true;
    }

    // ── P1: consolidate stale t1 rollups ───────────────────────────────────

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
      const result = await judgePool.judge({ body, kind: 'promote_t1' });

      db.prepare(
        `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
         VALUES(?, ?, 'P1', 'promote_t1', ?, 'queued', ?, ?)`,
      ).run(
        crypto.randomUUID(),
        cycleId,
        result.confidence,
        JSON.stringify([rollup.rollup_id]),
        JSON.stringify({ verdict: result.verdict, rationale: result.rationale ?? null }),
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

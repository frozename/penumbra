import type { Database } from "bun:sqlite";
import type { DispatchEventInput, Logger } from "@penumbra/core";
import { buildT2EmbedText, retireNonDirectMemory } from "@penumbra/core";
import { releaseT1RollupClaims } from "../../../core/src/db/schema.js";
import { z } from "zod";
import type {
  DreamConfig,
  DreamPhaseBudgetFractions,
  DreamPhaseCostEstimatesUsd,
} from "./config.js";
import { StubJudgePool, type JudgePool } from "./judge-pool.js";
import type { WebResearchAdapter } from "@penumbra/core";
import { hashQuery, runP5Phase } from "./research.js";
const { runReembedPhase } = require("./reembed.js");
import type { BriefSynthesizer } from "./brief-synthesizer.js";
import { sanitizeTitleForQuery } from "./query-sanitize.js";
import type { ContentQualityJudge } from "./curator/content-quality-judge.js";
import { runPC1Phase } from "./curator/pc1-ephemera.js";
import { runPC2Phase } from "./curator/pc2-cluster.js";
import { isWebSearchable } from "./query-rewriting.js";
import { buildDreamQueryRewritePrompt } from "./dream-rewriter-prompt.js";
import {
  getRewriteForMemory,
  pruneExpiredRewriteCache,
  setRewriteForMemory,
} from "./query-rewriter-cache.js";
import { REWRITE_RESPONSE_SCHEMA } from "./dream-rewriter-prompt-content.js";
import {
  llmInvoke as realLlmInvoke,
  type LlmInvokeInput,
  type LlmInvokeResult,
} from "../services/llm-invoke.js";

// In-process mutex — prevents concurrent cycles within one daemon process.
// Cross-process safety is handled by runStartupZombieSweep on daemon boot.
export let dreamingCycleInFlight = false;

const MIN_PER_CYCLE_USD = 0.01;
const P2_SCAN_LIMIT = 30;
const P3_SCAN_LIMIT = 20;
const LINK_QUEUE_FLOOR = 0.5;
export const P1_CLAIM_TTL_MS = 60 * 60_000;
const TERMINAL_DREAM_CYCLE_OUTCOMES = [
  "bailed",
  "completed",
  "completed_with_curator_error",
  "crashed",
] as const;
const ZERO_SPEND = { llm: 0, embedding: 0, research: 0 } as const;
const DEFAULT_PHASE_BUDGET_FRACTIONS: DreamPhaseBudgetFractions = {
  llm: 0.3,
  embedding: 0.2,
  research: 0.5,
};
const DEFAULT_PHASE_COST_ESTIMATES_USD: DreamPhaseCostEstimatesUsd = {
  p3ScorerLlmUsd: 0.02,
  p4RewriterLlmUsd: 0.01,
  p5ResearchUsd: 0.05,
  p6BriefSynthLlmUsd: 0.04,
  p7EmbedUsd: 0.005,
};
export const EPHEMERA_PROMPT_LIKE_PATTERNS = [
  "You are %a long-lived agent%",
  "%# Operating rules%",
  "%IMPLEMENTER MODE%",
  "Fix:%",
  "Implement %",
  "Feature: %",
] as const;
const EPHEMERA_PROMPT_NOT_LIKE_CLAUSE = EPHEMERA_PROMPT_LIKE_PATTERNS.map(
  () => "first_prompt_excerpt NOT LIKE ?",
).join(" AND ");
const KNOWN_LONG_LIVED_DISPATCHER_USER_IDS = ["473ff22b-fa37-4707-b75c-9ecac18142aa"];

interface PressureGuard {
  check(): Promise<{ anyThrottled: boolean }>;
}

interface MemoryScorer {
  estimateCostUsd?: (mem: { memory_id: string; body: string }) => number;
  score(mem: { memory_id: string; body: string }): Promise<{
    verdict: "retire" | "rewrite" | "keep";
    composite: number;
    should_auto_retire: boolean;
    estimated_cost_usd?: number;
  }>;
}

export type DreamSpendLane = "llm" | "embedding" | "research";

export interface DreamCostMeter {
  canAfford(phase: string, lane: DreamSpendLane, usd: number): boolean;
  record(phase: string, lane: DreamSpendLane, usd: number): void;
}

type RewriteLlmInvoker = <T extends z.ZodTypeAny>(
  input: LlmInvokeInput<T>,
) => Promise<LlmInvokeResult<T>>;

export interface DreamCycleDeps {
  log?: Logger;
  projectRegistry?: { get(id: string): any; list(): any[] };
  getResearchAdapter?: (project: any) => WebResearchAdapter | null;
  memoryObserve?: (
    briefMarkdown: string,
    projectId: string,
    cycleId: string,
    opts?: { session_id?: string | null },
  ) => Promise<{ memory_id: string }>;
  pressureGuard?: PressureGuard;
  judgePool?: JudgePool;
  scorer?: MemoryScorer;
  onReembed?: (memory_id: string, text: string) => Promise<Float32Array>;
  briefSynthesizer?: BriefSynthesizer;
  contentQualityJudge?: ContentQualityJudge;
  llmInvoke?: RewriteLlmInvoker;
  dispatchEventLog?: {
    record(event: DispatchEventInput): void;
  };
  costMeter?: DreamCostMeter;
  phaseCostEstimates?: DreamPhaseCostEstimatesUsd;
}

export async function runDreamCycle(
  db: Database,
  config: DreamConfig,
  deps: DreamCycleDeps = {},
): Promise<string> {
  const judgePool: JudgePool = deps.judgePool ?? new StubJudgePool();
  const invokeLlm: RewriteLlmInvoker = deps.llmInvoke ?? realLlmInvoke;
  const now = Date.now();
  const cycleId = crypto.randomUUID();

  const rewriterEnabled = config.rewriterEnabled ?? false;
  const rewriterModel = config.rewriterModel ?? "granite-4.1-3b";
  const rewriterBaseUrl = config.rewriterBaseUrl ?? "http://127.0.0.1:7944";
  const rewriterTimeoutMs = Number.isFinite(config.rewriterTimeoutMs)
    ? config.rewriterTimeoutMs
    : 5000;
  const rewriterCacheTtlMs = Number.isFinite(config.rewriterCacheTtlMs)
    ? config.rewriterCacheTtlMs
    : 30 * 86_400_000;
  const rewriterConcurrency = Number.isFinite(config.rewriterConcurrency)
    ? Math.max(1, config.rewriterConcurrency)
    : 4;
  const p4QueuedQueryExistsStmt = db.prepare(
    `SELECT 1 FROM dream_actions
      WHERE phase='P4'
        AND action_type='research_query'
        AND status IN ('queued', 'approved')
        AND target_ids=?
      LIMIT 1`,
  );
  const hasDreamResearchCache =
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='dream_research_cache'`)
      .get() !== null;
  const p4NegativeSentinelStmt = hasDreamResearchCache
    ? db.prepare(
        `SELECT 1 FROM dream_research_cache
          WHERE cache_key=?
            AND is_negative=1
            AND expires_at > ?`,
      )
    : null;
  const p4QueueCountStmt = db.prepare(
    `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND status='queued'`,
  );
  const p2QueuedLinkExistsStmt = db.prepare(
    `SELECT 1 FROM dream_actions
      WHERE action_type='link'
        AND status='queued'
        AND target_ids IN (?, ?)
      LIMIT 1`,
  );

  function emitDreamEvent(kind: DispatchEventInput["kind"], meta: Record<string, unknown>): void {
    if (!deps.dispatchEventLog) return;
    deps.dispatchEventLog.record({
      handoff_id: cycleId,
      source: "daemon",
      kind,
      ts: new Date().toISOString(),
      meta,
    });
  }

  async function runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number,
  ): Promise<T[]> {
    const safeConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.trunc(concurrency)) : 1;
    const limit = Math.max(1, safeConcurrency);
    const results = new Array<T>(tasks.length);
    let cursor = 0;

    const workers = new Array(Math.min(limit, tasks.length)).fill(null).map(async () => {
      while (cursor < tasks.length) {
        const current = cursor++;
        const task = tasks[current];
        if (!task) continue;
        results[current] = await task();
      }
    });
    await Promise.all(workers);
    return results;
  }

  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
     VALUES(?, ?, 'cron', ?, 'running', '[]')`,
  ).run(cycleId, now, config.perCycleUsd);

  const budgetFractions = normalizeBudgetFractions(config.phaseBudgetFractions);
  const phaseCostEstimates = normalizeCostEstimates(
    config.phaseCostEstimatesUsd ?? deps.phaseCostEstimates,
  );
  const deferredPhases = new Set<string>();
  const phasesRun: string[] = [];
  const todayStartMs = getTodayStartMs();

  const costMeter: DreamCostMeter = {
    canAfford: (phase, lane, usd) => {
      const normalizedUsd = sanitizeUsd(usd);
      if (normalizedUsd <= 0) return true;
      const cycleSpend = getCycleSpend(db, cycleId);
      const dailySpend = getTodayLaneSpend(db, lane, todayStartMs);
      const laneFraction = budgetFractions[lane];
      const perCycleLaneCap = config.perCycleUsd * laneFraction;
      const dailyLaneCap = config.dailyUsd * laneFraction;
      if (cycleSpend[lane] + normalizedUsd > perCycleLaneCap) {
        deferredPhases.add(phase);
        return false;
      }
      if (dailySpend + normalizedUsd > dailyLaneCap) {
        deferredPhases.add(phase);
        return false;
      }
      return true;
    },
    record: (phase, lane, usd) => {
      const normalizedUsd = sanitizeUsd(usd);
      if (normalizedUsd <= 0) return;
      if (lane === "llm") {
        recordSpend(db, cycleId, { llm: normalizedUsd });
      } else if (lane === "embedding") {
        recordSpend(db, cycleId, { embedding: normalizedUsd });
      } else {
        recordSpend(db, cycleId, { research: normalizedUsd });
      }
      deferredPhases.delete(phase);
    },
  };
  deps.costMeter = costMeter;

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

  function phaseStart(phase: string): number {
    deps.log?.info({ phase, cycleId }, "dream-cycle phase start");
    return Date.now();
  }

  function phaseEnd(phase: string, startMs: number): void {
    const durationMs = Date.now() - startMs;
    phasesRun.push(phase);
    db.prepare(`UPDATE dream_cycles SET phases_run=?, last_phase_completed=? WHERE cycle_id=?`).run(
      JSON.stringify(phasesRun),
      phase,
      cycleId,
    );
    deps.log?.info({ phase, cycleId, durationMs }, "dream-cycle phase end");
  }

  // ── P0: pre-flight ────────────────────────────────────────────────────────
  const p0Start = phaseStart("P0");
  const bailP0 = (reason: string): string => {
    phaseEnd("P0", p0Start);
    return bail(reason);
  };

  // 1. Daily cap
  const todayRow = db
    .prepare(
      `SELECT COALESCE(SUM(llm_spent_usd + embedding_spent_usd + research_spent_usd), 0) AS total_today
       FROM dream_cycles
      WHERE started_at >= ? AND outcome != 'crashed'`,
    )
    .get(todayStartMs) as { total_today: number };

  if (config.dailyUsd > 0 && (todayRow?.total_today ?? 0) >= config.dailyUsd) {
    return bailP0("daily USD cap already reached");
  }

  // 2. Per-cycle sanity floor
  if (config.perCycleUsd > 0 && config.perCycleUsd < MIN_PER_CYCLE_USD) {
    return bailP0(`per-cycle USD cap (${config.perCycleUsd}) is too low to run any phase`);
  }

  // 3. Pressure guard
  if (config.pressureGuardEnabled && deps.pressureGuard) {
    const pressure = await deps.pressureGuard.check();
    if (pressure.anyThrottled) {
      return bailP0("pressure guard: provider throttled or constrained");
    }
  }

  // 4. Mutex acquire
  if (dreamingCycleInFlight) {
    return bailP0("mutex-held: another cycle is already in flight");
  }
  dreamingCycleInFlight = true;

  phaseEnd("P0", p0Start);

  // Ensure dreaming Phase B columns are present. This is a no-op on daemons
  // whose schema.ts already includes them; it handles worktrees and daemons
  // that haven't been restarted since the schema migration landed.
  try {
    db.exec("ALTER TABLE t2_memories ADD COLUMN retired_at INTEGER");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE t1_rollups ADD COLUMN project_id TEXT");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE t2_memories ADD COLUMN project_id TEXT");
  } catch {
    /* already exists */
  }

  try {
    async function checkAdvancement(): Promise<boolean> {
      if (config.pressureGuardEnabled && deps.pressureGuard) {
        const pressure = await deps.pressureGuard.check();
        if (pressure.anyThrottled) return false;
      }
      return true;
    }

    // ── P1: consolidate stale t1 rollups ───────────────────────────────────
    const p1Start = phaseStart("P1");

    const autoPromoteMinJudges = config.autoPromoteMinJudges ?? 2;
    const longLivedDispatcherFilter = KNOWN_LONG_LIVED_DISPATCHER_USER_IDS.length
      ? `AND (user_id IS NULL OR user_id NOT IN (${KNOWN_LONG_LIVED_DISPATCHER_USER_IDS.map(() => "?").join(",")}))`
      : "";
    const t1Columns = db.prepare(`PRAGMA table_info(t1_rollups)`).all() as Array<{
      name?: string | null;
    }>;
    const t2Columns = db.prepare(`PRAGMA table_info(t2_memories)`).all() as Array<{
      name?: string | null;
    }>;
    const hasT1ProjectId = t1Columns.some((column) => column.name === "project_id");
    const hasT2ProjectId = t2Columns.some((column) => column.name === "project_id");
    const seenLegacyProjectlessMemoryIds = new Set<string>();

    releaseT1RollupClaims(db, {
      terminalOutcomes: TERMINAL_DREAM_CYCLE_OUTCOMES,
      staleBeforeMs: now - P1_CLAIM_TTL_MS,
    });

    let claimedRollups: Array<{
      rollup_id: string;
      first_prompt_excerpt: string | null;
      project_id: string | null;
    }>;
    if (hasT1ProjectId) {
      claimedRollups = db
        .prepare(
          `UPDATE t1_rollups
            SET claimed_at = ?, claimed_by_cycle = ?
          WHERE rollup_id IN (
              SELECT rollup_id FROM (
                SELECT rollup_id, project_id FROM t1_rollups
                   WHERE t2_promoted_at IS NULL
                     AND claimed_at IS NULL
                     AND (first_prompt_excerpt IS NULL OR (${EPHEMERA_PROMPT_NOT_LIKE_CLAUSE}))
                     ${longLivedDispatcherFilter}
                     ORDER BY started_at ASC
                     LIMIT ?
                )
          )
          RETURNING rollup_id, first_prompt_excerpt, project_id`,
        )
        .all(
          now,
          cycleId,
          ...KNOWN_LONG_LIVED_DISPATCHER_USER_IDS,
          ...EPHEMERA_PROMPT_LIKE_PATTERNS,
          config.p1BatchSize,
        ) as Array<{
        rollup_id: string;
        first_prompt_excerpt: string | null;
        project_id: string | null;
      }>;
    } else {
      const rows = db
        .prepare(
          `UPDATE t1_rollups
            SET claimed_at = ?, claimed_by_cycle = ?
          WHERE rollup_id IN (
            SELECT rollup_id FROM t1_rollups
              WHERE t2_promoted_at IS NULL
                AND claimed_at IS NULL
                AND (first_prompt_excerpt IS NULL OR (${EPHEMERA_PROMPT_NOT_LIKE_CLAUSE}))
                ${longLivedDispatcherFilter}
              ORDER BY started_at ASC
                LIMIT ?
          )
          RETURNING rollup_id, first_prompt_excerpt`,
        )
        .all(
          now,
          cycleId,
          ...KNOWN_LONG_LIVED_DISPATCHER_USER_IDS,
          ...EPHEMERA_PROMPT_LIKE_PATTERNS,
          config.p1BatchSize,
        ) as Array<{ rollup_id: string; first_prompt_excerpt: string | null }>;
      claimedRollups = rows.map((row) => ({ ...row, project_id: null }));
    }

    for (const rollup of claimedRollups) {
      const body = rollup.first_prompt_excerpt;
      if (!body || body.trim().length < 40) continue;

      // Fan out to all judges; fall back to single judge if judgeAll not available.
      let votes: Array<{ promote: boolean; confidence: number; rationale?: string }>;
      if (judgePool.judgeAll) {
        votes = await judgePool.judgeAll({ body, kind: "promote_t1" });
      } else {
        const result = await judgePool.judge({ body, kind: "promote_t1" });
        votes = [
          {
            promote: result.verdict === "yes",
            confidence: result.confidence,
            rationale: result.rationale,
          },
        ];
      }

      const yesCount = votes.filter((v) => v.promote).length;
      const total = votes.length;
      const autoPromote = total >= autoPromoteMinJudges && yesCount >= Math.ceil((total * 2) / 3);
      const avgConfidence = votes.reduce((s, v) => s + v.confidence, 0) / Math.max(total, 1);
      let status = autoPromote ? "auto_applied" : "queued";

      let mintedT2Id: string | undefined;
      if (autoPromote) {
        const nowIso = new Date().toISOString();
        const proposedTitle = `P1 auto-promote: ${body.slice(0, 80)}`;
        const existing = (
          hasT2ProjectId
            ? db
                .prepare(
                  `SELECT memory_id FROM t2_memories
                 WHERE retired_at IS NULL
                   AND COALESCE(project_id, '') = COALESCE(?, '')
                   AND title = ?
                 LIMIT 1`,
                )
                .get(rollup.project_id, proposedTitle)
            : db
                .prepare(
                  `SELECT memory_id FROM t2_memories
                 WHERE retired_at IS NULL
                   AND title = ?
                 LIMIT 1`,
                )
                .get(proposedTitle)
        ) as { memory_id: string } | undefined;
        if (existing) {
          db.prepare(
            `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
             VALUES(?, ?, 'P1', 'promote_t1', ?, 'queued', ?, ?)`,
          ).run(
            crypto.randomUUID(),
            cycleId,
            avgConfidence,
            JSON.stringify([rollup.rollup_id]),
            JSON.stringify({
              votes: votes.map((v) => ({ promote: v.promote, confidence: v.confidence })),
              dedup_against: existing.memory_id,
              project_id: rollup.project_id,
            }),
          );
          continue;
        }
        if (!deps.onReembed) {
          status = "queued";
          console.warn(
            `P1 auto-promote skipped for rollup ${rollup.rollup_id}: onReembed handler unavailable`,
          );
        } else {
          const currentModelVersion = process.env.PENUMBRA_EMBEDDING_MODEL_VERSION || "v1";
          const candidateMemoryId = crypto.randomUUID();
          const candidateTitle = `P1 auto-promote: ${body.slice(0, 80)}`;
          const embedText = buildT2EmbedText(candidateTitle, body);
          try {
            const vec = await deps.onReembed(candidateMemoryId, embedText);

            try {
              db.transaction(() => {
                if (hasT2ProjectId) {
                  db.prepare(
                    `INSERT INTO t2_memories(memory_id, user_id, project_id, kind, window_start, window_end, title, body, created_at, updated_at, embedding_model_version)
                     VALUES(?, 'system', ?, 'promoted', ?, ?, ?, ?, ?, ?, ?)`,
                  ).run(
                    candidateMemoryId,
                    rollup.project_id,
                    nowIso,
                    nowIso,
                    candidateTitle,
                    body,
                    nowIso,
                    nowIso,
                    currentModelVersion,
                  );
                } else {
                  db.prepare(
                    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, embedding_model_version)
                     VALUES(?, 'system', 'promoted', ?, ?, ?, ?, ?, ?, ?)`,
                  ).run(
                    candidateMemoryId,
                    nowIso,
                    nowIso,
                    candidateTitle,
                    body,
                    nowIso,
                    nowIso,
                    currentModelVersion,
                  );
                }
                const inserted = db
                  .prepare(`SELECT rowid FROM t2_memories WHERE memory_id = ?`)
                  .get(candidateMemoryId) as { rowid: number } | null;
                if (!inserted) throw new Error("inserted t2 memory missing rowid");
                db.prepare(`INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)`).run(
                  inserted.rowid,
                  vec,
                );
                db.prepare(`UPDATE t1_rollups SET t2_promoted_at=? WHERE rollup_id=?`).run(
                  nowIso,
                  rollup.rollup_id,
                );
              })();
              mintedT2Id = candidateMemoryId;
            } catch (err) {
              status = "queued";
              console.error(
                `P1 auto-promote promotion transaction failed for rollup ${rollup.rollup_id}; promotion skipped`,
                err,
              );
            }
          } catch (err) {
            status = "queued";
            console.error(
              `P1 auto-promote embed failed for rollup ${rollup.rollup_id}; promotion skipped`,
              err,
            );
          }
        }
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
        JSON.stringify({
          votes: votes.map((v) => ({ promote: v.promote, confidence: v.confidence })),
          ...(mintedT2Id ? { t2_memory_id: mintedT2Id } : {}),
        }),
      );
    }

    phaseEnd("P1", p1Start);

    if (!(await checkAdvancement())) {
      return bail("pressure guard: provider throttled after P1");
    }

    // ── P2: link discovery via pairwise cosine ─────────────────────────────
    const p2Start = phaseStart("P2");

    const recentMemories = db
      .prepare(`SELECT memory_id, rowid FROM t2_memories ORDER BY created_at DESC LIMIT ?`)
      .all(P2_SCAN_LIMIT) as Array<{ memory_id: string; rowid: number }>;

    const memVecs: Array<{ memory_id: string; vec: Float32Array }> = [];
    for (const mem of recentMemories) {
      const vecRow = db.prepare(`SELECT embedding FROM t2_vec WHERE rowid = ?`).get(mem.rowid) as {
        embedding: Uint8Array;
      } | null;

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
          const existing = db
            .prepare(
              `SELECT 1 FROM memory_links
              WHERE src_id=? AND dst_id=? AND link_type='semantic_near' LIMIT 1`,
            )
            .get(src.memory_id, dst.memory_id);

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
              JSON.stringify({ link_type: "semantic_near" }),
            );
          }
        } else if (cosine >= LINK_QUEUE_FLOOR) {
          const targetIds = JSON.stringify([src.memory_id, dst.memory_id]);
          const reverseTargetIds = JSON.stringify([dst.memory_id, src.memory_id]);
          const existingQueuedLink = p2QueuedLinkExistsStmt.get(targetIds, reverseTargetIds);
          if (existingQueuedLink) continue;

          db.prepare(
            `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
             VALUES(?, ?, 'P2', 'link', ?, 'queued', ?, ?)`,
          ).run(
            crypto.randomUUID(),
            cycleId,
            cosine,
            targetIds,
            JSON.stringify({ link_type: "semantic_near" }),
          );
        }
      }
    }

    phaseEnd("P2", p2Start);

    if (!(await checkAdvancement())) {
      return bail("pressure guard: provider throttled after P2");
    }

    // ── P3: multi-factor quality signal ───────────────────────────────────
    const p3Start = phaseStart("P3");

    let ranP3 = false;
    if (deps.scorer) {
      const memories = db
        .prepare(
          `SELECT memory_id, body FROM t2_memories
          WHERE retired_at IS NULL
          ORDER BY created_at ASC LIMIT ?`,
        )
        .all(P3_SCAN_LIMIT) as Array<{ memory_id: string; body: string }>;

      for (const mem of memories) {
        const estimatedScoringCost =
          sanitizeUsd(deps.scorer.estimateCostUsd?.(mem)) || phaseCostEstimates.p3ScorerLlmUsd;
        if (!costMeter.canAfford("P3", "llm", estimatedScoringCost)) {
          break;
        }
        const result = await deps.scorer.score(mem);
        costMeter.record(
          "P3",
          "llm",
          sanitizeUsd(result.estimated_cost_usd) || estimatedScoringCost,
        );
        ranP3 = true;

        if (result.should_auto_retire) {
          const retired = retireNonDirectMemory(db, mem.memory_id, Date.now());
          db.prepare(
            `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
             VALUES(?, ?, 'P3', 'retire', ?, ?, ?, ?)`,
          ).run(
            crypto.randomUUID(),
            cycleId,
            result.composite,
            retired ? "auto_applied" : "skipped_direct_origin",
            JSON.stringify([mem.memory_id]),
            JSON.stringify({ source: "quality_signal" }),
          );
        } else if (result.verdict === "rewrite") {
          db.prepare(
            `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
             VALUES(?, ?, 'P3', 'rewrite', ?, 'queued', ?, ?)`,
          ).run(
            crypto.randomUUID(),
            cycleId,
            result.composite,
            JSON.stringify([mem.memory_id]),
            JSON.stringify({ source: "quality_signal" }),
          );
        } else if (result.verdict === "retire") {
          db.prepare(
            `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
             VALUES(?, ?, 'P3', 'retire', ?, 'queued', ?, ?)`,
          ).run(
            crypto.randomUUID(),
            cycleId,
            result.composite,
            JSON.stringify([mem.memory_id]),
            JSON.stringify({ source: "quality_signal" }),
          );
        }
      }
    }

    if (ranP3 || !deferredPhases.has("P3")) {
      phaseEnd("P3", p3Start);
    }

    if (!(await checkAdvancement())) {
      return bail("pressure guard: provider throttled after P3");
    }

    // ── P4: bounded discovery queue ────────────────────────────────────────
    const p4Start = phaseStart("P4");

    const p4QueueMax = config.p4QueueMax ?? 1000;
    const nowMs = Date.now();
    const p4MemoryByProjectStmt = hasT2ProjectId
      ? db.prepare(
          `SELECT memory_id, title, SUBSTR(body, 1, 200) AS body, updated_at
             FROM t2_memories
            WHERE project_id = ?
              AND kind NOT IN ('brief')
              AND retired_at IS NULL
              AND title IS NOT NULL
              AND title != ''
            ORDER BY created_at DESC
            LIMIT 2`,
        )
      : db.prepare(
          `SELECT memory_id, title, SUBSTR(body, 1, 200) AS body, updated_at
             FROM t2_memories
            WHERE kind NOT IN ('brief')
              AND retired_at IS NULL
              AND title IS NOT NULL
              AND title != ''
            ORDER BY created_at DESC
            LIMIT 2`,
        );

    // Proactive eviction: remove the oldest-expired queued P4 action when at capacity.
    const p4Count = (
      db
        .prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND status='queued'`)
        .get() as {
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
    const contradictions = db
      .prepare(
        `SELECT src_id, dst_id FROM memory_links WHERE link_type='contradicts' AND retired_at IS NULL`,
      )
      .all() as Array<{ src_id: string; dst_id: string }>;

    for (const c of contradictions) {
      // Normalize pair order for stable dedup key.
      const targetIds = JSON.stringify([c.src_id, c.dst_id].sort());
      const existing = db
        .prepare(
          `SELECT 1 FROM dream_actions
          WHERE action_type='resolve_contradiction' AND status='queued' AND target_ids=? LIMIT 1`,
        )
        .get(targetIds);
      if (!existing) {
        db.prepare(
          `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
           VALUES(?, ?, 'P4', 'resolve_contradiction', 0.9, 'queued', ?, ?)`,
        ).run(
          crypto.randomUUID(),
          cycleId,
          targetIds,
          JSON.stringify({ link_type: "contradicts" }),
        );
      }
    }

    // Re-derivation clustering via t1_rollup cosine is deferred: t1_rollups
    // have no embedding vectors in the current schema (Task 2.2 will add them).

    // Research query seeding: for each project with an active research provider,
    // mint up to 2 research_query actions sourced from recent t1_rollup excerpts.
    const gateEnabled = process.env.PENUMBRA_DREAMING_QUERY_GATE_ENABLED !== "0";
    pruneExpiredRewriteCache(db, nowMs);

    if (deps.projectRegistry) {
      const runMemoryRewrite = async (
        projectIdJson: string,
        memory: { memory_id: string; title: string; body: string; updated_at: string },
      ): Promise<void> => {
        const fallbackMsFromIso = Date.parse(memory.updated_at);
        const fallbackMsFromNumber = Number(memory.updated_at);
        const updatedAtMs = Number.isFinite(fallbackMsFromIso)
          ? fallbackMsFromIso
          : Number.isFinite(fallbackMsFromNumber)
            ? fallbackMsFromNumber
            : 0;

        let resolvedQuery = memory.title;
        let cacheHit = false;
        let rewriteModel = rewriterModel;
        let rewriteLatencyMs = 0;
        if (rewriterEnabled) {
          const cached = getRewriteForMemory({
            db,
            t2_memory_id: memory.memory_id,
            memory_updated_at_ms: updatedAtMs,
            model: rewriterModel,
            now_ms: nowMs,
          });

          if (cached) {
            if (cached.verdict.kind === "skip") {
              emitDreamEvent("dream_p4_query_skipped", {
                t2_memory_id: memory.memory_id,
                cache_hit: true,
                latency_ms: 0,
                model: cached.model,
              });
              return;
            }

            resolvedQuery = cached.verdict.query;
            cacheHit = true;
            rewriteModel = cached.model;
            emitDreamEvent("dream_p4_query_rewritten", {
              t2_memory_id: memory.memory_id,
              cache_hit: true,
              latency_ms: 0,
              model: rewriteModel,
            });
          } else {
            if (!costMeter.canAfford("P4", "llm", phaseCostEstimates.p4RewriterLlmUsd)) {
              return;
            }
            const prompt = buildDreamQueryRewritePrompt({
              title: memory.title,
              bodyFirst200: memory.body,
            });
            const rewriteStart = Date.now();
            const rewriteResult = await invokeLlm<typeof REWRITE_RESPONSE_SCHEMA>({
              baseUrl: rewriterBaseUrl,
              model: rewriterModel,
              messages: prompt,
              schema: REWRITE_RESPONSE_SCHEMA,
              timeoutMs: rewriterTimeoutMs,
            });
            costMeter.record("P4", "llm", phaseCostEstimates.p4RewriterLlmUsd);
            rewriteLatencyMs = Date.now() - rewriteStart;

            if (!rewriteResult.ok) {
              emitDreamEvent("dream_p4_query_rewrite_failed", {
                t2_memory_id: memory.memory_id,
                cache_hit: false,
                model: rewriterModel,
                latency_ms: rewriteLatencyMs,
              });
            } else if (rewriteResult.value.kind === "skip") {
              setRewriteForMemory({
                db,
                t2_memory_id: memory.memory_id,
                memory_updated_at_ms: updatedAtMs,
                verdict: rewriteResult.value,
                model: rewriterModel,
                now_ms: nowMs,
                ttl_ms: rewriterCacheTtlMs,
              });
              emitDreamEvent("dream_p4_query_skipped", {
                t2_memory_id: memory.memory_id,
                cache_hit: false,
                model: rewriterModel,
                latency_ms: rewriteLatencyMs,
              });
              return;
            } else {
              const candidateQuery = rewriteResult.value.query;
              const candidatePassesSearchGate = gateEnabled
                ? isWebSearchable(candidateQuery)
                : { ok: true };
              if (!candidatePassesSearchGate.ok) {
                emitDreamEvent("dream_p4_query_rewrite_failed", {
                  t2_memory_id: memory.memory_id,
                  cache_hit: false,
                  model: rewriterModel,
                  latency_ms: rewriteLatencyMs,
                });
              } else {
                const sanitizedCandidate = sanitizeTitleForQuery(candidateQuery);
                if (sanitizedCandidate) {
                  resolvedQuery = sanitizedCandidate;
                  setRewriteForMemory({
                    db,
                    t2_memory_id: memory.memory_id,
                    memory_updated_at_ms: updatedAtMs,
                    verdict: { kind: "query", query: sanitizedCandidate },
                    model: rewriterModel,
                    now_ms: nowMs,
                    ttl_ms: rewriterCacheTtlMs,
                  });
                  cacheHit = false;
                  emitDreamEvent("dream_p4_query_rewritten", {
                    t2_memory_id: memory.memory_id,
                    cache_hit: false,
                    model: rewriterModel,
                    latency_ms: rewriteLatencyMs,
                  });
                }
              }
            }
          }
        }

        if (gateEnabled) {
          const verdict = isWebSearchable(resolvedQuery);
          if (!verdict.ok) {
            emitDreamEvent("dream_p4_query_rejected_unsearchable", {
              t2_memory_id: memory.memory_id,
              cache_hit: cacheHit,
              model: rewriteModel,
              latency_ms: rewriteLatencyMs,
            });
            return;
          }
        }

        const query = sanitizeTitleForQuery(resolvedQuery);
        if (!query) return;

        const negKey = hashQuery(query, query);
        const negativeSentinel = p4NegativeSentinelStmt?.get(negKey, nowMs);
        if (negativeSentinel) return;

        const queueCount = (p4QueueCountStmt.get() as { n: number }).n;
        if (queueCount >= p4QueueMax) return;

        db.prepare(
          `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
           VALUES(?, ?, 'P4', 'research_query', 0.5, 'queued', ?, ?)`,
        ).run(
          crypto.randomUUID(),
          cycleId,
          projectIdJson,
          JSON.stringify({ query, source_memory_id: memory.memory_id }),
        );
      };

      const projectTasks: Array<() => Promise<void>> = [];
      for (const project of deps.projectRegistry.list()) {
        const researchProvider = project.dreaming?.research_provider;
        if (!researchProvider || researchProvider === "off") continue;

        const projectIdJson = JSON.stringify([project.project_id]);
        const existingQuery = db
          .prepare(
            `SELECT 1 FROM dream_actions WHERE phase='P4' AND action_type='research_query' AND status IN ('queued', 'approved') AND target_ids=? LIMIT 1`,
          )
          .get(projectIdJson);
        if (existingQuery) continue;

        const memories = p4MemoryByProjectStmt.all(project.project_id) as Array<{
          memory_id: string;
          title: string;
          body: string;
          updated_at: string;
        }>;
        if (memories.length === 0) continue;

        for (const memory of memories) {
          if (!hasT2ProjectId && seenLegacyProjectlessMemoryIds.has(memory.memory_id)) continue;
          seenLegacyProjectlessMemoryIds.add(memory.memory_id);
          const projectIdJson = JSON.stringify([project.project_id]);
          projectTasks.push(async () => runMemoryRewrite(projectIdJson, memory));
        }
      }
      await runWithConcurrency(projectTasks, rewriterConcurrency);
    }

    phaseEnd("P4", p4Start);

    // ── P5: active research ──────────────────────────────────────────────────────────
    const p5Start = phaseStart("P5");

    if (typeof runP5Phase !== "undefined") {
      await runP5Phase(db, cycleId, config, {
        ...(deps as any),
        phaseCostEstimates,
      });
    }
    phaseEnd("P5", p5Start);

    if (!(await checkAdvancement())) {
      return bail("pressure guard: provider throttled after P5");
    }

    // ── P6: brief refresh ────────────────────────────────────────────────────────────
    const p6Start = phaseStart("P6");

    if (deps.projectRegistry && deps.memoryObserve) {
      const briefRefreshMs = (config.briefRefreshHours ?? 24) * 60 * 60 * 1000;
      const projects = deps.projectRegistry.list();
      for (const p of projects) {
        if (!p.dreaming) continue;

        const lastBrief = db
          .prepare(
            `SELECT generated_at FROM project_briefs WHERE project_id=? ORDER BY generated_at DESC LIMIT 1`,
          )
          .get(p.project_id) as { generated_at: number } | null;
        if (lastBrief && Date.now() - lastBrief.generated_at < briefRefreshMs) continue;

        let briefMarkdown: string;
        let sourceMemoryIds: string[] = [];
        if (deps.briefSynthesizer) {
          if (!costMeter.canAfford("P6", "llm", phaseCostEstimates.p6BriefSynthLlmUsd)) {
            continue;
          }
          const recentMemories = db
            .prepare(
              `SELECT memory_id, kind, title, body, created_at
               FROM t2_memories
              WHERE project_id = ? AND kind != 'brief' AND retired_at IS NULL
              ORDER BY created_at DESC
              LIMIT ?`,
            )
            .all(p.project_id, config.briefSynthMaxMemories ?? 20) as Array<{
            memory_id: string;
            kind: string;
            title: string;
            body: string;
            created_at: string;
          }>;
          const priorBriefRow = db
            .prepare(
              `SELECT brief_md FROM project_briefs WHERE project_id=? ORDER BY generated_at DESC LIMIT 1`,
            )
            .get(p.project_id) as { brief_md: string } | null;
          try {
            const result = await deps.briefSynthesizer.synthesize({
              project_id: p.project_id,
              recent_memories: recentMemories,
              prior_brief: priorBriefRow?.brief_md,
            });
            costMeter.record("P6", "llm", phaseCostEstimates.p6BriefSynthLlmUsd);
            briefMarkdown = result.markdown;
            sourceMemoryIds = result.source_memory_ids ?? recentMemories.map((m) => m.memory_id);
          } catch (err) {
            console.warn("P6: synthesizer failed, falling back to stub", {
              err,
              project_id: p.project_id,
            });
            briefMarkdown =
              "# Project Brief: " + p.project_id + "\nGenerated by P6 (synthesizer failed).";
          }
        } else {
          briefMarkdown = "# Project Brief: " + p.project_id + "\nGenerated by P6.";
        }

        try {
          const { memory_id } = await deps.memoryObserve(briefMarkdown, p.project_id, cycleId);
          db.prepare(
            "INSERT OR REPLACE INTO project_briefs(project_id, brief_md, source_memory_ids, generated_at, generated_by_cycle, t2_shadow_memory_id) VALUES(?, ?, ?, ?, ?, ?)",
          ).run(
            p.project_id,
            briefMarkdown,
            JSON.stringify(sourceMemoryIds),
            Date.now(),
            cycleId,
            memory_id,
          );
        } catch (err) {
          console.error("P6 INSERT ERROR:", err);
        }
      }
    }

    phaseEnd("P6", p6Start);

    if (!(await checkAdvancement())) {
      return bail("pressure guard: provider throttled after P6");
    }

    // ── P7: re-embed stale vectors ────────────────────────────────────────
    const p7Start = phaseStart("P7");

    if (!config.skipPhases?.has("P7")) {
      const reembedOutcome = await runReembedPhase(db, cycleId, config, {
        ...(deps as any),
        phaseCostEstimates,
      });
      if (!(reembedOutcome as { deferred?: boolean } | undefined)?.deferred) {
        phaseEnd("P7", p7Start);
      }
    }

    // ── P8: audit ──────────────────────────────────────────────────────────
    const p8Start = phaseStart("P8");

    phaseEnd("P8", p8Start);

    // ── Curator phases (PC1, PC2) — opt-in via PENUMBRA_DREAMING_CURATOR_ENABLED ──
    // outcome='completed' is set AFTER curator phases so a curator error is visible
    if (config.curatorEnabled) {
      try {
        const pc1Start = phaseStart("PC1");
        await runPC1Phase(db, cycleId, config, {});
        phaseEnd("PC1", pc1Start);

        const pc2Start = phaseStart("PC2");
        await runPC2Phase(db, cycleId, config, {});
        phaseEnd("PC2", pc2Start);

        db.prepare(
          `UPDATE dream_cycles SET outcome='completed', ended_at=?, phases_run=? WHERE cycle_id=?`,
        ).run(Date.now(), JSON.stringify(phasesRun), cycleId);
      } catch (err) {
        db.prepare(
          // completed_with_curator_error means PC phases ran and completed,
          // but curator-side exceptions occurred after core work succeeded.
          `UPDATE dream_cycles SET outcome='completed_with_curator_error', ended_at=?, phases_run=? WHERE cycle_id=?`,
        ).run(Date.now(), JSON.stringify(phasesRun), cycleId);
        console.warn("dreaming: curator phase error", { err: String(err), cycleId });
      }
    } else {
      db.prepare(
        `UPDATE dream_cycles SET outcome='completed', ended_at=?, phases_run=? WHERE cycle_id=?`,
      ).run(Date.now(), JSON.stringify(phasesRun), cycleId);
    }

    return cycleId;
  } finally {
    delete deps.costMeter;
    dreamingCycleInFlight = false;
  }
}

function normalizeBudgetFractions(
  fractions: DreamPhaseBudgetFractions | undefined,
): DreamPhaseBudgetFractions {
  const base = fractions ?? DEFAULT_PHASE_BUDGET_FRACTIONS;
  const llm = Number.isFinite(base.llm) ? Math.max(0, base.llm) : 0;
  const embedding = Number.isFinite(base.embedding) ? Math.max(0, base.embedding) : 0;
  const research = Number.isFinite(base.research) ? Math.max(0, base.research) : 0;
  const total = llm + embedding + research;
  if (total <= 0) return { ...DEFAULT_PHASE_BUDGET_FRACTIONS };
  return {
    llm: llm / total,
    embedding: embedding / total,
    research: research / total,
  };
}

function normalizeCostEstimates(
  estimates: DreamPhaseCostEstimatesUsd | undefined,
): DreamPhaseCostEstimatesUsd {
  const base = estimates ?? DEFAULT_PHASE_COST_ESTIMATES_USD;
  return {
    p3ScorerLlmUsd: sanitizeUsd(base.p3ScorerLlmUsd),
    p4RewriterLlmUsd: sanitizeUsd(base.p4RewriterLlmUsd),
    p5ResearchUsd: sanitizeUsd(base.p5ResearchUsd),
    p6BriefSynthLlmUsd: sanitizeUsd(base.p6BriefSynthLlmUsd),
    p7EmbedUsd: sanitizeUsd(base.p7EmbedUsd),
  };
}

function getSpendColumnsForLane(lane: DreamSpendLane): string {
  if (lane === "llm") return "llm_spent_usd";
  if (lane === "embedding") return "embedding_spent_usd";
  return "research_spent_usd";
}

function sanitizeUsd(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function getCycleSpend(
  db: Database,
  cycleId: string,
): { llm: number; embedding: number; research: number } {
  const row = db
    .prepare(
      `SELECT llm_spent_usd, embedding_spent_usd, research_spent_usd
       FROM dream_cycles WHERE cycle_id = ?`,
    )
    .get(cycleId) as {
    llm_spent_usd: number;
    embedding_spent_usd: number;
    research_spent_usd: number;
  } | null;
  if (!row) return { ...ZERO_SPEND };
  return {
    llm: sanitizeUsd(row.llm_spent_usd),
    embedding: sanitizeUsd(row.embedding_spent_usd),
    research: sanitizeUsd(row.research_spent_usd),
  };
}

function getTodayLaneSpend(db: Database, lane: DreamSpendLane, todayStartMs: number): number {
  const column = getSpendColumnsForLane(lane);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(${column}), 0) AS total
         FROM dream_cycles
        WHERE started_at >= ?
          AND outcome != 'crashed'`,
    )
    .get(todayStartMs) as { total: number } | null;
  return sanitizeUsd(row?.total ?? 0);
}

export function recordSpend(
  db: Database,
  cycleId: string,
  spend: { llm?: number; embedding?: number; research?: number },
): void {
  const llmUsd = sanitizeUsd(spend.llm ?? 0);
  const embeddingUsd = sanitizeUsd(spend.embedding ?? 0);
  const researchUsd = sanitizeUsd(spend.research ?? 0);
  if (llmUsd <= 0 && embeddingUsd <= 0 && researchUsd <= 0) return;
  db.prepare(
    `UPDATE dream_cycles
        SET llm_spent_usd = llm_spent_usd + ?,
            embedding_spent_usd = embedding_spent_usd + ?,
            research_spent_usd = research_spent_usd + ?
      WHERE cycle_id = ?`,
  ).run(llmUsd, embeddingUsd, researchUsd, cycleId);
}

export function startDreamingCron(deps: {
  db: Database;
  config: DreamConfig;
  log?: Logger;
  cycleDeps?: DreamCycleDeps;
}): () => void {
  const intervalMs = deps.config.cronMinutes * 60 * 1000;
  const timer = setInterval(async () => {
    try {
      await runDreamCycle(deps.db, deps.config, deps.cycleDeps);
    } catch (err) {
      (deps.log as any)?.warn?.({ err: String(err) }, "dreaming: cycle failed unexpectedly");
    }
  }, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
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

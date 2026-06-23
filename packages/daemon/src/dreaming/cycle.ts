import type { DispatchEventInput, Logger, WebResearchAdapter } from "@penumbra/core";
import type { Database } from "bun:sqlite";

import { buildT2EmbedText, retireNonDirectMemory } from "@penumbra/core";
import { z } from "zod";

import type { BriefSynthesizer } from "./brief-synthesizer.js";
import type {
  DreamConfig,
  DreamPhaseBudgetFractions,
  DreamPhaseCostEstimatesUsd,
} from "./config.js";
import type { ContentQualityJudge } from "./curator/content-quality-judge.js";
import type { ResearchDeps } from "./research.js";

import { releaseT1RollupClaims } from "../../../core/src/db/schema.js";
import {
  type LlmInvokeInput,
  type LlmInvokeResult,
  llmInvoke as realLlmInvoke,
} from "../services/llm-invoke.js";
import { runPC1Phase } from "./curator/pc1-ephemera.js";
import { runPC2Phase } from "./curator/pc2-cluster.js";
import { REWRITE_RESPONSE_SCHEMA } from "./dream-rewriter-prompt-content.js";
import { buildDreamQueryRewritePrompt } from "./dream-rewriter-prompt.js";
import { type JudgePool, StubJudgePool } from "./judge-pool.js";
import {
  getRewriteForMemory,
  pruneExpiredRewriteCache,
  setRewriteForMemory,
} from "./query-rewriter-cache.js";
import { isWebSearchable } from "./query-rewriting.js";
import { sanitizeTitleForQuery } from "./query-sanitize.js";
import { runReembedPhase } from "./reembed.js";
import { hashQuery, runP5Phase } from "./research.js";

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

export interface ProjectRegistryEntry {
  project_id: string;
  dreaming?: { research_provider?: string } & Record<string, unknown>;
}

export type DreamSpendLane = "llm" | "embedding" | "research";

export interface DreamCostMeter {
  canAfford(phase: string, lane: DreamSpendLane, usd: number): boolean;
  record(phase: string, lane: DreamSpendLane, usd: number): void;
}

export function isDreamSpendAffordable(opts: {
  perCycleUsd: number;
  dailyUsd: number;
  laneFraction: number;
  cycleSpentLaneUsd: number;
  dailySpentLaneUsd: number;
  usd: number;
}): boolean {
  if (opts.usd <= 0) return true;
  if (
    opts.perCycleUsd > 0 &&
    opts.cycleSpentLaneUsd + opts.usd > opts.perCycleUsd * opts.laneFraction
  ) {
    return false;
  }
  if (opts.dailyUsd > 0 && opts.dailySpentLaneUsd + opts.usd > opts.dailyUsd * opts.laneFraction) {
    return false;
  }
  return true;
}

type RewriteLlmInvoker = <T extends z.ZodType>(
  input: LlmInvokeInput<T>,
) => Promise<LlmInvokeResult<T>>;

export interface DreamCycleDeps {
  log?: Logger;
  projectRegistry?: {
    get(id: string): ProjectRegistryEntry | undefined;
    list(): ProjectRegistryEntry[];
  };
  getResearchAdapter?: (project: ProjectRegistryEntry) => WebResearchAdapter | null;
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

interface CycleCtx {
  cycleId: string;
  nowMs: number;
  todayStartMs: number;
  phasesRun: string[];
  deferredPhases: Set<string>;
  costMeter: DreamCostMeter;
  phaseCostEstimates: DreamPhaseCostEstimatesUsd;
  budgetFractions: DreamPhaseBudgetFractions;
  judgePool: JudgePool;
  invokeLlm: RewriteLlmInvoker;
  log: Logger | undefined;
  hasT1ProjectId: boolean;
  hasT2ProjectId: boolean;
  seenLegacyProjectlessMemoryIds: Set<string>;
  rewriterEnabled: boolean;
  rewriterModel: string;
  rewriterBaseUrl: string;
  rewriterTimeoutMs: number;
  rewriterCacheTtlMs: number;
  rewriterConcurrency: number;
  gateEnabled: boolean;
  p4QueueMax: number;
  p4QueueCountStmt: ReturnType<Database["prepare"]>;
  p4NegativeSentinelStmt: ReturnType<Database["prepare"]> | null;
  p4MemoryByProjectStmt: ReturnType<Database["prepare"]>;
  p4QueuedQueryExistsStmt: ReturnType<Database["prepare"]>;
  p2QueuedLinkExistsStmt: ReturnType<Database["prepare"]>;
  emitDreamEvent: (kind: DispatchEventInput["kind"], meta: Record<string, unknown>) => void;
}

export async function runDreamCycle(
  db: Database,
  config: DreamConfig,
  deps: DreamCycleDeps = {},
): Promise<string> {
  const cycleId = crypto.randomUUID();
  const nowMs = Date.now();

  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
     VALUES(?, ?, 'cron', ?, 'running', '[]')`,
  ).run(cycleId, nowMs, config.perCycleUsd);

  const ctx = buildCycleCtx(db, cycleId, nowMs, config, deps);
  deps.costMeter = ctx.costMeter;

  const bail = (reason: string): string => finalizeCycleAsBailed(db, ctx, reason);

  const p0Bail = await checkP0(db, ctx, config, deps);
  if (p0Bail) return bail(p0Bail);

  if (dreamingCycleInFlight) return bail("mutex-held: another cycle is already in flight");
  dreamingCycleInFlight = true;

  try {
    ensureSchemaColumns(db);

    await runCycleP1(db, ctx, deps, config);
    if (!(await canAdvance(config, deps)))
      return bail("pressure guard: provider throttled after P1");

    runCycleP2(db, ctx, config);
    if (!(await canAdvance(config, deps)))
      return bail("pressure guard: provider throttled after P2");

    await runCycleP3(db, ctx, deps, config);
    if (!(await canAdvance(config, deps)))
      return bail("pressure guard: provider throttled after P3");

    await runCycleP4(db, ctx, deps, config);

    await runCycleP5(db, ctx, deps, config);
    if (!(await canAdvance(config, deps)))
      return bail("pressure guard: provider throttled after P5");

    await runCycleP6(db, ctx, deps, config);
    if (!(await canAdvance(config, deps)))
      return bail("pressure guard: provider throttled after P6");

    await runCycleP7(db, ctx, deps, config);
    runCycleP8(db, ctx);

    finalizeCycle(db, ctx, config);
    return ctx.cycleId;
  } finally {
    delete deps.costMeter;
    dreamingCycleInFlight = false;
  }
}

function buildCycleCtx(
  db: Database,
  cycleId: string,
  nowMs: number,
  config: DreamConfig,
  deps: DreamCycleDeps,
): CycleCtx {
  const todayStartMs = getTodayStartMs();
  const budgetFractions = normalizeBudgetFractions(config.phaseBudgetFractions);
  const phaseCostEstimates = normalizeCostEstimates(
    config.phaseCostEstimatesUsd ?? deps.phaseCostEstimates,
  );
  const deferredPhases = new Set<string>();
  const phasesRun: string[] = [];

  const costMeter = makeCostMeter(
    db,
    config,
    cycleId,
    budgetFractions,
    deferredPhases,
    todayStartMs,
  );

  const t1Cols = db.prepare(`PRAGMA table_info(t1_rollups)`).all() as { name?: string | null }[];
  const t2Cols = db.prepare(`PRAGMA table_info(t2_memories)`).all() as { name?: string | null }[];
  const hasT1ProjectId = t1Cols.some((c) => c.name === "project_id");
  const hasT2ProjectId = t2Cols.some((c) => c.name === "project_id");
  const p4QueueMax = config.p4QueueMax ?? 1000;
  const gateEnabled = process.env.PENUMBRA_DREAMING_QUERY_GATE_ENABLED !== "0";

  const hasDreamResearchCache =
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='dream_research_cache'`)
      .get() !== null;
  const p4NegativeSentinelStmt = hasDreamResearchCache
    ? db.prepare(
        `SELECT 1 FROM dream_research_cache WHERE cache_key=? AND is_negative=1 AND expires_at > ?`,
      )
    : null;
  const p4QueueCountStmt = db.prepare(
    `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND status='queued'`,
  );
  const p4QueuedQueryExistsStmt = db.prepare(
    `SELECT 1 FROM dream_actions WHERE phase='P4' AND action_type='research_query' AND status IN ('queued', 'approved') AND target_ids=? LIMIT 1`,
  );
  const p2QueuedLinkExistsStmt = db.prepare(
    `SELECT 1 FROM dream_actions WHERE action_type='link' AND status='queued' AND target_ids IN (?, ?) LIMIT 1`,
  );
  const p4MemoryByProjectStmt = hasT2ProjectId
    ? db.prepare(
        `SELECT memory_id, title, SUBSTR(body, 1, 200) AS body, updated_at FROM t2_memories WHERE project_id = ? AND kind NOT IN ('brief') AND retired_at IS NULL AND title IS NOT NULL AND title != '' ORDER BY created_at DESC LIMIT 2`,
      )
    : db.prepare(
        `SELECT memory_id, title, SUBSTR(body, 1, 200) AS body, updated_at FROM t2_memories WHERE kind NOT IN ('brief') AND retired_at IS NULL AND title IS NOT NULL AND title != '' ORDER BY created_at DESC LIMIT 2`,
      );

  const dispatchEventLog = deps.dispatchEventLog;
  const emitDreamEvent = (
    kind: DispatchEventInput["kind"],
    meta: Record<string, unknown>,
  ): void => {
    if (!dispatchEventLog) return;
    dispatchEventLog.record({
      handoff_id: cycleId,
      source: "daemon",
      kind,
      ts: new Date().toISOString(),
      meta,
    });
  };

  return {
    cycleId,
    nowMs,
    todayStartMs,
    phasesRun,
    deferredPhases,
    costMeter,
    phaseCostEstimates,
    budgetFractions,
    judgePool: deps.judgePool ?? new StubJudgePool(),
    invokeLlm: deps.llmInvoke ?? realLlmInvoke,
    log: deps.log,
    hasT1ProjectId,
    hasT2ProjectId,
    seenLegacyProjectlessMemoryIds: new Set<string>(),
    rewriterEnabled: config.rewriterEnabled,
    rewriterModel: config.rewriterModel,
    rewriterBaseUrl: config.rewriterBaseUrl,
    rewriterTimeoutMs: config.rewriterTimeoutMs,
    rewriterCacheTtlMs: config.rewriterCacheTtlMs,
    rewriterConcurrency: Math.max(1, Math.trunc(config.rewriterConcurrency)),
    gateEnabled,
    p4QueueMax,
    p4QueueCountStmt,
    p4NegativeSentinelStmt,
    p4MemoryByProjectStmt,
    p4QueuedQueryExistsStmt,
    p2QueuedLinkExistsStmt,
    emitDreamEvent,
  };
}

function makeCostMeter(
  db: Database,
  config: DreamConfig,
  cycleId: string,
  budgetFractions: DreamPhaseBudgetFractions,
  deferredPhases: Set<string>,
  todayStartMs: number,
): DreamCostMeter {
  return {
    canAfford: (phase, lane, usd): boolean => {
      const normalizedUsd = sanitizeUsd(usd);
      if (normalizedUsd <= 0) return true;
      const cycleSpend = getCycleSpend(db, cycleId);
      const dailySpend = getTodayLaneSpend(db, lane, todayStartMs);
      const affordable = isDreamSpendAffordable({
        perCycleUsd: config.perCycleUsd,
        dailyUsd: config.dailyUsd,
        laneFraction: budgetFractions[lane],
        cycleSpentLaneUsd: cycleSpend[lane],
        dailySpentLaneUsd: dailySpend,
        usd: normalizedUsd,
      });
      if (!affordable) deferredPhases.add(phase);
      return affordable;
    },
    record: (phase, lane, usd): void => {
      const normalizedUsd = sanitizeUsd(usd);
      if (normalizedUsd <= 0) return;
      if (lane === "llm") recordSpend(db, cycleId, { llm: normalizedUsd });
      else if (lane === "embedding") recordSpend(db, cycleId, { embedding: normalizedUsd });
      else recordSpend(db, cycleId, { research: normalizedUsd });
      deferredPhases.delete(phase);
    },
  };
}

async function checkP0(
  db: Database,
  ctx: CycleCtx,
  config: DreamConfig,
  deps: DreamCycleDeps,
): Promise<string | null> {
  const p0Start = phaseStart(ctx, "P0");
  let bailReason: string | null = null;

  const todayRow = db
    .prepare(
      `SELECT COALESCE(SUM(llm_spent_usd + embedding_spent_usd + research_spent_usd), 0) AS total_today
       FROM dream_cycles WHERE started_at >= ? AND outcome != 'crashed'`,
    )
    .get(ctx.todayStartMs) as { total_today: number };

  if (config.dailyUsd > 0 && todayRow.total_today >= config.dailyUsd) {
    bailReason = "daily USD cap already reached";
  } else if (config.perCycleUsd > 0 && config.perCycleUsd < MIN_PER_CYCLE_USD) {
    bailReason = `per-cycle USD cap (${String(config.perCycleUsd)}) is too low to run any phase`;
  } else if (config.pressureGuardEnabled && deps.pressureGuard) {
    const pressure = await deps.pressureGuard.check();
    if (pressure.anyThrottled) bailReason = "pressure guard: provider throttled or constrained";
  }

  phaseEnd(db, ctx, "P0", p0Start);
  return bailReason;
}

function ensureSchemaColumns(db: Database): void {
  const alterIfMissing = (sql: string): void => {
    try {
      db.run(sql);
    } catch {
      /* already exists */
    }
  };
  alterIfMissing("ALTER TABLE t2_memories ADD COLUMN retired_at INTEGER");
  alterIfMissing("ALTER TABLE t1_rollups ADD COLUMN project_id TEXT");
  alterIfMissing("ALTER TABLE t2_memories ADD COLUMN project_id TEXT");
}

async function canAdvance(config: DreamConfig, deps: DreamCycleDeps): Promise<boolean> {
  if (!config.pressureGuardEnabled || !deps.pressureGuard) return true;
  const pressure = await deps.pressureGuard.check();
  return !pressure.anyThrottled;
}

function finalizeCycleAsBailed(db: Database, ctx: CycleCtx, reason: string): string {
  db.prepare(
    `UPDATE dream_cycles SET outcome='bailed', bail_reason=?, ended_at=?, phases_run=?, last_phase_completed=? WHERE cycle_id=?`,
  ).run(
    reason,
    Date.now(),
    JSON.stringify(ctx.phasesRun),
    ctx.phasesRun.at(-1) ?? null,
    ctx.cycleId,
  );
  return ctx.cycleId;
}

function phaseStart(ctx: CycleCtx, phase: string): number {
  ctx.log?.info({ phase, cycleId: ctx.cycleId }, "dream-cycle phase start");
  return Date.now();
}

function phaseEnd(db: Database, ctx: CycleCtx, phase: string, startMs: number): void {
  const durationMs = Date.now() - startMs;
  ctx.phasesRun.push(phase);
  db.prepare(`UPDATE dream_cycles SET phases_run=?, last_phase_completed=? WHERE cycle_id=?`).run(
    JSON.stringify(ctx.phasesRun),
    phase,
    ctx.cycleId,
  );
  ctx.log?.info({ phase, cycleId: ctx.cycleId, durationMs }, "dream-cycle phase end");
}

function finalizeCycle(db: Database, ctx: CycleCtx, config: DreamConfig): void {
  if (!config.curatorEnabled) {
    db.prepare(
      `UPDATE dream_cycles SET outcome='completed', ended_at=?, phases_run=? WHERE cycle_id=?`,
    ).run(Date.now(), JSON.stringify(ctx.phasesRun), ctx.cycleId);
    return;
  }
  try {
    const pc1Start = phaseStart(ctx, "PC1");
    runPC1Phase(db, ctx.cycleId, config, {});
    phaseEnd(db, ctx, "PC1", pc1Start);

    const pc2Start = phaseStart(ctx, "PC2");
    runPC2Phase(db, ctx.cycleId, config, {});
    phaseEnd(db, ctx, "PC2", pc2Start);

    db.prepare(
      `UPDATE dream_cycles SET outcome='completed', ended_at=?, phases_run=? WHERE cycle_id=?`,
    ).run(Date.now(), JSON.stringify(ctx.phasesRun), ctx.cycleId);
  } catch (err) {
    db.prepare(
      `UPDATE dream_cycles SET outcome='completed_with_curator_error', ended_at=?, phases_run=? WHERE cycle_id=?`,
    ).run(Date.now(), JSON.stringify(ctx.phasesRun), ctx.cycleId);
    console.warn("dreaming: curator phase error", { err: String(err), cycleId: ctx.cycleId });
  }
}

// ── P1: consolidate stale t1 rollups ─────────────────────────────────────────

async function runCycleP1(
  db: Database,
  ctx: CycleCtx,
  deps: DreamCycleDeps,
  config: DreamConfig,
): Promise<void> {
  const p1Start = phaseStart(ctx, "P1");
  const autoPromoteMinJudges = config.autoPromoteMinJudges ?? 2;
  const longLivedFilter = KNOWN_LONG_LIVED_DISPATCHER_USER_IDS.length
    ? `AND (user_id IS NULL OR user_id NOT IN (${KNOWN_LONG_LIVED_DISPATCHER_USER_IDS.map(() => "?").join(",")}))`
    : "";

  releaseT1RollupClaims(db, {
    terminalOutcomes: TERMINAL_DREAM_CYCLE_OUTCOMES,
    staleBeforeMs: ctx.nowMs - P1_CLAIM_TTL_MS,
  });

  const claimedRollups = claimT1Rollups(db, ctx, config, longLivedFilter);

  for (const rollup of claimedRollups) {
    const body = rollup.first_prompt_excerpt;
    if (!body || body.trim().length < 40) continue;

    const votes = await getPromoteVotes(ctx.judgePool, body);
    const total = votes.length;
    const yesCount = votes.filter((v) => v.promote).length;
    const avgConfidence = votes.reduce((s, v) => s + v.confidence, 0) / Math.max(total, 1);
    const autoPromote = total >= autoPromoteMinJudges && yesCount >= Math.ceil((total * 2) / 3);

    const result = await maybeAutoPromoteT1(
      db,
      ctx,
      deps,
      rollup,
      body,
      autoPromote,
      votes,
      avgConfidence,
    );
    if (result.skip) continue;

    db.prepare(
      `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
       VALUES(?, ?, 'P1', 'promote_t1', ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      ctx.cycleId,
      avgConfidence,
      result.status,
      JSON.stringify([rollup.rollup_id]),
      JSON.stringify({
        votes: votes.map((v) => ({ promote: v.promote, confidence: v.confidence })),
        ...(result.mintedT2Id ? { t2_memory_id: result.mintedT2Id } : {}),
      }),
    );
  }

  phaseEnd(db, ctx, "P1", p1Start);
}

function claimT1Rollups(
  db: Database,
  ctx: CycleCtx,
  config: DreamConfig,
  longLivedFilter: string,
): { rollup_id: string; first_prompt_excerpt: string | null; project_id: string | null }[] {
  const baseParams = [
    ctx.nowMs,
    ctx.cycleId,
    ...KNOWN_LONG_LIVED_DISPATCHER_USER_IDS,
    ...EPHEMERA_PROMPT_LIKE_PATTERNS,
    config.p1BatchSize,
  ];

  if (ctx.hasT1ProjectId) {
    return db
      .prepare(
        `UPDATE t1_rollups SET claimed_at = ?, claimed_by_cycle = ?
        WHERE rollup_id IN (
          SELECT rollup_id FROM (
            SELECT rollup_id, project_id FROM t1_rollups
               WHERE t2_promoted_at IS NULL
                 AND claimed_at IS NULL
                 AND (first_prompt_excerpt IS NULL OR (${EPHEMERA_PROMPT_NOT_LIKE_CLAUSE}))
                 ${longLivedFilter}
                 ORDER BY started_at ASC
                 LIMIT ?
            )
        )
        RETURNING rollup_id, first_prompt_excerpt, project_id`,
      )
      .all(...baseParams) as {
      rollup_id: string;
      first_prompt_excerpt: string | null;
      project_id: string | null;
    }[];
  }

  const rows = db
    .prepare(
      `UPDATE t1_rollups SET claimed_at = ?, claimed_by_cycle = ?
      WHERE rollup_id IN (
        SELECT rollup_id FROM t1_rollups
          WHERE t2_promoted_at IS NULL
            AND claimed_at IS NULL
            AND (first_prompt_excerpt IS NULL OR (${EPHEMERA_PROMPT_NOT_LIKE_CLAUSE}))
            ${longLivedFilter}
          ORDER BY started_at ASC
          LIMIT ?
      )
      RETURNING rollup_id, first_prompt_excerpt`,
    )
    .all(...baseParams) as { rollup_id: string; first_prompt_excerpt: string | null }[];
  return rows.map((r) => ({ ...r, project_id: null }));
}

async function getPromoteVotes(
  judgePool: JudgePool,
  body: string,
): Promise<{ promote: boolean; confidence: number; rationale?: string }[]> {
  if (judgePool.judgeAll) {
    return await judgePool.judgeAll({ body, kind: "promote_t1" });
  }
  const result = await judgePool.judge({ body, kind: "promote_t1" });
  return [
    {
      promote: result.verdict === "yes",
      confidence: result.confidence,
      rationale: result.rationale,
    },
  ];
}

async function maybeAutoPromoteT1(
  db: Database,
  ctx: CycleCtx,
  deps: DreamCycleDeps,
  rollup: { rollup_id: string; first_prompt_excerpt: string | null; project_id: string | null },
  body: string,
  autoPromote: boolean,
  votes: { promote: boolean; confidence: number }[],
  avgConfidence: number,
): Promise<{ skip: true } | { skip: false; status: string; mintedT2Id?: string }> {
  if (!autoPromote) return { skip: false, status: "queued" };

  const title = `P1 auto-promote: ${body.slice(0, 80)}`;
  const existingRow = ctx.hasT2ProjectId
    ? db
        .prepare(
          `SELECT memory_id FROM t2_memories WHERE retired_at IS NULL AND COALESCE(project_id, '') = COALESCE(?, '') AND title = ? LIMIT 1`,
        )
        .get(rollup.project_id, title)
    : db
        .prepare(`SELECT memory_id FROM t2_memories WHERE retired_at IS NULL AND title = ? LIMIT 1`)
        .get(title);
  const existing = existingRow as { memory_id: string } | undefined;

  if (existing) {
    db.prepare(
      `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
       VALUES(?, ?, 'P1', 'promote_t1', ?, 'queued', ?, ?)`,
    ).run(
      crypto.randomUUID(),
      ctx.cycleId,
      avgConfidence,
      JSON.stringify([rollup.rollup_id]),
      JSON.stringify({
        votes: votes.map((v) => ({ promote: v.promote, confidence: v.confidence })),
        dedup_against: existing.memory_id,
        project_id: rollup.project_id,
      }),
    );
    return { skip: true };
  }

  return await mintT2Memory(db, ctx, deps, rollup, body, title);
}

async function mintT2Memory(
  db: Database,
  ctx: CycleCtx,
  deps: DreamCycleDeps,
  rollup: { rollup_id: string; project_id: string | null },
  body: string,
  title: string,
): Promise<{ skip: false; status: string; mintedT2Id?: string }> {
  if (!deps.onReembed) {
    console.warn(
      `P1 auto-promote skipped for rollup ${rollup.rollup_id}: onReembed handler unavailable`,
    );
    return { skip: false, status: "queued" };
  }
  const candidateMemoryId = crypto.randomUUID();
  try {
    const vec = await deps.onReembed(candidateMemoryId, buildT2EmbedText(title, body));
    return commitT2Mint(db, ctx, rollup, body, title, candidateMemoryId, vec);
  } catch (err) {
    console.error(
      `P1 auto-promote embed failed for rollup ${rollup.rollup_id}; promotion skipped`,
      err,
    );
    return { skip: false, status: "queued" };
  }
}

function commitT2Mint(
  db: Database,
  ctx: CycleCtx,
  rollup: { rollup_id: string; project_id: string | null },
  body: string,
  title: string,
  candidateMemoryId: string,
  vec: Float32Array,
): { skip: false; status: string; mintedT2Id?: string } {
  const nowIso = new Date().toISOString();
  const modelVersion = process.env.PENUMBRA_EMBEDDING_MODEL_VERSION ?? "v1";
  try {
    db.transaction(() => {
      if (ctx.hasT2ProjectId) {
        db.prepare(
          `INSERT INTO t2_memories(memory_id, user_id, project_id, kind, window_start, window_end, title, body, created_at, updated_at, embedding_model_version)
           VALUES(?, 'system', ?, 'promoted', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          candidateMemoryId,
          rollup.project_id,
          nowIso,
          nowIso,
          title,
          body,
          nowIso,
          nowIso,
          modelVersion,
        );
      } else {
        db.prepare(
          `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, embedding_model_version)
           VALUES(?, 'system', 'promoted', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(candidateMemoryId, nowIso, nowIso, title, body, nowIso, nowIso, modelVersion);
      }
      const inserted = db
        .prepare(`SELECT rowid FROM t2_memories WHERE memory_id = ?`)
        .get(candidateMemoryId) as { rowid: number } | null;
      if (!inserted) throw new Error("inserted t2 memory missing rowid");
      db.prepare(`INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)`).run(inserted.rowid, vec);
      db.prepare(`UPDATE t1_rollups SET t2_promoted_at=? WHERE rollup_id=?`).run(
        nowIso,
        rollup.rollup_id,
      );
    })();
    return { skip: false, status: "auto_applied", mintedT2Id: candidateMemoryId };
  } catch (err) {
    console.error(
      `P1 auto-promote promotion transaction failed for rollup ${rollup.rollup_id}; promotion skipped`,
      err,
    );
    return { skip: false, status: "queued" };
  }
}

// ── P2: link discovery via pairwise cosine ────────────────────────────────────

function runCycleP2(db: Database, ctx: CycleCtx, config: DreamConfig): void {
  const p2Start = phaseStart(ctx, "P2");

  const recentMemories = db
    .prepare(`SELECT memory_id, rowid FROM t2_memories ORDER BY created_at DESC LIMIT ?`)
    .all(P2_SCAN_LIMIT) as { memory_id: string; rowid: number }[];

  const memVecs: { memory_id: string; vec: Float32Array }[] = [];
  for (const mem of recentMemories) {
    const vecRow = db.prepare(`SELECT embedding FROM t2_vec WHERE rowid = ?`).get(mem.rowid) as {
      embedding: Uint8Array;
    } | null;
    if (vecRow?.embedding) {
      const buf = vecRow.embedding;
      memVecs.push({
        memory_id: mem.memory_id,
        vec: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
      });
    }
  }

  const mintedAt = Date.now();
  for (let i = 0; i < memVecs.length; i++) {
    for (let j = i + 1; j < memVecs.length; j++) {
      const src = memVecs[i];
      const dst = memVecs[j];
      if (!src || !dst) continue;
      processCosinePair(db, ctx, config, src, dst, computeCosine(src.vec, dst.vec), mintedAt);
    }
  }

  phaseEnd(db, ctx, "P2", p2Start);
}

function processCosinePair(
  db: Database,
  ctx: CycleCtx,
  config: DreamConfig,
  src: { memory_id: string },
  dst: { memory_id: string },
  cosine: number,
  mintedAt: number,
): void {
  if (cosine >= config.linkAutoThreshold) {
    const existing = db
      .prepare(
        `SELECT 1 FROM memory_links WHERE src_id=? AND dst_id=? AND link_type='semantic_near' LIMIT 1`,
      )
      .get(src.memory_id, dst.memory_id);
    if (!existing) {
      db.prepare(
        `INSERT OR IGNORE INTO memory_links(link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle) VALUES(?, ?, ?, 'semantic_near', ?, ?, ?)`,
      ).run(crypto.randomUUID(), src.memory_id, dst.memory_id, cosine, mintedAt, ctx.cycleId);
      db.prepare(
        `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES(?, ?, 'P2', 'link', ?, 'auto_applied', ?, ?)`,
      ).run(
        crypto.randomUUID(),
        ctx.cycleId,
        cosine,
        JSON.stringify([src.memory_id, dst.memory_id]),
        JSON.stringify({ link_type: "semantic_near" }),
      );
    }
  } else if (cosine >= LINK_QUEUE_FLOOR) {
    const targetIds = JSON.stringify([src.memory_id, dst.memory_id]);
    const reverseTargetIds = JSON.stringify([dst.memory_id, src.memory_id]);
    if (ctx.p2QueuedLinkExistsStmt.get(targetIds, reverseTargetIds)) return;
    db.prepare(
      `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES(?, ?, 'P2', 'link', ?, 'queued', ?, ?)`,
    ).run(
      crypto.randomUUID(),
      ctx.cycleId,
      cosine,
      targetIds,
      JSON.stringify({ link_type: "semantic_near" }),
    );
  }
}

// ── P3: multi-factor quality signal ──────────────────────────────────────────

async function runCycleP3(
  db: Database,
  ctx: CycleCtx,
  deps: DreamCycleDeps,
  _config: DreamConfig,
): Promise<void> {
  const p3Start = phaseStart(ctx, "P3");
  let ranP3 = false;

  if (deps.scorer) {
    const memories = db
      .prepare(
        `SELECT memory_id, body FROM t2_memories WHERE retired_at IS NULL ORDER BY created_at ASC LIMIT ?`,
      )
      .all(P3_SCAN_LIMIT) as { memory_id: string; body: string }[];

    for (const mem of memories) {
      const estimatedCost =
        sanitizeUsd(deps.scorer.estimateCostUsd?.(mem)) || ctx.phaseCostEstimates.p3ScorerLlmUsd;
      if (!ctx.costMeter.canAfford("P3", "llm", estimatedCost)) break;
      const result = await deps.scorer.score(mem);
      ctx.costMeter.record("P3", "llm", sanitizeUsd(result.estimated_cost_usd) || estimatedCost);
      ranP3 = true;
      enqueueP3Action(db, ctx, mem, result);
    }
  }

  if (ranP3 || !ctx.deferredPhases.has("P3")) phaseEnd(db, ctx, "P3", p3Start);
}

function enqueueP3Action(
  db: Database,
  ctx: CycleCtx,
  mem: { memory_id: string; body: string },
  result: {
    verdict: "retire" | "rewrite" | "keep";
    composite: number;
    should_auto_retire: boolean;
  },
): void {
  if (result.should_auto_retire) {
    const retired = retireNonDirectMemory(db, mem.memory_id, Date.now());
    db.prepare(
      `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES(?, ?, 'P3', 'retire', ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      ctx.cycleId,
      result.composite,
      retired ? "auto_applied" : "skipped_direct_origin",
      JSON.stringify([mem.memory_id]),
      JSON.stringify({ source: "quality_signal" }),
    );
  } else if (result.verdict === "rewrite" || result.verdict === "retire") {
    db.prepare(
      `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES(?, ?, 'P3', ?, ?, 'queued', ?, ?)`,
    ).run(
      crypto.randomUUID(),
      ctx.cycleId,
      result.verdict,
      result.composite,
      JSON.stringify([mem.memory_id]),
      JSON.stringify({ source: "quality_signal" }),
    );
  }
}

// ── P4: bounded discovery queue ───────────────────────────────────────────────

async function runCycleP4(
  db: Database,
  ctx: CycleCtx,
  deps: DreamCycleDeps,
  config: DreamConfig,
): Promise<void> {
  const p4Start = phaseStart(ctx, "P4");

  const p4Count = (
    db
      .prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND status='queued'`)
      .get() as { n: number }
  ).n;
  if (p4Count >= ctx.p4QueueMax) {
    db.prepare(
      `DELETE FROM dream_actions WHERE action_id = (SELECT action_id FROM dream_actions WHERE phase='P4' AND status='queued' AND expires_at IS NOT NULL AND expires_at < ? ORDER BY expires_at ASC LIMIT 1)`,
    ).run(ctx.nowMs);
  }

  const contradictions = db
    .prepare(
      `SELECT src_id, dst_id FROM memory_links WHERE link_type='contradicts' AND retired_at IS NULL`,
    )
    .all() as { src_id: string; dst_id: string }[];
  for (const c of contradictions) {
    const targetIds = JSON.stringify([c.src_id, c.dst_id].sort());
    const existing = db
      .prepare(
        `SELECT 1 FROM dream_actions WHERE action_type='resolve_contradiction' AND status='queued' AND target_ids=? LIMIT 1`,
      )
      .get(targetIds);
    if (!existing) {
      db.prepare(
        `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES(?, ?, 'P4', 'resolve_contradiction', 0.9, 'queued', ?, ?)`,
      ).run(
        crypto.randomUUID(),
        ctx.cycleId,
        targetIds,
        JSON.stringify({ link_type: "contradicts" }),
      );
    }
  }

  pruneExpiredRewriteCache(db, ctx.nowMs);

  if (deps.projectRegistry) {
    const tasks = buildProjectTasks(db, ctx, deps);
    await runWithConcurrency(tasks, ctx.rewriterConcurrency);
  }

  phaseEnd(db, ctx, "P4", p4Start);
}

function enqueueProjectMemories(
  db: Database,
  ctx: CycleCtx,
  project: ProjectRegistryEntry,
  tasks: (() => Promise<void>)[],
): void {
  const projectIdJson = JSON.stringify([project.project_id]);
  if (ctx.p4QueuedQueryExistsStmt.get(projectIdJson)) return;

  const memories = ctx.p4MemoryByProjectStmt.all(project.project_id) as {
    memory_id: string;
    title: string;
    body: string;
    updated_at: string;
  }[];

  for (const memory of memories) {
    if (!ctx.hasT2ProjectId && ctx.seenLegacyProjectlessMemoryIds.has(memory.memory_id)) continue;
    ctx.seenLegacyProjectlessMemoryIds.add(memory.memory_id);
    tasks.push(() => runMemoryRewrite(db, ctx, projectIdJson, memory));
  }
}

function buildProjectTasks(
  db: Database,
  ctx: CycleCtx,
  deps: DreamCycleDeps,
): (() => Promise<void>)[] {
  if (!deps.projectRegistry) return [];
  const tasks: (() => Promise<void>)[] = [];

  for (const project of deps.projectRegistry.list()) {
    const researchProvider = project.dreaming?.research_provider;
    if (!researchProvider || researchProvider === "off") continue;
    enqueueProjectMemories(db, ctx, project, tasks);
  }
  return tasks;
}

async function runMemoryRewrite(
  db: Database,
  ctx: CycleCtx,
  projectIdJson: string,
  memory: { memory_id: string; title: string; body: string; updated_at: string },
): Promise<void> {
  const updatedAtMs = parseUpdatedAtMs(memory.updated_at);
  const resolved = await resolveMemoryQuery(db, ctx, memory, updatedAtMs);
  if (!resolved) return;

  const { resolvedQuery, cacheHit, rewriteModel, rewriteLatencyMs } = resolved;

  if (ctx.gateEnabled) {
    const verdict = isWebSearchable(resolvedQuery);
    if (!verdict.ok) {
      ctx.emitDreamEvent("dream_p4_query_rejected_unsearchable", {
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
  if (ctx.p4NegativeSentinelStmt?.get(negKey, ctx.nowMs)) return;

  const queueCount = (ctx.p4QueueCountStmt.get() as { n: number }).n;
  if (queueCount >= ctx.p4QueueMax) return;

  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json) VALUES(?, ?, 'P4', 'research_query', 0.5, 'queued', ?, ?)`,
  ).run(
    crypto.randomUUID(),
    ctx.cycleId,
    projectIdJson,
    JSON.stringify({ query, source_memory_id: memory.memory_id }),
  );
}

function parseUpdatedAtMs(updatedAt: string): number {
  const fromIso = Date.parse(updatedAt);
  if (Number.isFinite(fromIso)) return fromIso;
  const fromNum = Number(updatedAt);
  return Number.isFinite(fromNum) ? fromNum : 0;
}

type ResolvedQuery = {
  resolvedQuery: string;
  cacheHit: boolean;
  rewriteModel: string;
  rewriteLatencyMs: number;
};

async function resolveMemoryQuery(
  db: Database,
  ctx: CycleCtx,
  memory: { memory_id: string; title: string; body: string },
  updatedAtMs: number,
): Promise<ResolvedQuery | null> {
  if (!ctx.rewriterEnabled) {
    return {
      resolvedQuery: memory.title,
      cacheHit: false,
      rewriteModel: ctx.rewriterModel,
      rewriteLatencyMs: 0,
    };
  }

  const cached = getRewriteForMemory({
    db,
    t2_memory_id: memory.memory_id,
    memory_updated_at_ms: updatedAtMs,
    model: ctx.rewriterModel,
    now_ms: ctx.nowMs,
  });

  if (cached) {
    if (cached.verdict.kind === "skip") {
      ctx.emitDreamEvent("dream_p4_query_skipped", {
        t2_memory_id: memory.memory_id,
        cache_hit: true,
        latency_ms: 0,
        model: cached.model,
      });
      return null;
    }
    ctx.emitDreamEvent("dream_p4_query_rewritten", {
      t2_memory_id: memory.memory_id,
      cache_hit: true,
      latency_ms: 0,
      model: cached.model,
    });
    return {
      resolvedQuery: cached.verdict.query,
      cacheHit: true,
      rewriteModel: cached.model,
      rewriteLatencyMs: 0,
    };
  }

  return await fetchRewriteFromLlm(db, ctx, memory, updatedAtMs);
}

async function fetchRewriteFromLlm(
  db: Database,
  ctx: CycleCtx,
  memory: { memory_id: string; title: string; body: string },
  updatedAtMs: number,
): Promise<ResolvedQuery | null> {
  if (!ctx.costMeter.canAfford("P4", "llm", ctx.phaseCostEstimates.p4RewriterLlmUsd)) return null;

  const prompt = buildDreamQueryRewritePrompt({ title: memory.title, bodyFirst200: memory.body });
  const rewriteStart = Date.now();
  const rewriteResult = await ctx.invokeLlm<typeof REWRITE_RESPONSE_SCHEMA>({
    baseUrl: ctx.rewriterBaseUrl,
    model: ctx.rewriterModel,
    messages: prompt,
    schema: REWRITE_RESPONSE_SCHEMA,
    timeoutMs: ctx.rewriterTimeoutMs,
  });
  ctx.costMeter.record("P4", "llm", ctx.phaseCostEstimates.p4RewriterLlmUsd);
  const rewriteLatencyMs = Date.now() - rewriteStart;

  if (!rewriteResult.ok) {
    ctx.emitDreamEvent("dream_p4_query_rewrite_failed", {
      t2_memory_id: memory.memory_id,
      cache_hit: false,
      model: ctx.rewriterModel,
      latency_ms: rewriteLatencyMs,
    });
    return null;
  }

  if (rewriteResult.value.kind === "skip") {
    setRewriteForMemory({
      db,
      t2_memory_id: memory.memory_id,
      memory_updated_at_ms: updatedAtMs,
      verdict: rewriteResult.value,
      model: ctx.rewriterModel,
      now_ms: ctx.nowMs,
      ttl_ms: ctx.rewriterCacheTtlMs,
    });
    ctx.emitDreamEvent("dream_p4_query_skipped", {
      t2_memory_id: memory.memory_id,
      cache_hit: false,
      model: ctx.rewriterModel,
      latency_ms: rewriteLatencyMs,
    });
    return null;
  }

  const passes = ctx.gateEnabled ? isWebSearchable(rewriteResult.value.query) : { ok: true };
  if (!passes.ok) {
    ctx.emitDreamEvent("dream_p4_query_rewrite_failed", {
      t2_memory_id: memory.memory_id,
      cache_hit: false,
      model: ctx.rewriterModel,
      latency_ms: rewriteLatencyMs,
    });
    return null;
  }

  const sanitized = sanitizeTitleForQuery(rewriteResult.value.query);
  if (!sanitized) return null;

  setRewriteForMemory({
    db,
    t2_memory_id: memory.memory_id,
    memory_updated_at_ms: updatedAtMs,
    verdict: { kind: "query", query: sanitized },
    model: ctx.rewriterModel,
    now_ms: ctx.nowMs,
    ttl_ms: ctx.rewriterCacheTtlMs,
  });
  ctx.emitDreamEvent("dream_p4_query_rewritten", {
    t2_memory_id: memory.memory_id,
    cache_hit: false,
    model: ctx.rewriterModel,
    latency_ms: rewriteLatencyMs,
  });
  return {
    resolvedQuery: sanitized,
    cacheHit: false,
    rewriteModel: ctx.rewriterModel,
    rewriteLatencyMs,
  };
}

// ── P5: active research ───────────────────────────────────────────────────────

async function runCycleP5(
  db: Database,
  ctx: CycleCtx,
  deps: DreamCycleDeps,
  config: DreamConfig,
): Promise<void> {
  const p5Start = phaseStart(ctx, "P5");
  const researchDeps: ResearchDeps = {
    getResearchAdapter: deps.getResearchAdapter,
    projectRegistry: deps.projectRegistry,
    contentQualityJudge: deps.contentQualityJudge,
    costMeter: ctx.costMeter,
    phaseCostEstimates: ctx.phaseCostEstimates,
  };
  await runP5Phase(db, ctx.cycleId, config, researchDeps);
  phaseEnd(db, ctx, "P5", p5Start);
}

// ── P6: brief refresh ─────────────────────────────────────────────────────────

async function runCycleP6(
  db: Database,
  ctx: CycleCtx,
  deps: DreamCycleDeps,
  config: DreamConfig,
): Promise<void> {
  const p6Start = phaseStart(ctx, "P6");
  const { projectRegistry, memoryObserve } = deps;

  if (projectRegistry && memoryObserve) {
    const briefRefreshMs = config.briefRefreshHours * 60 * 60 * 1000;
    for (const project of projectRegistry.list()) {
      await processProjectBrief(db, ctx, deps, config, project, briefRefreshMs, memoryObserve);
    }
  }

  phaseEnd(db, ctx, "P6", p6Start);
}

async function processProjectBrief(
  db: Database,
  ctx: CycleCtx,
  deps: DreamCycleDeps,
  config: DreamConfig,
  project: ProjectRegistryEntry,
  briefRefreshMs: number,
  memoryObserve: NonNullable<DreamCycleDeps["memoryObserve"]>,
): Promise<void> {
  if (!project.dreaming) return;

  const lastBrief = db
    .prepare(
      `SELECT generated_at FROM project_briefs WHERE project_id=? ORDER BY generated_at DESC LIMIT 1`,
    )
    .get(project.project_id) as { generated_at: number } | null;
  if (lastBrief && Date.now() - lastBrief.generated_at < briefRefreshMs) return;

  const brief = await buildBriefContent(db, ctx, deps, config, project);
  if (!brief) return;

  try {
    const { memory_id } = await memoryObserve(brief.briefMarkdown, project.project_id, ctx.cycleId);
    db.prepare(
      `INSERT OR REPLACE INTO project_briefs(project_id, brief_md, source_memory_ids, generated_at, generated_by_cycle, t2_shadow_memory_id) VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(
      project.project_id,
      brief.briefMarkdown,
      JSON.stringify(brief.sourceMemoryIds),
      Date.now(),
      ctx.cycleId,
      memory_id,
    );
  } catch (err) {
    console.error("P6 INSERT ERROR:", err);
  }
}

async function buildBriefContent(
  db: Database,
  ctx: CycleCtx,
  deps: DreamCycleDeps,
  config: DreamConfig,
  project: ProjectRegistryEntry,
): Promise<{ briefMarkdown: string; sourceMemoryIds: string[] } | null> {
  if (!deps.briefSynthesizer) {
    return {
      briefMarkdown: "# Project Brief: " + project.project_id + "\nGenerated by P6.",
      sourceMemoryIds: [],
    };
  }

  if (!ctx.costMeter.canAfford("P6", "llm", ctx.phaseCostEstimates.p6BriefSynthLlmUsd)) return null;

  const maxMemories = config.briefSynthMaxMemories ?? 20;
  const recentMemories = db
    .prepare(
      `SELECT memory_id, kind, title, body, created_at FROM t2_memories WHERE project_id = ? AND kind != 'brief' AND retired_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    )
    .all(project.project_id, maxMemories) as {
    memory_id: string;
    kind: string;
    title: string;
    body: string;
    created_at: string;
  }[];

  const priorBriefRow = db
    .prepare(
      `SELECT brief_md FROM project_briefs WHERE project_id=? ORDER BY generated_at DESC LIMIT 1`,
    )
    .get(project.project_id) as { brief_md: string } | null;

  try {
    const result = await deps.briefSynthesizer.synthesize({
      project_id: project.project_id,
      recent_memories: recentMemories,
      prior_brief: priorBriefRow?.brief_md,
    });
    ctx.costMeter.record("P6", "llm", ctx.phaseCostEstimates.p6BriefSynthLlmUsd);
    return {
      briefMarkdown: result.markdown,
      sourceMemoryIds: result.source_memory_ids,
    };
  } catch (err) {
    console.warn("P6: synthesizer failed, falling back to stub", {
      err,
      project_id: project.project_id,
    });
    return {
      briefMarkdown:
        "# Project Brief: " + project.project_id + "\nGenerated by P6 (synthesizer failed).",
      sourceMemoryIds: [],
    };
  }
}

// ── P7: re-embed stale vectors ────────────────────────────────────────────────

async function runCycleP7(
  db: Database,
  ctx: CycleCtx,
  deps: DreamCycleDeps,
  config: DreamConfig,
): Promise<void> {
  if (config.skipPhases.has("P7")) return;
  const p7Start = phaseStart(ctx, "P7");
  const reembedOutcome = await runReembedPhase(db, ctx.cycleId, config, {
    ...deps,
    costMeter: ctx.costMeter,
    phaseCostEstimates: ctx.phaseCostEstimates,
  });
  if (!reembedOutcome.deferred) phaseEnd(db, ctx, "P7", p7Start);
}

// ── P8: audit ─────────────────────────────────────────────────────────────────

function runCycleP8(db: Database, ctx: CycleCtx): void {
  const p8Start = phaseStart(ctx, "P8");
  phaseEnd(db, ctx, "P8", p8Start);
}

// ── Concurrency helper ────────────────────────────────────────────────────────

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const limit = Math.max(1, Number.isFinite(concurrency) ? Math.trunc(concurrency) : 1);
  const results = new Array<T>(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
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

// ── Utility functions ─────────────────────────────────────────────────────────

function normalizeBudgetFractions(
  fractions: DreamPhaseBudgetFractions | undefined,
): DreamPhaseBudgetFractions {
  const base = fractions ?? DEFAULT_PHASE_BUDGET_FRACTIONS;
  const llm = Number.isFinite(base.llm) ? Math.max(0, base.llm) : 0;
  const embedding = Number.isFinite(base.embedding) ? Math.max(0, base.embedding) : 0;
  const research = Number.isFinite(base.research) ? Math.max(0, base.research) : 0;
  const total = llm + embedding + research;
  if (total <= 0) return { ...DEFAULT_PHASE_BUDGET_FRACTIONS };
  return { llm: llm / total, embedding: embedding / total, research: research / total };
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
      `SELECT llm_spent_usd, embedding_spent_usd, research_spent_usd FROM dream_cycles WHERE cycle_id = ?`,
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
      `SELECT COALESCE(SUM(${column}), 0) AS total FROM dream_cycles WHERE started_at >= ? AND outcome != 'crashed'`,
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
  const timer = setInterval(() => {
    void runDreamCycle(deps.db, deps.config, deps.cycleDeps).catch((err: unknown) => {
      deps.log?.warn({ err: String(err) }, "dreaming: cycle failed unexpectedly");
    });
  }, intervalMs);
  const timerRef = timer as unknown as { unref?: () => void };
  if (typeof timerRef.unref === "function") {
    timerRef.unref();
  }
  return () => {
    clearInterval(timer);
  };
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

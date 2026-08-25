import type { ModelAliasMap, TaskRouterConfig } from "@penumbra/config";
import type { Database } from "bun:sqlite";

import type { AgentTaskType } from "../schemas/agent-performance.js";
import type { TaskProfileJudge } from "./task-profile-judge.js";

import {
  decide,
  type DecideInput,
  type RouterAaSnapshot,
  type RouterDependencies,
} from "./router.js";
import { type HarnessContext, HarnessContextSchema, type RoutingDecision } from "./schemas.js";
import { profileTaskDeterministic, type TaskProfileHints } from "./task-profile.js";

/**
 * The stable, current-config inputs to replay every historical handoff
 * against. This is "what would the router pick today," not a reconstruction
 * of what was available at dispatch time — that's the whole point of replay.
 */
export interface ReplayConfig {
  mode: DecideInput["mode"];
  routerConfig: TaskRouterConfig;
  aliasMap: ModelAliasMap;
  agentchatConfig: DecideInput["agentchatConfig"];
  agentRegistry: readonly string[];
  aaSnapshot?: RouterAaSnapshot;
}

export interface ReplayOptions {
  since: string;
  until: string;
  /** Weight names to perturb by +-10% per row, flagging any winner flip. */
  weightPerturbations?: readonly (keyof TaskRouterConfig["weights"])[];
  /** decision.confidence below this is surfaced in lowConfidenceDecisions. Default 0.5. */
  lowConfidenceThreshold?: number;
}

export interface ReplayDependencies {
  routerDeps: RouterDependencies;
  // Accepted only for interface parity with live two-stage (judged) routing.
  // Replay is deterministic-profiler-only by contract and this is NEVER
  // invoked — see replay.test.ts "replay never calls a model", which injects
  // a throwing judge here to pin that structurally rather than by discipline.
  judge?: TaskProfileJudge;
}

export interface ReplayRowResult {
  handoffId: string;
  ts: string;
  historicalAgent: string;
  replayedAgent: string | null;
  agreed: boolean;
  confidence: number;
}

export interface RouteTally {
  routeId: string;
  count: number;
}

export interface ExclusionTally {
  routeId: string;
  count: number;
  reasons: string[];
}

export interface WeightPerturbationFinding {
  weight: keyof TaskRouterConfig["weights"];
  handoffId: string;
  baselineAgent: string | null;
  plusTenPercentAgent: string | null;
  minusTenPercentAgent: string | null;
  flipped: boolean;
}

export interface ReplayReport {
  since: string;
  until: string;
  totalHandoffs: number;
  profiledHandoffs: number;
  skippedNoPerformanceRow: number;
  skippedInvalidContext: number;
  agreedCount: number;
  disagreedCount: number;
  agreementRate: number | null;
  mostSelectedRoutes: RouteTally[];
  mostExcludedRoutes: ExclusionTally[];
  lowConfidenceDecisions: { handoffId: string; confidence: number }[];
  weightSensitivity: WeightPerturbationFinding[];
  rows: ReplayRowResult[];
}

interface ReplayRawRow {
  handoff_id: string;
  ts: string;
  to_agent: string;
  to_role: string | null;
  message: string;
  project_id: string | null;
  dispatch_kind: string | null;
  performance_handoff_id: string | null;
  performance_task_type: string | null;
}

/** Everything derived from a raw row's message/role/hints, reused across the
 * baseline decision and every weight-perturbation re-run. */
interface RowContext {
  role: string | undefined;
  hints: TaskProfileHints;
  taskProfile: ReturnType<typeof profileTaskDeterministic>;
  harnessContext: HarnessContext;
}

const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Replays historical handoffs through today's router config and reports
 * whether it would have picked the same agent. Never calls a model: task
 * profiling uses the deterministic profiler only (see ReplayDependencies.judge).
 */
export function replay(
  db: Database,
  config: ReplayConfig,
  opts: ReplayOptions,
  deps: ReplayDependencies,
): ReplayReport {
  const rawRows = fetchReplayRows(db, opts.since, opts.until);
  const profiledRows = rawRows.filter((row) => row.performance_handoff_id !== null);
  const noPerformanceCount = rawRows.length - profiledRows.length;
  const lowConfidenceThreshold = opts.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD;

  const stats = new ReplayStats();
  for (const row of profiledRows) {
    const ctx = buildRowContext(row);
    if (ctx === null) {
      stats.skipInvalidContext();
      continue;
    }
    const decision = decide(
      buildDecideInput(db, config, row, ctx, config.routerConfig),
      deps.routerDeps,
    );
    const replayedAgent = decision.selected?.agent ?? null;
    stats.record(row, decision, replayedAgent, lowConfidenceThreshold);

    for (const weight of opts.weightPerturbations ?? []) {
      stats.weightSensitivity.push(
        computeWeightSensitivity(db, config, deps, row, ctx, weight, replayedAgent),
      );
    }
  }

  return stats.toReport(opts, rawRows.length, stats.rows.length, noPerformanceCount);
}

function fetchReplayRows(db: Database, since: string, until: string): ReplayRawRow[] {
  return db
    .query<ReplayRawRow, [string, string]>(
      `
      SELECT h.handoff_id                 AS handoff_id,
             h.ts                         AS ts,
             h.to_agent                   AS to_agent,
             h.to_role                    AS to_role,
             h.message                    AS message,
             h.project_id                 AS project_id,
             h.dispatch_kind              AS dispatch_kind,
             ap.handoff_id                AS performance_handoff_id,
             ap.task_type                 AS performance_task_type
      FROM handoffs h
      LEFT JOIN agent_performance ap ON ap.handoff_id = h.handoff_id
      WHERE h.ts >= ? AND h.ts <= ?
      ORDER BY h.ts ASC
      `,
    )
    .all(since, until);
}

function buildRowContext(row: ReplayRawRow): RowContext | null {
  const hints: TaskProfileHints = {
    ...(row.performance_task_type ? { taskType: row.performance_task_type as AgentTaskType } : {}),
  };
  const role = row.to_role ?? undefined;
  const taskProfile = profileTaskDeterministic(row.message, role, hints);
  const harnessContextInput = {
    ...(role !== undefined ? { role } : {}),
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.dispatch_kind !== null ? { dispatchKind: row.dispatch_kind } : {}),
    promptChars: row.message.length,
  };
  const harnessContextResult = HarnessContextSchema.safeParse(harnessContextInput);
  if (!harnessContextResult.success) return null;
  const harnessContext: HarnessContext = harnessContextResult.data;
  return { role, hints, taskProfile, harnessContext };
}

function buildDecideInput(
  db: Database,
  config: ReplayConfig,
  row: ReplayRawRow,
  ctx: RowContext,
  routerConfig: TaskRouterConfig,
): DecideInput {
  return {
    mode: config.mode,
    db,
    role: ctx.role ?? "",
    message: row.message,
    taskType: ctx.hints.taskType,
    taskProfile: ctx.taskProfile,
    harnessContext: ctx.harnessContext,
    routerConfig,
    aliasMap: config.aliasMap,
    aaSnapshot: config.aaSnapshot,
    agentchatConfig: config.agentchatConfig,
    agentRegistry: config.agentRegistry,
  };
}

function computeWeightSensitivity(
  db: Database,
  config: ReplayConfig,
  deps: ReplayDependencies,
  row: ReplayRawRow,
  ctx: RowContext,
  weight: keyof TaskRouterConfig["weights"],
  baselineAgent: string | null,
): WeightPerturbationFinding {
  const runWith = (factor: number): string | null =>
    decide(
      buildDecideInput(db, config, row, ctx, perturbWeight(config.routerConfig, weight, factor)),
      deps.routerDeps,
    ).selected?.agent ?? null;

  const plusTenPercentAgent = runWith(1.1);
  const minusTenPercentAgent = runWith(0.9);

  return {
    weight,
    handoffId: row.handoff_id,
    baselineAgent,
    plusTenPercentAgent,
    minusTenPercentAgent,
    flipped: plusTenPercentAgent !== baselineAgent || minusTenPercentAgent !== baselineAgent,
  };
}

function perturbWeight(
  config: TaskRouterConfig,
  weight: keyof TaskRouterConfig["weights"],
  factor: number,
): TaskRouterConfig {
  return {
    ...config,
    weights: {
      ...config.weights,
      [weight]: Math.max(0, config.weights[weight] * factor),
    },
  };
}

/** Accumulates per-row outcomes into the aggregate tallies the report surfaces. */
class ReplayStats {
  readonly rows: ReplayRowResult[] = [];
  readonly weightSensitivity: WeightPerturbationFinding[] = [];
  private readonly selectedTally = new Map<string, number>();
  private readonly excludedTally = new Map<string, { count: number; reasons: Set<string> }>();
  private readonly lowConfidenceDecisions: { handoffId: string; confidence: number }[] = [];
  private skippedInvalidContext = 0;
  private agreedCount = 0;
  private disagreedCount = 0;

  record(
    row: ReplayRawRow,
    decision: RoutingDecision,
    replayedAgent: string | null,
    lowConfidenceThreshold: number,
  ): void {
    // A null replayedAgent means the router had no opinion / no selection; that
    // still counts against agreement because the denominator is profiled rows.
    const agreed = replayedAgent !== null && replayedAgent === row.to_agent;
    if (agreed) this.agreedCount++;
    else this.disagreedCount++;

    this.rows.push({
      handoffId: row.handoff_id,
      ts: row.ts,
      historicalAgent: row.to_agent,
      replayedAgent,
      agreed,
      confidence: decision.confidence,
    });

    if (decision.selected) {
      this.selectedTally.set(
        decision.selected.routeId,
        (this.selectedTally.get(decision.selected.routeId) ?? 0) + 1,
      );
    }
    for (const alternative of decision.alternatives) {
      if (!alternative.excluded) continue;
      const existing = this.excludedTally.get(alternative.routeId) ?? {
        count: 0,
        reasons: new Set<string>(),
      };
      existing.count++;
      for (const reason of alternative.reasons) existing.reasons.add(reason);
      this.excludedTally.set(alternative.routeId, existing);
    }
    if (decision.confidence < lowConfidenceThreshold) {
      this.lowConfidenceDecisions.push({
        handoffId: row.handoff_id,
        confidence: decision.confidence,
      });
    }
  }

  skipInvalidContext(): void {
    this.skippedInvalidContext++;
  }

  toReport(
    opts: ReplayOptions,
    totalHandoffs: number,
    profiledHandoffs: number,
    noPerformanceCount: number,
  ): ReplayReport {
    const mostSelectedRoutes = [...this.selectedTally.entries()]
      .map(([routeId, count]) => ({ routeId, count }))
      .sort((a, b) => b.count - a.count || a.routeId.localeCompare(b.routeId));
    const mostExcludedRoutes = [...this.excludedTally.entries()]
      .map(([routeId, value]) => ({ routeId, count: value.count, reasons: [...value.reasons] }))
      .sort((a, b) => b.count - a.count || a.routeId.localeCompare(b.routeId));

    return {
      since: opts.since,
      until: opts.until,
      totalHandoffs,
      profiledHandoffs,
      skippedNoPerformanceRow: noPerformanceCount,
      skippedInvalidContext: this.skippedInvalidContext,
      agreedCount: this.agreedCount,
      disagreedCount: this.disagreedCount,
      agreementRate: profiledHandoffs > 0 ? this.agreedCount / profiledHandoffs : null,
      mostSelectedRoutes,
      mostExcludedRoutes,
      lowConfidenceDecisions: this.lowConfidenceDecisions,
      weightSensitivity: this.weightSensitivity,
      rows: this.rows,
    };
  }
}

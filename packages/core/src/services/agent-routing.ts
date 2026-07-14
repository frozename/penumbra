import type { AgentPool } from "@penumbra/config";
import type { Database } from "bun:sqlite";

import type { RoutingBias } from "../readers/routing-bias.js";
import type { PressureWarning } from "../readers/subscription-pressure.js";

import {
  type AgentKind,
  type AgentRankOutput,
  type AgentTaskType,
  DEFAULT_AGENT_KIND,
  inferAgentTaskTypeForRole,
} from "../schemas/agent-performance.js";

type AgentRoutePressureSnapshot = {
  snapshots: {
    provider: string;
    window_label: string;
    model: string | null;
    used_pct: number;
    resets_at: number | null;
    observed_at: string;
    source_kind: string;
  }[];
  // Stale-snapshot warnings from readSubscriptionPressure. When present, the
  // scorer filters snapshots with a matching (provider, window_label, model)
  // key OUT before both exclusion and pressure-scaling — fail-OPEN so a stale
  // 100% used_pct doesn't hard-throttle a provider indefinitely (mirrors the
  // fail-open contract in packages/daemon/src/pressure.ts).
  warnings?: PressureWarning[];
};

export type ResolvedAgentPoolMember = { agent: string; tier: "local" | "cloud" };
export type AgentPoolDropReason = "not-in-registry" | "unhealthy";
export type DroppedAgentPoolMember = { agent: string; reason: AgentPoolDropReason };
export type ResolveAgentPoolContext = {
  registry: Set<string> | string[];
  isLocal?: (agent: string) => boolean;
  isHealthy?: (agent: string) => boolean;
  rank?: (agents: string[]) => string[];
};
export type ResolveAgentPoolResult = {
  ordered: ResolvedAgentPoolMember[];
  dropped: DroppedAgentPoolMember[];
};

type NormalizedAgentPool = {
  members: { agent: string; tier?: "local" | "cloud" }[];
  select: "rank" | "order";
  fallback_to_cloud: boolean;
};

function normalizeAgentPool(pool: AgentPool): NormalizedAgentPool {
  if (typeof pool === "string") {
    return {
      members: [{ agent: pool }],
      select: "order",
      fallback_to_cloud: true,
    };
  }
  if (Array.isArray(pool)) {
    return {
      members: pool.map((agent) => ({ agent })),
      select: "order",
      fallback_to_cloud: true,
    };
  }
  return {
    members: pool.members,
    select: pool.select === "rank" ? "rank" : "order",
    fallback_to_cloud: pool.fallback_to_cloud ?? true,
  };
}

function resolveMemberTier(
  member: { agent: string; tier?: "local" | "cloud" },
  isLocal: ((agent: string) => boolean) | undefined,
): "local" | "cloud" {
  if (!isLocal) return member.tier ?? "cloud";
  const probedTier = isLocal(member.agent) ? "local" : "cloud";
  if (member.tier && member.tier !== probedTier) {
    console.warn(
      `agent pool tier mismatch for ${member.agent}: config=${member.tier} probe=${probedTier}`,
    );
  }
  return probedTier;
}

function orderAgentPoolPartition(
  members: ResolvedAgentPoolMember[],
  select: NormalizedAgentPool["select"],
  rank: ((agents: string[]) => string[]) | undefined,
): ResolvedAgentPoolMember[] {
  if (select === "order" || members.length <= 1) return members;
  if (!rank) return members;
  const byName = new Map(members.map((member) => [member.agent, member]));
  const ranked = rank(members.map((member) => member.agent))
    .map((agent) => byName.get(agent))
    .filter((member): member is ResolvedAgentPoolMember => member !== undefined);
  const rankedNames = new Set(ranked.map((member) => member.agent));
  return [...ranked, ...members.filter((member) => !rankedNames.has(member.agent))];
}

export function resolveAgentPool(
  pool: AgentPool,
  ctx: ResolveAgentPoolContext,
): ResolveAgentPoolResult {
  const registry = ctx.registry instanceof Set ? ctx.registry : new Set(ctx.registry);
  const isHealthy = ctx.isHealthy ?? ((): boolean => true);
  const normalized = normalizeAgentPool(pool);
  const dropped: DroppedAgentPoolMember[] = [];
  const survivors: ResolvedAgentPoolMember[] = [];

  for (const member of normalized.members) {
    if (!registry.has(member.agent)) {
      dropped.push({ agent: member.agent, reason: "not-in-registry" });
      continue;
    }
    // Future seam: callers can fold cloud volume caps or circuit breakers into isHealthy.
    if (!isHealthy(member.agent)) {
      dropped.push({ agent: member.agent, reason: "unhealthy" });
      continue;
    }
    survivors.push({
      agent: member.agent,
      tier: resolveMemberTier(member, ctx.isLocal),
    });
  }

  const local = orderAgentPoolPartition(
    survivors.filter((member) => member.tier === "local"),
    normalized.select,
    ctx.rank,
  );
  const cloud = orderAgentPoolPartition(
    survivors.filter((member) => member.tier === "cloud"),
    normalized.select,
    ctx.rank,
  );
  const ordered = [...local, ...(normalized.fallback_to_cloud ? cloud : [])];

  return { ordered, dropped };
}

type AgentRouteAgentchatConfig = {
  agents: {
    name: string;
    roles: string[];
    subscription_provider?: string;
    api_provider?: string;
    pricing_mode?: "api" | "subscription";
    // Adapter identifier from agentchat config (e.g. "stdio-acp", "claude-acp",
    // "openai-compat-http"). Optional so unaware callers stay compatible; the
    // tool-free penalty only fires when both adapter is populated AND
    // RouteAgentInput.tool_free === true.
    adapter?: string;
  }[];
  role_routing?: {
    headroom_weighting?: boolean;
    latency_weighting?: boolean;
    warm_pool_reuse_weighting?: boolean;
    exploration_policy?: string;
  };
};

export type DetailMode = "rank" | "summary" | "single";

export type RoleRoute = {
  agent: string;
  role: string;
  taskType: AgentTaskType;
};

export type AgentRecommendation = {
  agent_name: string;
  task_type: string;
  samples: number;
  success_rate: number;
  gate_verdict_coverage: number;
  gate_pass_rate: number;
  avg_latency_seconds: number | null;
  last_observed_at: string;
};

export interface RouteAgentInput {
  db: Database;
  detail: DetailMode;
  taskType?: AgentTaskType;
  role?: string;
  message?: string;
  windowDays?: number;
  since?: string;
  minSamples?: number;
  includeNeutral?: boolean;
  includeCost?: boolean;
  agentKind?: AgentKind;
  riskClass?: string;
  agentchatConfig?: AgentRouteAgentchatConfig;
  roleExplorationPolicy?: "unsampled-first" | "ranked-first";
  defaultRoles?: Record<string, string>;
  agentRegistry?: string[] | null;
  applyPressure?: AgentRoutePressureSnapshot;
  // User-driven routing-bias steers (usage steering). Injected by the caller
  // (daemon reads readRoutingBiases); the scorer never reads the DB itself.
  activeBiases?: RoutingBias[];
  unhealthyAgents?: ReadonlySet<string>;
  // Per-agent ACP warm-pool session reuse rates from fleet-latency. Values in [0,1].
  // When warm_pool_reuse_weighting is enabled, agents with higher rates receive a
  // mild multiplicative score preference. Absent means no adjustment.
  warmPoolReuseRates?: Record<string, number>;
  // Caller-asserted "no penumbra-tool calls expected" hint. When true, the
  // scorer applies a modest multiplicative penalty to ACP-adapter candidates
  // so a fast HTTP seat outranks an equivalent (but much slower at startup)
  // ACP seat for pure text-generation tasks. The penalty composes with the
  // latency term; it is NOT a hard filter. Unset/false leaves scoring
  // byte-identical to today (inert by default, fail-safe).
  //
  // Wiring seam: the natural caller is the workflow synthesizer/persona
  // text-dispatch path (plugin/workflows/_shared/pool-resolver.ts →
  // packages/core/src/tasks/pick-from-pool.ts). Set tool_free:true there for
  // synthesizer-style roles whose role contract is text-only. Do NOT derive
  // tool_free from use_worktree: a no-worktree task can still need non-file
  // MCP tools, so that proxy is unsafe.
  tool_free?: boolean;
  now?: Date;
}

export type RouteAgentOutput =
  | { detail: "rank"; candidates: AgentRankOutput }
  | { detail: "summary"; recommendations: AgentRecommendation[] }
  | { detail: "single"; route: RoleRoute | null };

interface PerformanceRow {
  agent_name: string;
  task_type: string;
  outcome: string;
  rounds: number | null;
  smoke_pass: string | null;
  reviewer_findings: number | null;
  maestro_score: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  exec_ms: number | null;
  framework_overhead_ms: number | null;
  ts: string;
  agent_kind: string | null;
  gate_outcome: string | null;
  failure_class: string | null;
  trust_score: number | null;
}

interface CandidateSummary {
  agent_name: string;
  samples: number;
  successes: number;
  failures: number;
  neutral: number;
  success_rate: number;
  avg_rounds: number | null;
  avg_latency_ms: number | null;
  avg_exec_ms: number | null;
  _latency_exec_ms: number | null;
  cost_per_success_usd: number | null;
  avg_reviewer_findings: number | null;
  avg_trust_score: number | null;
  gate_verdict_count: number;
  gate_pass_count: number;
  last_outcome_at: string;
  _outcome_score: number;
  _rounds_score: number;
  _smoke_score: number;
  _reviewer_score: number;
  _maestro_score: number;
}

export const DEFAULT_GATE_OUTCOME_CUTOVER_ISO = "2026-06-12T00:00:00.000Z";
export const DEFAULT_CLASSIFIER_DECLINE_CUTOVER_ISO = "2026-06-13T00:00:00.000Z";

// Graduation plan: once every pre-cutover NULL verdict has been reconciled to
// an explicit gate outcome, retire the `ts < cutover` branch and remove the
// env override. Keep the warning loud so any earlier override is intentional.
let loggedGateOutcomeCutoverIso: string | null = null;
let loggedClassifierDeclineCutoverIso: string | null = null;

export function resolveGateOutcomeCutoverIso(): string {
  const raw = process.env.PENUMBRA_GATE_OUTCOME_CUTOVER_ISO;
  const candidate = raw === undefined || raw.trim() === "" ? DEFAULT_GATE_OUTCOME_CUTOVER_ISO : raw;
  const parsed = new Date(candidate);
  const resolved = Number.isNaN(parsed.getTime())
    ? DEFAULT_GATE_OUTCOME_CUTOVER_ISO
    : parsed.toISOString();
  if (loggedGateOutcomeCutoverIso !== resolved) {
    if (
      raw !== undefined &&
      raw.trim() !== "" &&
      resolved < DEFAULT_GATE_OUTCOME_CUTOVER_ISO &&
      resolved === parsed.toISOString()
    ) {
      console.warn(
        `[agent-routing] PENUMBRA_GATE_OUTCOME_CUTOVER_ISO=${resolved} is earlier than default ${DEFAULT_GATE_OUTCOME_CUTOVER_ISO}; this relaxes legacy NULL-verdict reporting.`,
      );
    }
    loggedGateOutcomeCutoverIso = resolved;
  }
  return resolved;
}

export function resolveClassifierDeclineCutoverIso(): string {
  const raw = process.env.PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO;
  const candidate =
    raw === undefined || raw.trim() === "" ? DEFAULT_CLASSIFIER_DECLINE_CUTOVER_ISO : raw;
  const parsed = new Date(candidate);
  const resolved = Number.isNaN(parsed.getTime())
    ? DEFAULT_CLASSIFIER_DECLINE_CUTOVER_ISO
    : parsed.toISOString();
  if (loggedClassifierDeclineCutoverIso !== resolved) {
    if (
      raw !== undefined &&
      raw.trim() !== "" &&
      resolved < DEFAULT_CLASSIFIER_DECLINE_CUTOVER_ISO &&
      resolved === parsed.toISOString()
    ) {
      console.warn(
        `[agent-routing] PENUMBRA_CLASSIFIER_DECLINE_CUTOVER_ISO=${resolved} is earlier than default ${DEFAULT_CLASSIFIER_DECLINE_CUTOVER_ISO}; this relaxes the legacy classifier-decline exemption predicate.`,
      );
    }
    loggedClassifierDeclineCutoverIso = resolved;
  }
  return resolved;
}

// Single source for outcome success eligibility. The SQL predicate
// (buildSuccessPredicate) and the in-memory checks (isSuccessOutcome,
// rowOutcomeBucket) derive from this array — change it here, never inline, or
// the two scoring paths diverge. Gate outcomes remain a separate quality axis.
export const SUCCESS_OUTCOME_VALUES = [
  "merged",
  "pr_opened",
  "merged_with_concerns",
  "completed_with_output",
] as const;
// Single source for outcomes that should NOT count toward success_rate
// denominators. The SQL summary path (buildRecommendations) and the in-memory
// rank path (rowOutcomeBucket + the visibleRows filter in buildRank) must
// derive from this array — change it here, never inline, or the two paths
// diverge on which seats appear in the ranked pool.
export const NEUTRAL_OUTCOME_VALUES = ["no_changes", "bypassed"] as const;
export const GATE_OUTCOME_PASS_VALUES = ["passed", "skipped"] as const;

function sqlInList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(",");
}

export function buildSuccessPredicate(): {
  sql: string;
  params: Record<string, never>;
} {
  return {
    sql: `outcome IN (${sqlInList(SUCCESS_OUTCOME_VALUES)})`,
    params: {},
  };
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Min success_rate a candidate must clear before the latency term can influence
 * its score — so a fast-but-failing agent is never promoted on speed alone.
 */
const LATENCY_MIN_SUCCESS_FLOOR = 0.2;
/**
 * Maximum multiplicative score lift a perfect warm-pool reuse rate (1.0) can
 * apply. Bounded so the reuse signal is a mild preference, never a dominance
 * signal — a 5% lift cannot overcome a meaningfully worse outcome record.
 */
const WARM_POOL_REUSE_MAX_BOOST = 0.05;
/**
 * Multiplicative score factor applied to ACP-adapter candidates when the
 * caller asserts tool_free:true. Modest by design: a nudge that composes with
 * the latency term to break ties in favor of fast HTTP seats for pure text
 * tasks, never a hard filter. A clearly stronger ACP agent (better outcome
 * history) still wins.
 */
const TOOL_FREE_ACP_PENALTY = 0.85;
const DEFAULT_RANK_WINDOW_DAYS = 30;
/** Fraction trimmed from each tail before averaging exec_ms (outlier guard). */
const EXEC_WINSOR_TRIM_FRAC = 0.1;

/**
 * Winsorized mean: clip the top/bottom EXEC_WINSOR_TRIM_FRAC of samples to the
 * in-distribution tail before averaging, so a single pathological dispatch
 * (e.g. one 25-min outlier) can't make an otherwise-fast agent look slow. With
 * too few samples to trim a whole element, falls back to the plain mean.
 */
function winsorizedMean(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const k = Math.floor(EXEC_WINSOR_TRIM_FRAC * n);
  if (k === 0) return sorted.reduce((sum, v) => sum + v, 0) / n;
  const lo = sorted[k];
  const hi = sorted[n - 1 - k];
  if (lo === undefined || hi === undefined) return null;
  let total = 0;
  for (const v of sorted) total += v < lo ? lo : v > hi ? hi : v;
  return total / n;
}

function isSuccessOutcome(outcome: string): boolean {
  return (SUCCESS_OUTCOME_VALUES as readonly string[]).includes(outcome);
}

function isClassifierDeclineExempt(row: Pick<PerformanceRow, "failure_class" | "ts">): boolean {
  return (
    row.failure_class === "classifier_declined" && row.ts >= resolveClassifierDeclineCutoverIso()
  );
}

function rowOutcomeScore(row: PerformanceRow): number {
  switch (row.outcome) {
    case "merged":
    case "pr_opened":
    case "completed_with_output":
      return 1;
    case "merged_with_concerns":
      return 0.85;
    case "partial":
      return 0.35;
    case "rejected":
      return 0.2;
    case "failed":
    case "typecheck_failed":
    case "test_failed":
    case "pr_creation_failed":
      return 0;
    case "no_changes":
    case "bypassed":
      return 0.5;
    default:
      return 0;
  }
}

function rowOutcomeBucket(row: PerformanceRow): "success" | "failure" | "neutral" {
  if (isSuccessOutcome(row.outcome)) return "success";
  if ((NEUTRAL_OUTCOME_VALUES as readonly string[]).includes(row.outcome)) return "neutral";
  return "failure";
}

function smokeValue(smoke: string | null): number {
  if (smoke === "y") return 1;
  if (smoke === "partial") return 0.5;
  if (smoke === "n/a") return 0.5;
  if (smoke === "n") return 0;
  return 0.5;
}

interface AgentRowAccumulator {
  successes: number;
  failures: number;
  neutral: number;
  roundsSum: number;
  roundsCount: number;
  latencySum: number;
  latencyCount: number;
  execMsValues: number[];
  trueExecMsValues: number[];
  successCostSum: number;
  successCostCount: number;
  reviewerSum: number;
  reviewerCount: number;
  trustScoreSum: number;
  trustScoreCount: number;
  gateVerdictCount: number;
  gatePassCount: number;
  outcomeScoreSum: number;
  roundsScoreSum: number;
  smokeScoreSum: number;
  reviewerScoreSum: number;
  maestroScoreSum: number;
  lastOutcomeAt: string;
}

function makeAccumulator(seedTs: string): AgentRowAccumulator {
  return {
    successes: 0,
    failures: 0,
    neutral: 0,
    roundsSum: 0,
    roundsCount: 0,
    latencySum: 0,
    latencyCount: 0,
    execMsValues: [],
    trueExecMsValues: [],
    successCostSum: 0,
    successCostCount: 0,
    reviewerSum: 0,
    reviewerCount: 0,
    trustScoreSum: 0,
    trustScoreCount: 0,
    gateVerdictCount: 0,
    gatePassCount: 0,
    outcomeScoreSum: 0,
    roundsScoreSum: 0,
    smokeScoreSum: 0,
    reviewerScoreSum: 0,
    maestroScoreSum: 0,
    lastOutcomeAt: seedTs,
  };
}

function accumulateOutcome(
  acc: AgentRowAccumulator,
  row: PerformanceRow,
  bucket: "success" | "failure" | "neutral",
): void {
  if (bucket === "success") acc.successes++;
  else if (bucket === "neutral") acc.neutral++;
  else acc.failures++;

  // Verdict contract (shared with the SQL path in buildRecommendations):
  // any non-null gate_outcome counts as a verdict — INCLUDING 'review_debt'
  // (work that shipped past the review grace window). review_debt is a
  // verdict-bearing NON-pass, not a never-attempted lane; excluding it would
  // hide timed-out reviews from gate coverage. gate_pass narrows to
  // GATE_OUTCOME_PASS_VALUES. The SQL aggregator MUST mirror this exactly;
  // the F4 denominator-parity test pins both paths together.
  if (row.gate_outcome !== null) {
    acc.gateVerdictCount++;
    if ((GATE_OUTCOME_PASS_VALUES as readonly string[]).includes(row.gate_outcome)) {
      acc.gatePassCount++;
    }
  }
  if (bucket === "success" && row.cost_usd !== null) {
    acc.successCostSum += row.cost_usd;
    acc.successCostCount++;
  }
}

function accumulateRounds(acc: AgentRowAccumulator, row: PerformanceRow): void {
  if (row.rounds !== null) {
    acc.roundsSum += row.rounds;
    acc.roundsCount++;
    acc.roundsScoreSum += clamp01(1 / row.rounds);
  } else {
    acc.roundsScoreSum += 0.5;
  }
}

function accumulateLatencyAndExec(acc: AgentRowAccumulator, row: PerformanceRow): void {
  if (row.latency_ms !== null) {
    acc.latencySum += row.latency_ms;
    acc.latencyCount++;
  }
  if (row.exec_ms !== null) {
    acc.execMsValues.push(row.exec_ms);
    acc.trueExecMsValues.push(Math.max(0, row.exec_ms - (row.framework_overhead_ms ?? 0)));
  }
}

function accumulateReviewerAndScore(acc: AgentRowAccumulator, row: PerformanceRow): void {
  if (row.reviewer_findings !== null) {
    acc.reviewerSum += row.reviewer_findings;
    acc.reviewerCount++;
    acc.reviewerScoreSum += clamp01(1 - Math.min(row.reviewer_findings, 10) / 10);
  } else {
    acc.reviewerScoreSum += 0.5;
  }
  acc.maestroScoreSum += row.maestro_score !== null ? clamp01(row.maestro_score / 5) : 0.5;
  if (row.trust_score !== null) {
    acc.trustScoreSum += row.trust_score;
    acc.trustScoreCount++;
  }
}

function summarizeAgent(agentName: string, rows: PerformanceRow[]): CandidateSummary {
  const firstRow = rows[0];
  const acc = makeAccumulator(firstRow ? firstRow.ts : "");

  for (const row of rows) {
    if (row.ts > acc.lastOutcomeAt) acc.lastOutcomeAt = row.ts;
    const bucket = rowOutcomeBucket(row);
    accumulateOutcome(acc, row, bucket);
    acc.outcomeScoreSum += rowOutcomeScore(row);
    accumulateRounds(acc, row);
    acc.smokeScoreSum += smokeValue(row.smoke_pass);
    accumulateLatencyAndExec(acc, row);
    accumulateReviewerAndScore(acc, row);
  }

  const samples = rows.length;
  const nonNeutral = acc.successes + acc.failures;
  return {
    agent_name: agentName,
    samples,
    successes: acc.successes,
    failures: acc.failures,
    neutral: acc.neutral,
    success_rate: nonNeutral > 0 ? acc.successes / nonNeutral : 0,
    avg_rounds: acc.roundsCount > 0 ? acc.roundsSum / acc.roundsCount : null,
    avg_latency_ms: acc.latencyCount > 0 ? acc.latencySum / acc.latencyCount : null,
    avg_exec_ms: winsorizedMean(acc.execMsValues),
    _latency_exec_ms: winsorizedMean(acc.trueExecMsValues),
    cost_per_success_usd:
      acc.successCostCount > 0 ? acc.successCostSum / acc.successCostCount : null,
    avg_reviewer_findings: acc.reviewerCount > 0 ? acc.reviewerSum / acc.reviewerCount : null,
    avg_trust_score: acc.trustScoreCount > 0 ? acc.trustScoreSum / acc.trustScoreCount : null,
    gate_verdict_count: acc.gateVerdictCount,
    gate_pass_count: acc.gatePassCount,
    last_outcome_at: acc.lastOutcomeAt,
    _outcome_score: acc.outcomeScoreSum / samples,
    _rounds_score: acc.roundsScoreSum / samples,
    _smoke_score: acc.smokeScoreSum / samples,
    _reviewer_score: acc.reviewerScoreSum / samples,
    _maestro_score: acc.maestroScoreSum / samples,
  };
}

function scoreCandidate(
  c: CandidateSummary,
  opts: {
    includeCost: boolean;
    minCost: number | null;
    maxCost: number | null;
    latencyWeighting?: boolean;
    minExecMs?: number | null;
    maxExecMs?: number | null;
  },
): number {
  // Flag-gated latency term. Keys on winsorized true execution time,
  // NEVER queue-inflated latency_ms. Only applies above the min-success floor so
  // speed can't rescue a chronically-failing agent, and outcome weight stays
  // >= 0.28 in every branch (the latency term is carved from the lower-signal
  // weights, not from outcome).
  const minExec = typeof opts.minExecMs === "number" ? opts.minExecMs : null;
  const maxExec = typeof opts.maxExecMs === "number" ? opts.maxExecMs : null;
  const latencyExec = c._latency_exec_ms;
  const latencyActive =
    opts.latencyWeighting === true &&
    latencyExec !== null &&
    minExec !== null &&
    maxExec !== null &&
    c.success_rate >= LATENCY_MIN_SUCCESS_FLOOR;
  let latency_score = 0;
  if (latencyActive) {
    if (maxExec === minExec) {
      latency_score = 1;
    } else {
      latency_score = clamp01((maxExec - latencyExec) / (maxExec - minExec));
    }
  }

  const cost_score = opts.includeCost ? computeCostScore(c, opts) : 0;
  const raw = combineScoreWeights(c, {
    latencyActive,
    includeCost: opts.includeCost,
    cost_score,
    latency_score,
  });
  return clamp01(Math.round(raw * 10000) / 10000);
}

function computeCostScore(
  c: CandidateSummary,
  opts: { minCost: number | null; maxCost: number | null },
): number {
  if (c.cost_per_success_usd === null || opts.minCost === null || opts.maxCost === null) {
    return 0.5;
  }
  if (opts.maxCost === opts.minCost) return 1;
  return clamp01((opts.maxCost - c.cost_per_success_usd) / (opts.maxCost - opts.minCost));
}

function combineScoreWeights(
  c: CandidateSummary,
  opts: {
    latencyActive: boolean;
    includeCost: boolean;
    cost_score: number;
    latency_score: number;
  },
): number {
  if (opts.includeCost) {
    if (opts.latencyActive) {
      return (
        0.28 * c._outcome_score +
        0.18 * c._rounds_score +
        0.17 * c._smoke_score +
        0.12 * c._reviewer_score +
        0.08 * c._maestro_score +
        0.07 * opts.cost_score +
        0.1 * opts.latency_score
      );
    }
    return (
      0.3 * c._outcome_score +
      0.2 * c._rounds_score +
      0.2 * c._smoke_score +
      0.15 * c._reviewer_score +
      0.1 * c._maestro_score +
      0.05 * opts.cost_score
    );
  }
  if (opts.latencyActive) {
    return (
      0.3 * c._outcome_score +
      0.18 * c._rounds_score +
      0.18 * c._smoke_score +
      0.14 * c._reviewer_score +
      0.1 * c._maestro_score +
      0.1 * opts.latency_score
    );
  }
  return (
    0.32 * c._outcome_score +
    0.22 * c._rounds_score +
    0.22 * c._smoke_score +
    0.16 * c._reviewer_score +
    0.08 * c._maestro_score
  );
}

function resolveProvider(
  agent: NonNullable<AgentRouteAgentchatConfig["agents"]>[number],
): string | null {
  if (agent.pricing_mode === "subscription") return agent.subscription_provider ?? null;
  return agent.api_provider ?? agent.subscription_provider ?? null;
}

// Positive config-membership allowlist (F7). Returns the set of agent_names
// that may enter the ranked pool, or null when no live registry/config is
// reachable (config-less test paths and a brief config-reload race must NOT
// be empty-set'd — the caller skips filtering in the null case).
//
// Sources, preferring the most authoritative:
//   1. input.agentRegistry — the explicit list passed by daemon callers.
//   2. input.agentchatConfig.agents[].name — derived from the agentchat config.
//
// Do NOT key the exclusion on provider===null: a legitimate local/free seat
// can have no provider and still belong in the pool. The registry presence
// IS the signal that this is a real, currently-routable agent name.
function getConfigMembershipAllowlist(input: RouteAgentInput): Set<string> | null {
  if (input.agentRegistry && input.agentRegistry.length > 0) {
    return new Set(input.agentRegistry);
  }
  const cfgAgents = input.agentchatConfig?.agents;
  if (cfgAgents && cfgAgents.length > 0) {
    return new Set(cfgAgents.map((agent) => agent.name));
  }
  return null;
}

// Fail-OPEN stale-key set for pressure snapshots. Keys are triples of
// (provider, window_label, model) — matching the reader's snapshot grouping
// key exactly, so a stale per-model warning does NOT mask a fresh global
// (model=null) snapshot and vice versa. Callers that pass no warnings behave
// as though nothing is stale (byte-identical to pre-fix behavior).
function buildPressureStaleKeys(
  pressureSnapshot: RouteAgentInput["applyPressure"] | undefined,
): Set<string> {
  if (!pressureSnapshot?.warnings || pressureSnapshot.warnings.length === 0) {
    return new Set();
  }
  return new Set(
    pressureSnapshot.warnings.map((w) => `${w.provider} ${w.window_label} ${w.model ?? ""}`),
  );
}

function pressureSnapshotKey(snapshot: {
  provider: string;
  window_label: string;
  model: string | null;
}): string {
  return `${snapshot.provider} ${snapshot.window_label} ${snapshot.model ?? ""}`;
}

function isOverPressure(
  provider: string,
  pressureSnapshot?: RouteAgentInput["applyPressure"],
): boolean {
  if (!pressureSnapshot) return false;
  const staleKeys = buildPressureStaleKeys(pressureSnapshot);
  // Fail OPEN: stale snapshots must NOT throttle. A snapshot whose
  // (provider, window_label, model) key is in the stale set is dropped from
  // the exclusion check. If every snapshot for a provider is stale, the
  // provider is treated as not-over-pressure.
  return pressureSnapshot.snapshots.some((snapshot) => {
    if (snapshot.provider !== provider) return false;
    if (staleKeys.has(pressureSnapshotKey(snapshot))) return false;
    return snapshot.used_pct >= 90 || snapshot.source_kind === "cooldown";
  });
}

// User-driven routing-bias ("usage steering") effect for one candidate.
// Default weights apply when a bias omits one: boost raises a candidate's score,
// divert lowers it. Precedence is exclude > divert > boost — an exclude removes
// the candidate outright (subject to the caller's safe-fallback re-admission),
// while boost/divert weights multiply cumulatively into a single factor. A
// candidate matches a bias by exact agent name (scope=agent) or by its resolved
// provider (scope=provider). Matching is strict equality with NO normalization
// — the silent-failure-retry selector mirrors this byte-for-byte, so normalizing
// one side would drift them apart. The canonical-provider invariant that makes
// strict `===` correct is enforced at the write boundaries (config load +
// routing_bias_set); see @penumbra/config provider-format.
const DEFAULT_BOOST_WEIGHT = 1.25;
const DEFAULT_DIVERT_WEIGHT = 0.5;

function resolveBiasEffect(
  agentName: string,
  provider: string | null,
  biases: RoutingBias[] | undefined,
): { factor: number; exclude: boolean } {
  if (!biases || biases.length === 0) return { factor: 1, exclude: false };
  let factor = 1;
  let exclude = false;
  for (const bias of biases) {
    const matches =
      (bias.scope === "agent" && bias.value === agentName) ||
      (bias.scope === "provider" && provider !== null && bias.value === provider);
    if (!matches) continue;
    if (bias.mode === "exclude") {
      exclude = true;
    } else if (bias.mode === "divert") {
      factor *= bias.weight ?? DEFAULT_DIVERT_WEIGHT;
    } else {
      factor *= bias.weight ?? DEFAULT_BOOST_WEIGHT;
    }
  }
  return { factor, exclude };
}

function getAllowedAgents(input: RouteAgentInput): string[] | null {
  const role = input.role;
  const roleAgents =
    role && input.agentchatConfig?.agents
      ? input.agentchatConfig.agents
          .filter((agent) => agent.roles.includes(role))
          .map((agent) => agent.name)
      : null;
  const registryAgents = input.agentRegistry ?? null;

  let allowed: string[] | null;
  if (roleAgents === null && registryAgents === null) {
    allowed = null;
  } else if (roleAgents === null) {
    allowed = registryAgents;
  } else if (registryAgents === null) {
    allowed = roleAgents;
  } else {
    const registrySet = new Set(registryAgents);
    allowed = roleAgents.filter((name) => registrySet.has(name));
  }
  if (!input.unhealthyAgents || input.unhealthyAgents.size === 0 || allowed === null) {
    return allowed;
  }
  return allowed.filter((name) => !input.unhealthyAgents?.has(name));
}

function queryRows(
  db: Database,
  taskType: string,
  agentKind: string,
  sinceIso: string,
  allowedAgents: string[] | null,
): PerformanceRow[] {
  const rows = db
    .query<PerformanceRow, [string, string, string]>(
      `SELECT agent_name, task_type, outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, latency_ms, exec_ms, framework_overhead_ms, ts, agent_kind, gate_outcome, failure_class, trust_score
     FROM agent_performance
     WHERE task_type = ? AND ts >= ? AND COALESCE(agent_kind, '${DEFAULT_AGENT_KIND}') = ?
     ORDER BY ts DESC`,
    )
    .all(taskType, sinceIso, agentKind);
  const filteredRows = rows.filter((row) => !isClassifierDeclineExempt(row));
  return allowedAgents === null
    ? filteredRows
    : filteredRows.filter((row) => allowedAgents.includes(row.agent_name));
}

function applyPressureFactor(
  score: number,
  summary: CandidateSummary,
  input: RouteAgentInput,
): number {
  if (!input.agentchatConfig?.role_routing?.headroom_weighting || !input.applyPressure) {
    return score;
  }
  const agentConf = input.agentchatConfig.agents.find((a) => a.name === summary.agent_name);
  const provider = agentConf ? resolveProvider(agentConf) : null;
  if (!provider) return score;
  // Fail OPEN: drop stale snapshots (keyed on provider+window_label+model)
  // before averaging used_pct. If every snapshot for this provider is stale,
  // apply no penalty at all — a stale >=90% must never scale a score down
  // indefinitely.
  const staleKeys = buildPressureStaleKeys(input.applyPressure);
  const snaps = input.applyPressure.snapshots.filter(
    (snap) => snap.provider === provider && !staleKeys.has(pressureSnapshotKey(snap)),
  );
  if (snaps.length === 0) return score;
  const maxUsedPct = Math.max(...snaps.map((snap) => snap.used_pct));
  const factor = clamp01(1 - maxUsedPct / 100);
  return clamp01(Math.round(score * factor * 10000) / 10000);
}

function applyWarmPoolFactor(
  score: number,
  summary: CandidateSummary,
  input: RouteAgentInput,
): number {
  if (
    !input.agentchatConfig?.role_routing?.warm_pool_reuse_weighting ||
    !input.warmPoolReuseRates
  ) {
    return score;
  }
  const reuseRate = input.warmPoolReuseRates[summary.agent_name];
  if (reuseRate === undefined) return score;
  const clampedRate = Math.max(0, Math.min(1, reuseRate));
  const reuseFactor = 1 + WARM_POOL_REUSE_MAX_BOOST * clampedRate;
  return clamp01(Math.round(score * reuseFactor * 10000) / 10000);
}

// Adapter is "ACP-shaped" when its identifier contains "acp" — covers
// stdio-acp, claude-acp, claude-acp-fallback, codex-acp, opencode-acp, etc.
// Substring match is correct: HTTP adapters never include "acp" in their name
// (openai-compat-http, anthropic-http, etc.). Lowercased to be tolerant of
// config-source casing without normalizing the stored value.
function isAcpAdapter(adapter: string | undefined): boolean {
  if (!adapter) return false;
  return adapter.toLowerCase().includes("acp");
}

function applyToolFreeFactor(
  score: number,
  summary: CandidateSummary,
  input: RouteAgentInput,
): number {
  // Early return MUST be the unset/false path — guarantees byte-identical
  // behavior for callers that never opt in.
  if (input.tool_free !== true) return score;
  const agentConf = input.agentchatConfig?.agents.find((a) => a.name === summary.agent_name);
  if (!agentConf || !isAcpAdapter(agentConf.adapter)) return score;
  return clamp01(Math.round(score * TOOL_FREE_ACP_PENALTY * 10000) / 10000);
}

function applyBiasFactor(
  score: number,
  summary: CandidateSummary,
  input: RouteAgentInput,
): { score: number; biasExclude: boolean } {
  if (!input.activeBiases || input.activeBiases.length === 0) {
    return { score, biasExclude: false };
  }
  const agentConf = input.agentchatConfig?.agents.find((a) => a.name === summary.agent_name);
  const provider = agentConf ? resolveProvider(agentConf) : null;
  const effect = resolveBiasEffect(summary.agent_name, provider, input.activeBiases);
  if (effect.exclude) return { score, biasExclude: true };
  if (effect.factor !== 1) {
    return {
      score: clamp01(Math.round(score * effect.factor * 10000) / 10000),
      biasExclude: false,
    };
  }
  return { score, biasExclude: false };
}

function summaryToCandidate(
  summary: CandidateSummary,
  score: number,
): AgentRankOutput["candidates"][number] {
  return {
    agent_name: summary.agent_name,
    samples: summary.samples,
    successes: summary.successes,
    failures: summary.failures,
    neutral: summary.neutral,
    success_rate: summary.success_rate,
    avg_rounds: summary.avg_rounds,
    avg_latency_ms: summary.avg_latency_ms,
    avg_exec_ms: summary.avg_exec_ms,
    cost_per_success_usd: summary.cost_per_success_usd,
    avg_reviewer_findings: summary.avg_reviewer_findings,
    avg_trust_score: summary.avg_trust_score,
    gate_verdict_coverage: summary.samples > 0 ? summary.gate_verdict_count / summary.samples : 0,
    gate_pass_rate:
      summary.gate_verdict_count > 0 ? summary.gate_pass_count / summary.gate_verdict_count : 0,
    last_outcome_at: summary.last_outcome_at,
    score,
  };
}

interface ScoreContext {
  input: RouteAgentInput;
  minCost: number | null;
  maxCost: number | null;
  latencyWeighting: boolean;
  minExecMs: number | null;
  maxExecMs: number | null;
}

function rankSummary(
  summary: CandidateSummary,
  ctx: ScoreContext,
): { candidate: AgentRankOutput["candidates"][number]; biasExclude: boolean } {
  let score = scoreCandidate(summary, {
    includeCost: ctx.input.includeCost ?? false,
    minCost: ctx.minCost,
    maxCost: ctx.maxCost,
    latencyWeighting: ctx.latencyWeighting,
    minExecMs: ctx.minExecMs,
    maxExecMs: ctx.maxExecMs,
  });
  score = applyPressureFactor(score, summary, ctx.input);
  score = applyWarmPoolFactor(score, summary, ctx.input);
  score = applyToolFreeFactor(score, summary, ctx.input);
  const biased = applyBiasFactor(score, summary, ctx.input);
  return { candidate: summaryToCandidate(summary, biased.score), biasExclude: biased.biasExclude };
}

function groupRowsByAgent(rows: PerformanceRow[]): Map<string, PerformanceRow[]> {
  const byAgent = new Map<string, PerformanceRow[]>();
  for (const row of rows) {
    const list = byAgent.get(row.agent_name) ?? [];
    list.push(row);
    byAgent.set(row.agent_name, list);
  }
  return byAgent;
}

function computeExecMsRange(
  summaries: CandidateSummary[],
  latencyWeighting: boolean,
): { minExecMs: number | null; maxExecMs: number | null } {
  if (!latencyWeighting) return { minExecMs: null, maxExecMs: null };
  const execMsRange = summaries
    .filter(
      (s): s is CandidateSummary & { _latency_exec_ms: number } =>
        s.success_rate >= LATENCY_MIN_SUCCESS_FLOOR && s._latency_exec_ms !== null,
    )
    .map((s) => s._latency_exec_ms);
  if (execMsRange.length === 0) return { minExecMs: null, maxExecMs: null };
  return { minExecMs: Math.min(...execMsRange), maxExecMs: Math.max(...execMsRange) };
}

function buildRank(
  db: Database,
  input: RouteAgentInput,
  taskType: AgentTaskType,
  allowedAgents: string[] | null,
): AgentRankOutput {
  const now = input.now ?? new Date();
  const agentKind = input.agentKind ?? DEFAULT_AGENT_KIND;
  const sinceIso =
    input.since !== undefined
      ? new Date(input.since).toISOString()
      : new Date(now.getTime() - DEFAULT_RANK_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = queryRows(db, taskType, agentKind, sinceIso, allowedAgents);
  const unhealthyAgents = input.unhealthyAgents ?? new Set<string>();
  const visibleRows = input.includeNeutral
    ? rows
    : rows.filter((row) => rowOutcomeBucket(row) !== "neutral");
  const byAgent = groupRowsByAgent(visibleRows);
  // F7: positive config-membership allowlist (see buildRecommendations for
  // the full rationale). Mirrors the bias-exclude filter pattern below: when
  // a registry is present, drop phantom agent_names; when absent, behave
  // identically to today.
  const membership = getConfigMembershipAllowlist(input);
  const summaries = Array.from(byAgent.entries())
    .map(([agentName, agentRows]) => summarizeAgent(agentName, agentRows))
    .filter((c) => !unhealthyAgents.has(c.agent_name))
    .filter((c) => membership === null || membership.has(c.agent_name))
    .filter((c) => c.samples >= (input.minSamples ?? 1));
  const costs = input.includeCost
    ? summaries.map((s) => s.cost_per_success_usd).filter((v): v is number => v !== null)
    : [];
  const minCost = costs.length > 0 ? Math.min(...costs) : null;
  const maxCost = costs.length > 0 ? Math.max(...costs) : null;
  const latencyWeighting = input.agentchatConfig?.role_routing?.latency_weighting === true;
  // Normalize the latency_score over candidates ELIGIBLE for the latency term
  // (>= success floor, exec present) so a sub-floor fast agent can't compress
  // everyone else's range.
  const { minExecMs, maxExecMs } = computeExecMsRange(summaries, latencyWeighting);
  const hasBiases = !!input.activeBiases && input.activeBiases.length > 0;
  const ctx: ScoreContext = {
    input,
    minCost,
    maxCost,
    latencyWeighting,
    minExecMs,
    maxExecMs,
  };
  const ranked = summaries.map((s) => rankSummary(s, ctx));
  // Hard-prefer with safe fallback: drop exclude-steered candidates, but if that
  // would empty the ranking, re-admit them rather than return nothing.
  const kept = hasBiases ? ranked.filter((r) => !r.biasExclude) : ranked;
  const visible = kept.length > 0 ? kept : ranked;
  return {
    task_type: taskType,
    window: {
      from: sinceIso,
      to: now.toISOString(),
    },
    candidates: visible
      .map((r) => r.candidate)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.success_rate - a.success_rate ||
          (a.avg_latency_ms ?? Infinity) - (b.avg_latency_ms ?? Infinity) ||
          a.agent_name.localeCompare(b.agent_name),
      ),
  };
}

function buildRecommendations(
  db: Database,
  input: RouteAgentInput,
  taskType: string,
  allowedAgents: string[] | null,
): AgentRecommendation[] {
  const windowDays = input.windowDays ?? 7;
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const successPredicate = buildSuccessPredicate();
  const agentKind = input.agentKind ?? DEFAULT_AGENT_KIND;
  // riskClass is accepted on the input shape for forward-compat; not yet consumed by ranking.
  void input.riskClass;
  // Verdict contract (shared with the in-memory path in accumulateOutcome):
  // gate_verdict_count = COUNT(rows with gate_outcome IS NOT NULL). This
  // INCLUDES 'review_debt' as a verdict-bearing NON-pass: work that shipped
  // unreviewed past the review grace window is a real signal, not "never
  // attempted". gate_pass_count narrows that to GATE_OUTCOME_PASS_VALUES.
  // Do NOT exclude review_debt from the denominator — that would let timed-out
  // lanes look like never-attempted ones. Both this SQL aggregation and the
  // in-memory accumulator MUST stay in lockstep; the F4 denominator-parity
  // test in agent-routing.test.ts pins them together.
  const rows = db
    .query<
      {
        agent_name: string;
        task_type: string;
        samples: number;
        successes: number;
        gate_outcome_count: number;
        gate_pass_count: number;
        avg_latency_ms: number | null;
        last_observed_at: string;
      },
      {
        $taskType: string;
        $cutoff: string;
        $agentKind: string;
        $classifierDeclineCutover: string;
      }
    >(
      // Neutral outcomes (NEUTRAL_OUTCOME_VALUES) are excluded from the
      // summary aggregation so this path's denominator matches the in-memory
      // rank path's `nonNeutral = successes + failures`. Without this,
      // success_rate diverges between the two paths for the same data.
      `SELECT agent_name, task_type, COUNT(*) AS samples, SUM(CASE WHEN ${successPredicate.sql} THEN 1 ELSE 0 END) AS successes, SUM(CASE WHEN gate_outcome IS NOT NULL THEN 1 ELSE 0 END) AS gate_outcome_count, SUM(CASE WHEN gate_outcome IN (${sqlInList(GATE_OUTCOME_PASS_VALUES)}) THEN 1 ELSE 0 END) AS gate_pass_count, AVG(latency_ms) AS avg_latency_ms, MAX(ts) AS last_observed_at
     FROM agent_performance
     WHERE task_type = $taskType AND ts >= $cutoff AND COALESCE(agent_kind, '${DEFAULT_AGENT_KIND}') = $agentKind
       AND outcome NOT IN (${sqlInList(NEUTRAL_OUTCOME_VALUES)})
       AND (failure_class IS NULL OR failure_class != 'classifier_declined' OR ts < $classifierDeclineCutover)
     GROUP BY agent_name
     ORDER BY (CAST(SUM(CASE WHEN ${successPredicate.sql} THEN 1 ELSE 0 END) AS REAL) / COUNT(*)) DESC, (AVG(latency_ms) IS NULL) ASC, AVG(latency_ms) ASC`,
    )
    .all({
      $taskType: taskType,
      $cutoff: cutoff,
      $agentKind: agentKind,
      $classifierDeclineCutover: resolveClassifierDeclineCutoverIso(),
      ...successPredicate.params,
    });
  const allowedFiltered =
    allowedAgents === null ? rows : rows.filter((row) => allowedAgents.includes(row.agent_name));
  // F7: positive config-membership allowlist. The aggregation GROUP BY
  // agent_name lets phantom rows (parse artifacts, retired aliases,
  // provider-null tokens that bypass the pressure gate) into the ranked
  // pool. When a live agentchat registry is present, restrict ranking to
  // agent_names known to that registry. Guard on registry presence — the
  // config-less test paths (and the brief window of a config-reload race)
  // must NOT be empty-set'd. Do NOT key the exclusion on provider===null:
  // a legitimate local/free seat can have a null provider and still belong
  // in the pool.
  const membership = getConfigMembershipAllowlist(input);
  const filtered =
    membership === null
      ? allowedFiltered
      : allowedFiltered.filter((row) => membership.has(row.agent_name));
  return filtered.map((r) => ({
    agent_name: r.agent_name,
    task_type: r.task_type,
    samples: r.samples,
    success_rate: r.samples > 0 ? r.successes / r.samples : 0,
    gate_verdict_coverage: r.samples > 0 ? r.gate_outcome_count / r.samples : 0,
    gate_pass_rate: r.gate_outcome_count > 0 ? r.gate_pass_count / r.gate_outcome_count : 0,
    avg_latency_seconds: r.avg_latency_ms !== null ? r.avg_latency_ms / 1000 : null,
    last_observed_at: r.last_observed_at,
  }));
}

function chooseSingle(input: RouteAgentInput, allowedAgents: string[] | null): RoleRoute | null {
  if (!input.role || !input.agentchatConfig) return null;
  const roleAgents = allowedAgents ?? [];
  if (roleAgents.length === 0) return null;

  const taskType = input.taskType ?? inferAgentTaskTypeForRole(input.message ?? "", input.role);
  const ranked = buildRank(input.db, input, taskType, allowedAgents);
  const roleAgentSet = new Set(roleAgents);
  const sampledAgents = new Set(ranked.candidates.map((candidate) => candidate.agent_name));
  const defaultAgent = input.defaultRoles?.[input.role];
  const unsampledAlternate = roleAgents.find(
    (agent) => agent !== defaultAgent && !sampledAgents.has(agent),
  );
  const unsampledAgent = roleAgents.find((agent) => !sampledAgents.has(agent));
  const rankedAgent = ranked.candidates.find((candidate) => roleAgentSet.has(candidate.agent_name));

  const candidateOrder =
    input.roleExplorationPolicy === "ranked-first"
      ? [
          rankedAgent?.agent_name ?? null,
          defaultAgent ?? null,
          unsampledAlternate ?? null,
          unsampledAgent ?? null,
          roleAgents[0] ?? null,
        ]
      : [
          unsampledAlternate ?? null,
          unsampledAgent ?? null,
          rankedAgent?.agent_name ?? null,
          defaultAgent ?? null,
          roleAgents[0] ?? null,
        ];

  const hasBiases = !!input.activeBiases && input.activeBiases.length > 0;
  const isBiasExcluded = (agentName: string): boolean => {
    if (!hasBiases) return false;
    const agent = input.agentchatConfig?.agents.find((candidate) => candidate.name === agentName);
    const provider = agent ? resolveProvider(agent) : null;
    return resolveBiasEffect(agentName, provider, input.activeBiases).exclude;
  };
  const passesPressure = (agentName: string): boolean => {
    if (!input.applyPressure) return true;
    const agent = input.agentchatConfig?.agents.find((candidate) => candidate.name === agentName);
    const provider = agent ? resolveProvider(agent) : null;
    return !provider || !isOverPressure(provider, input.applyPressure);
  };
  const pick = (applyBiasExclude: boolean): string | null =>
    candidateOrder.find((agentName): agentName is string => {
      if (!agentName || !roleAgentSet.has(agentName)) return false;
      if (applyBiasExclude && isBiasExcluded(agentName)) return false;
      return passesPressure(agentName);
    }) ?? null;

  // Hard-prefer with safe fallback: honor exclude steers first; if that leaves no
  // candidate, re-admit the excluded set rather than wedge the role.
  const filteredAgent = pick(true) ?? (hasBiases ? pick(false) : null);

  return filteredAgent ? { agent: filteredAgent, role: input.role, taskType } : null;
}

export function routeAgent(input: RouteAgentInput): RouteAgentOutput {
  const allowedAgents = getAllowedAgents(input);
  const taskType =
    input.taskType ??
    (input.role ? inferAgentTaskTypeForRole(input.message ?? "", input.role) : undefined);
  if (input.detail === "rank") {
    return {
      detail: "rank",
      candidates: buildRank(input.db, input, taskType ?? "unknown", allowedAgents),
    };
  }
  if (input.detail === "summary") {
    return {
      detail: "summary",
      recommendations: buildRecommendations(input.db, input, taskType ?? "unknown", allowedAgents),
    };
  }
  return { detail: "single", route: chooseSingle(input, allowedAgents) };
}

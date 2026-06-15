import type { Database } from "bun:sqlite";
import {
  DEFAULT_AGENT_KIND,
  inferAgentTaskTypeForRole,
  type AgentKind,
  type AgentRankOutput,
  type AgentTaskType,
} from "../schemas/agent-performance.js";
import type { RoutingBias } from "../readers/routing-bias.js";

type AgentRoutePressureSnapshot = {
  snapshots: Array<{
    provider: string;
    window_label: string;
    model: string | null;
    used_pct: number;
    resets_at: number | null;
    observed_at: string;
    source_kind: string;
  }>;
  warnings?: unknown[];
};

type AgentRouteAgentchatConfig = {
  agents: Array<{
    name: string;
    roles: string[];
    subscription_provider?: string;
    api_provider?: string;
    pricing_mode?: "api" | "subscription";
  }>;
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
  applyPressure?: {
    snapshots: AgentRoutePressureSnapshot["snapshots"];
    warnings?: unknown[];
  };
  // User-driven routing-bias steers (usage steering). Injected by the caller
  // (daemon reads readRoutingBiases); the scorer never reads the DB itself.
  activeBiases?: RoutingBias[];
  // Per-agent ACP warm-pool session reuse rates from fleet-latency. Values in [0,1].
  // When warm_pool_reuse_weighting is enabled, agents with higher rates receive a
  // mild multiplicative score preference. Absent means no adjustment.
  warmPoolReuseRates?: Record<string, number>;
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
        `[agent-routing] PENUMBRA_GATE_OUTCOME_CUTOVER_ISO=${resolved} is earlier than default ${DEFAULT_GATE_OUTCOME_CUTOVER_ISO}; this relaxes the legacy NULL-verdict predicate.`,
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

// Single source for success eligibility. The SQL predicate
// (buildSuccessPredicate) and the in-memory checks (isSuccessOutcome,
// rowPassesGateOutcome) all derive from these arrays — change them here, never
// inline, or the two scoring paths diverge.
export const SUCCESS_OUTCOME_VALUES = [
  "merged",
  "pr_opened",
  "merged_with_concerns",
  "completed_with_output",
] as const;
export const GATE_OUTCOME_PASS_VALUES = ["passed", "skipped"] as const;

function sqlInList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(",");
}

// After auto-lane enforcement, NULL means the lane never produced a terminal
// gate verdict. `skipped` remains success-eligible because trivial/read-only
// work records a conscious "gate not run" decision instead of review debt.
// Trust boundary: the skipped-implies-TRIVIAL invariant is enforced at the
// gate layer (lanes routes: class-mismatch rejection, lane dedupe, and
// terminal-verdict protection), not here — scoring trusts gate_outcome as
// recorded. A lane deliberately closed skipped via override earns success
// credit; that is an audited operator decision visible in lane_ledger.
export function buildSuccessPredicate(): {
  sql: string;
  params: { $gateOutcomeCutover: string };
} {
  return {
    sql: `outcome IN (${sqlInList(SUCCESS_OUTCOME_VALUES)}) AND (gate_outcome IN (${sqlInList(GATE_OUTCOME_PASS_VALUES)}) OR (ts < $gateOutcomeCutover AND gate_outcome IS NULL))`,
    params: { $gateOutcomeCutover: resolveGateOutcomeCutoverIso() },
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
  const lo = sorted[k]!;
  const hi = sorted[n - 1 - k]!;
  let total = 0;
  for (const v of sorted) total += v < lo ? lo : v > hi ? hi : v;
  return total / n;
}

function isSuccessOutcome(outcome: string): boolean {
  return (SUCCESS_OUTCOME_VALUES as readonly string[]).includes(outcome);
}

// In-memory mirror of the gate clause in buildSuccessPredicate — both derive
// from GATE_OUTCOME_PASS_VALUES; keep them in lockstep. The string comparison
// is intentional because writers stamp canonical ISO-8601 UTC timestamps.
function rowPassesGateOutcome(row: PerformanceRow, gateOutcomeCutover: string): boolean {
  if (row.gate_outcome == null) return row.ts < gateOutcomeCutover;
  return (GATE_OUTCOME_PASS_VALUES as readonly string[]).includes(row.gate_outcome);
}

function isClassifierDeclineExempt(row: Pick<PerformanceRow, "failure_class" | "ts">): boolean {
  return (
    row.failure_class === "classifier_declined" && row.ts >= resolveClassifierDeclineCutoverIso()
  );
}

function rowOutcomeScore(row: PerformanceRow, gateOutcomeCutover: string): number {
  if (isSuccessOutcome(row.outcome) && !rowPassesGateOutcome(row, gateOutcomeCutover)) {
    return row.ts >= gateOutcomeCutover ? -1 : 0;
  }
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

function rowOutcomeBucket(
  row: PerformanceRow,
  gateOutcomeCutover: string,
): "success" | "failure" | "neutral" {
  switch (row.outcome) {
    case "merged":
    case "pr_opened":
    case "merged_with_concerns":
    case "completed_with_output":
      return rowPassesGateOutcome(row, gateOutcomeCutover) ? "success" : "failure";
    case "partial":
    case "rejected":
    case "failed":
    case "typecheck_failed":
    case "test_failed":
    case "pr_creation_failed":
      return "failure";
    case "no_changes":
    case "bypassed":
      return "neutral";
    default:
      return "failure";
  }
}

function smokeValue(smoke: string | null): number {
  if (smoke === "y") return 1;
  if (smoke === "partial") return 0.5;
  if (smoke === "n/a") return 0.5;
  if (smoke === "n") return 0;
  return 0.5;
}

function summarizeAgent(
  agentName: string,
  rows: PerformanceRow[],
  gateOutcomeCutover: string,
): CandidateSummary {
  let successes = 0;
  let failures = 0;
  let neutral = 0;
  let roundsSum = 0;
  let roundsCount = 0;
  let latencySum = 0;
  let latencyCount = 0;
  const execMsValues: number[] = [];
  const trueExecMsValues: number[] = [];
  let successCostSum = 0;
  let successCostCount = 0;
  let reviewerSum = 0;
  let reviewerCount = 0;
  let trustScoreSum = 0;
  let trustScoreCount = 0;
  let gateVerdictCount = 0;
  let gatePassCount = 0;
  let outcomeScoreSum = 0;
  let roundsScoreSum = 0;
  let smokeScoreSum = 0;
  let reviewerScoreSum = 0;
  let maestroScoreSum = 0;
  let lastOutcomeAt = rows[0]!.ts;

  for (const row of rows) {
    if (row.ts > lastOutcomeAt) lastOutcomeAt = row.ts;
    const outcomeBucketValue = rowOutcomeBucket(row, gateOutcomeCutover);
    if (outcomeBucketValue === "success") successes++;
    else if (outcomeBucketValue === "neutral") neutral++;
    else failures++;

    if (row.gate_outcome != null) {
      gateVerdictCount++;
      if ((GATE_OUTCOME_PASS_VALUES as readonly string[]).includes(row.gate_outcome))
        gatePassCount++;
    }

    outcomeScoreSum += rowOutcomeScore(row, gateOutcomeCutover);

    if (outcomeBucketValue === "success" && row.cost_usd != null) {
      successCostSum += row.cost_usd;
      successCostCount++;
    }

    if (row.rounds != null) {
      roundsSum += row.rounds;
      roundsCount++;
      roundsScoreSum += clamp01(1 / row.rounds);
    } else {
      roundsScoreSum += 0.5;
    }

    smokeScoreSum += smokeValue(row.smoke_pass);

    if (row.latency_ms != null) {
      latencySum += row.latency_ms;
      latencyCount++;
    }

    if (row.exec_ms != null) {
      execMsValues.push(row.exec_ms);
      trueExecMsValues.push(Math.max(0, row.exec_ms - (row.framework_overhead_ms ?? 0)));
    }

    if (row.reviewer_findings != null) {
      reviewerSum += row.reviewer_findings;
      reviewerCount++;
      reviewerScoreSum += clamp01(1 - Math.min(row.reviewer_findings, 10) / 10);
    } else {
      reviewerScoreSum += 0.5;
    }

    maestroScoreSum += row.maestro_score != null ? clamp01(row.maestro_score / 5) : 0.5;

    if (row.trust_score != null) {
      trustScoreSum += row.trust_score;
      trustScoreCount++;
    }
  }

  const samples = rows.length;
  const nonNeutral = successes + failures;
  const success_rate = nonNeutral > 0 ? successes / nonNeutral : 0;
  const avg_rounds = roundsCount > 0 ? roundsSum / roundsCount : null;
  const avg_latency_ms = latencyCount > 0 ? latencySum / latencyCount : null;
  const avg_exec_ms = winsorizedMean(execMsValues);
  const _latency_exec_ms = winsorizedMean(trueExecMsValues);
  const cost_per_success_usd = successCostCount > 0 ? successCostSum / successCostCount : null;
  const avgReviewerFindings = reviewerCount > 0 ? reviewerSum / reviewerCount : null;
  const avg_reviewer_findings = avgReviewerFindings;
  const avg_trust_score = trustScoreCount > 0 ? trustScoreSum / trustScoreCount : null;

  return {
    agent_name: agentName,
    samples,
    successes,
    failures,
    neutral,
    success_rate,
    avg_rounds,
    avg_latency_ms,
    avg_exec_ms,
    _latency_exec_ms,
    cost_per_success_usd,
    avg_reviewer_findings,
    avg_trust_score,
    gate_verdict_count: gateVerdictCount,
    gate_pass_count: gatePassCount,
    last_outcome_at: lastOutcomeAt,
    _outcome_score: outcomeScoreSum / samples,
    _rounds_score: roundsScoreSum / samples,
    _smoke_score: smokeScoreSum / samples,
    _reviewer_score: reviewerScoreSum / samples,
    _maestro_score: maestroScoreSum / samples,
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
  const latencyActive =
    opts.latencyWeighting === true &&
    c._latency_exec_ms != null &&
    opts.minExecMs != null &&
    opts.maxExecMs != null &&
    c.success_rate >= LATENCY_MIN_SUCCESS_FLOOR;
  const latency_score = !latencyActive
    ? 0
    : opts.maxExecMs === opts.minExecMs
      ? 1
      : clamp01((opts.maxExecMs! - c._latency_exec_ms!) / (opts.maxExecMs! - opts.minExecMs!));

  let raw: number;
  if (opts.includeCost) {
    let cost_score: number;
    if (c.cost_per_success_usd == null || opts.minCost == null || opts.maxCost == null) {
      cost_score = 0.5;
    } else if (opts.maxCost === opts.minCost) {
      cost_score = 1;
    } else {
      cost_score = clamp01((opts.maxCost - c.cost_per_success_usd) / (opts.maxCost - opts.minCost));
    }
    raw = latencyActive
      ? 0.28 * c._outcome_score +
        0.18 * c._rounds_score +
        0.17 * c._smoke_score +
        0.12 * c._reviewer_score +
        0.08 * c._maestro_score +
        0.07 * cost_score +
        0.1 * latency_score
      : 0.3 * c._outcome_score +
        0.2 * c._rounds_score +
        0.2 * c._smoke_score +
        0.15 * c._reviewer_score +
        0.1 * c._maestro_score +
        0.05 * cost_score;
  } else {
    raw = latencyActive
      ? 0.3 * c._outcome_score +
        0.18 * c._rounds_score +
        0.18 * c._smoke_score +
        0.14 * c._reviewer_score +
        0.1 * c._maestro_score +
        0.1 * latency_score
      : 0.32 * c._outcome_score +
        0.22 * c._rounds_score +
        0.22 * c._smoke_score +
        0.16 * c._reviewer_score +
        0.08 * c._maestro_score;
  }
  return clamp01(Math.round(raw * 10000) / 10000);
}

function resolveProvider(
  agent: NonNullable<AgentRouteAgentchatConfig["agents"]>[number],
): string | null {
  if (agent.pricing_mode === "subscription") return agent.subscription_provider ?? null;
  return agent.api_provider ?? agent.subscription_provider ?? null;
}

function isOverPressure(
  provider: string,
  pressureSnapshot?: RouteAgentInput["applyPressure"],
): boolean {
  if (!pressureSnapshot) return false;
  return pressureSnapshot.snapshots.some(
    (snapshot) =>
      snapshot.provider === provider &&
      (snapshot.used_pct >= 0.9 || snapshot.source_kind === "cooldown"),
  );
}

// User-driven routing-bias ("usage steering") effect for one candidate.
// Default weights apply when a bias omits one: boost raises a candidate's score,
// divert lowers it. Precedence is exclude > divert > boost — an exclude removes
// the candidate outright (subject to the caller's safe-fallback re-admission),
// while boost/divert weights multiply cumulatively into a single factor. A
// candidate matches a bias by exact agent name (scope=agent) or by its resolved
// provider (scope=provider).
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
      (bias.scope === "provider" && provider != null && bias.value === provider);
    if (!matches) continue;
    if (bias.mode === "exclude") {
      exclude = true;
    } else if (bias.mode === "divert") {
      factor *= bias.weight ?? DEFAULT_DIVERT_WEIGHT;
    } else if (bias.mode === "boost") {
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
  const registryAgents = input.agentRegistry ? input.agentRegistry : null;

  if (roleAgents == null && registryAgents == null) return null;
  if (roleAgents == null) return registryAgents;
  if (registryAgents == null) return roleAgents;
  const registrySet = new Set(registryAgents);
  return roleAgents.filter((name) => registrySet.has(name));
}

function queryRows(
  db: Database,
  taskType: string,
  agentKind: string,
  allowedAgents: string[] | null,
): PerformanceRow[] {
  const rows = db
    .query<PerformanceRow, [string, string]>(
      `SELECT agent_name, task_type, outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, latency_ms, exec_ms, framework_overhead_ms, ts, agent_kind, gate_outcome, failure_class, trust_score
     FROM agent_performance
     WHERE task_type = ? AND COALESCE(agent_kind, '${DEFAULT_AGENT_KIND}') = ?
     ORDER BY ts DESC`,
    )
    .all(taskType, agentKind);
  const filteredRows = rows.filter((row) => !isClassifierDeclineExempt(row));
  return allowedAgents == null
    ? filteredRows
    : filteredRows.filter((row) => allowedAgents.includes(row.agent_name));
}

function buildRank(
  db: Database,
  input: RouteAgentInput,
  taskType: AgentTaskType,
  allowedAgents: string[] | null,
): AgentRankOutput {
  const now = input.now ?? new Date();
  const agentKind = input.agentKind ?? DEFAULT_AGENT_KIND;
  const rows = queryRows(db, taskType, agentKind, allowedAgents).filter((row) =>
    input.since ? row.ts >= new Date(input.since).toISOString() : true,
  );
  const gateOutcomeCutover = resolveGateOutcomeCutoverIso();
  const visibleRows = input.includeNeutral
    ? rows
    : rows.filter((row) => rowOutcomeBucket(row, gateOutcomeCutover) !== "neutral");
  const byAgent = new Map<string, PerformanceRow[]>();
  for (const row of visibleRows) {
    const list = byAgent.get(row.agent_name) ?? [];
    list.push(row);
    byAgent.set(row.agent_name, list);
  }
  const summaries = Array.from(byAgent.entries())
    .map(([agentName, agentRows]) => summarizeAgent(agentName, agentRows, gateOutcomeCutover))
    .filter((c) => c.samples >= (input.minSamples ?? 1));
  const costs = input.includeCost
    ? summaries.map((s) => s.cost_per_success_usd).filter((v): v is number => v != null)
    : [];
  const minCost = costs.length > 0 ? Math.min(...costs) : null;
  const maxCost = costs.length > 0 ? Math.max(...costs) : null;
  const latencyWeighting = input.agentchatConfig?.role_routing?.latency_weighting === true;
  // Normalize the latency_score over candidates ELIGIBLE for the latency term
  // (>= success floor, exec present) so a sub-floor fast agent can't compress
  // everyone else's range.
  const execMsRange = latencyWeighting
    ? summaries
        .filter((s) => s.success_rate >= LATENCY_MIN_SUCCESS_FLOOR && s._latency_exec_ms != null)
        .map((s) => s._latency_exec_ms as number)
    : [];
  const minExecMs = execMsRange.length > 0 ? Math.min(...execMsRange) : null;
  const maxExecMs = execMsRange.length > 0 ? Math.max(...execMsRange) : null;
  const hasBiases = !!input.activeBiases && input.activeBiases.length > 0;
  const ranked = summaries.map((s) => {
    let score = scoreCandidate(s, {
      includeCost: input.includeCost ?? false,
      minCost,
      maxCost,
      latencyWeighting,
      minExecMs,
      maxExecMs,
    });
    if (input.agentchatConfig?.role_routing?.headroom_weighting && input.applyPressure) {
      const agentConf = input.agentchatConfig.agents.find((a) => a.name === s.agent_name);
      const provider = agentConf ? resolveProvider(agentConf) : null;
      if (provider) {
        const snaps = input.applyPressure.snapshots.filter((snap) => snap.provider === provider);
        if (snaps.length > 0) {
          const maxUsedPct = Math.max(...snaps.map((snap) => snap.used_pct));
          const factor = clamp01(1 - maxUsedPct);
          score = clamp01(Math.round(score * factor * 10000) / 10000);
        }
      }
    }
    // Warm-pool reuse preference (flag-gated, safe-fallback). Applies a mild
    // multiplicative lift (at most WARM_POOL_REUSE_MAX_BOOST = 5%) for agents
    // with higher ACP session reuse rates. When the flag is off or the signal is
    // absent for a candidate, the score is byte-identical to the unflagged path.
    if (
      input.agentchatConfig?.role_routing?.warm_pool_reuse_weighting &&
      input.warmPoolReuseRates
    ) {
      const reuseRate = input.warmPoolReuseRates[s.agent_name];
      if (reuseRate != null) {
        const clampedRate = Math.max(0, Math.min(1, reuseRate));
        const reuseFactor = 1 + WARM_POOL_REUSE_MAX_BOOST * clampedRate;
        score = clamp01(Math.round(score * reuseFactor * 10000) / 10000);
      }
    }
    // Usage-steering bias factor composes AFTER the pressure factor (single final clamp).
    let biasExclude = false;
    if (hasBiases) {
      const agentConf = input.agentchatConfig?.agents.find((a) => a.name === s.agent_name);
      const provider = agentConf ? resolveProvider(agentConf) : null;
      const effect = resolveBiasEffect(s.agent_name, provider, input.activeBiases);
      if (effect.exclude) {
        biasExclude = true;
      } else if (effect.factor !== 1) {
        score = clamp01(Math.round(score * effect.factor * 10000) / 10000);
      }
    }
    return {
      candidate: {
        agent_name: s.agent_name,
        samples: s.samples,
        successes: s.successes,
        failures: s.failures,
        neutral: s.neutral,
        success_rate: s.success_rate,
        avg_rounds: s.avg_rounds,
        avg_latency_ms: s.avg_latency_ms,
        avg_exec_ms: s.avg_exec_ms,
        cost_per_success_usd: s.cost_per_success_usd,
        avg_reviewer_findings: s.avg_reviewer_findings,
        avg_trust_score: s.avg_trust_score,
        gate_verdict_coverage: s.samples > 0 ? s.gate_verdict_count / s.samples : 0,
        gate_pass_rate: s.samples > 0 ? s.gate_pass_count / s.samples : 0,
        last_outcome_at: s.last_outcome_at,
        score,
      },
      biasExclude,
    };
  });
  // Hard-prefer with safe fallback: drop exclude-steered candidates, but if that
  // would empty the ranking, re-admit them rather than return nothing.
  const kept = hasBiases ? ranked.filter((r) => !r.biasExclude) : ranked;
  const visible = kept.length > 0 ? kept : ranked;
  return {
    task_type: taskType,
    window: {
      from: input.since ? new Date(input.since).toISOString() : null,
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
        $gateOutcomeCutover: string;
        $classifierDeclineCutover: string;
      }
    >(
      `SELECT agent_name, task_type, COUNT(*) AS samples, SUM(CASE WHEN ${successPredicate.sql} THEN 1 ELSE 0 END) AS successes, SUM(CASE WHEN gate_outcome IS NOT NULL THEN 1 ELSE 0 END) AS gate_outcome_count, SUM(CASE WHEN gate_outcome IN (${sqlInList(GATE_OUTCOME_PASS_VALUES)}) THEN 1 ELSE 0 END) AS gate_pass_count, AVG(latency_ms) AS avg_latency_ms, MAX(ts) AS last_observed_at
     FROM agent_performance
     WHERE task_type = $taskType AND ts >= $cutoff AND COALESCE(agent_kind, '${DEFAULT_AGENT_KIND}') = $agentKind
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
  const filtered =
    allowedAgents == null ? rows : rows.filter((row) => allowedAgents.includes(row.agent_name));
  return filtered.map((r) => ({
    agent_name: r.agent_name,
    task_type: r.task_type,
    samples: r.samples,
    success_rate: r.samples > 0 ? r.successes / r.samples : 0,
    gate_verdict_coverage: r.samples > 0 ? r.gate_outcome_count / r.samples : 0,
    gate_pass_rate: r.samples > 0 ? r.gate_pass_count / r.samples : 0,
    avg_latency_seconds: r.avg_latency_ms != null ? r.avg_latency_ms / 1000 : null,
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

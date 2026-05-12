import type { Database } from 'bun:sqlite';
import {
  DEFAULT_AGENT_KIND,
  inferAgentTaskTypeForRole,
  type AgentKind,
  type AgentRankOutput,
  type AgentTaskType,
} from '../schemas/agent-performance.js';
import type { AgentRecommendation } from '../readers/agent-recommend.js';

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
    pricing_mode?: 'api' | 'subscription';
  }>;
};

type DetailMode = 'rank' | 'summary' | 'single';

export type RoleRoute = {
  agent: string;
  role: string;
  taskType: AgentTaskType;
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
  roleExplorationPolicy?: 'unsampled-first' | 'ranked-first';
  defaultRoles?: Record<string, string>;
  agentRegistry?: string[] | null;
  applyPressure?: {
    snapshots: AgentRoutePressureSnapshot['snapshots'];
    warnings?: unknown[];
  };
  now?: Date;
}

export type RouteAgentOutput =
  | { detail: 'rank'; candidates: AgentRankOutput }
  | { detail: 'summary'; recommendations: AgentRecommendation[] }
  | { detail: 'single'; route: RoleRoute | null };

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
  ts: string;
  agent_kind: string | null;
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
  cost_per_success_usd: number | null;
  avg_reviewer_findings: number | null;
  avg_trust_score: number | null;
  last_outcome_at: string;
  _outcome_score: number;
  _rounds_score: number;
  _smoke_score: number;
  _reviewer_score: number;
  _maestro_score: number;
}

const SUCCESS_PREDICATE = `outcome IN ('merged','pr_opened','merged_with_concerns') AND (gate_outcome IS NULL OR gate_outcome = 'passed')`;

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function outcomeValue(outcome: string): number {
  switch (outcome) {
    case 'merged':
    case 'pr_opened':
      return 1;
    case 'merged_with_concerns':
      return 0.85;
    case 'partial':
      return 0.35;
    case 'rejected':
      return 0.2;
    case 'failed':
    case 'typecheck_failed':
    case 'test_failed':
    case 'pr_creation_failed':
      return 0;
    case 'no_changes':
    case 'bypassed':
      return 0.5;
    default:
      return 0;
  }
}

function outcomeBucket(outcome: string): 'success' | 'failure' | 'neutral' {
  switch (outcome) {
    case 'merged':
    case 'pr_opened':
    case 'merged_with_concerns':
      return 'success';
    case 'partial':
    case 'rejected':
    case 'failed':
    case 'typecheck_failed':
    case 'test_failed':
    case 'pr_creation_failed':
      return 'failure';
    case 'no_changes':
    case 'bypassed':
      return 'neutral';
    default:
      return 'failure';
  }
}

function smokeValue(smoke: string | null): number {
  if (smoke === 'y') return 1;
  if (smoke === 'partial') return 0.5;
  if (smoke === 'n/a') return 0.5;
  if (smoke === 'n') return 0;
  return 0.5;
}

function summarizeAgent(agentName: string, rows: PerformanceRow[]): CandidateSummary {
  let successes = 0;
  let failures = 0;
  let neutral = 0;
  let roundsSum = 0;
  let roundsCount = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let successCostSum = 0;
  let successCostCount = 0;
  let reviewerSum = 0;
  let reviewerCount = 0;
  let trustScoreSum = 0;
  let trustScoreCount = 0;
  let outcomeScoreSum = 0;
  let roundsScoreSum = 0;
  let smokeScoreSum = 0;
  let reviewerScoreSum = 0;
  let maestroScoreSum = 0;
  let lastOutcomeAt = rows[0]!.ts;

  for (const row of rows) {
    if (row.ts > lastOutcomeAt) lastOutcomeAt = row.ts;
    const outcomeBucketValue = outcomeBucket(row.outcome);
    if (outcomeBucketValue === 'success') successes++;
    else if (outcomeBucketValue === 'neutral') neutral++;
    else failures++;

    outcomeScoreSum += outcomeValue(row.outcome);

    if (outcomeBucketValue === 'success' && row.cost_usd != null) {
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
    cost_per_success_usd,
    avg_reviewer_findings,
    avg_trust_score,
    last_outcome_at: lastOutcomeAt,
    _outcome_score: outcomeScoreSum / samples,
    _rounds_score: roundsScoreSum / samples,
    _smoke_score: smokeScoreSum / samples,
    _reviewer_score: reviewerScoreSum / samples,
    _maestro_score: maestroScoreSum / samples,
  };
}

function scoreCandidate(c: CandidateSummary, opts: { includeCost: boolean; minCost: number | null; maxCost: number | null }): number {
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
    raw = 0.30 * c._outcome_score + 0.20 * c._rounds_score + 0.20 * c._smoke_score + 0.15 * c._reviewer_score + 0.10 * c._maestro_score + 0.05 * cost_score;
  } else {
    raw = 0.32 * c._outcome_score + 0.22 * c._rounds_score + 0.22 * c._smoke_score + 0.16 * c._reviewer_score + 0.08 * c._maestro_score;
  }
  return clamp01(Math.round(raw * 10000) / 10000);
}

function resolveProvider(agent: NonNullable<AgentRouteAgentchatConfig['agents']>[number]): string | null {
  if (agent.pricing_mode === 'subscription') return agent.subscription_provider ?? null;
  return agent.api_provider ?? agent.subscription_provider ?? null;
}

function isOverPressure(provider: string, pressureSnapshot?: RouteAgentInput['applyPressure']): boolean {
  if (!pressureSnapshot) return false;
  return pressureSnapshot.snapshots.some((snapshot) => snapshot.provider === provider && (snapshot.used_pct >= 0.9 || snapshot.source_kind === 'cooldown'));
}

function getAllowedAgents(input: RouteAgentInput): string[] | null {
  const role = input.role;
  const roleAgents = role && input.agentchatConfig?.agents
    ? input.agentchatConfig.agents.filter((agent) => agent.roles.includes(role)).map((agent) => agent.name)
    : null;
  const registryAgents = input.agentRegistry ? input.agentRegistry : null;

  if (roleAgents == null && registryAgents == null) return null;
  if (roleAgents == null) return registryAgents;
  if (registryAgents == null) return roleAgents;
  const registrySet = new Set(registryAgents);
  return roleAgents.filter((name) => registrySet.has(name));
}

function queryRows(db: Database, taskType: string, agentKind: string, allowedAgents: string[] | null): PerformanceRow[] {
  const rows = db.query<PerformanceRow, [string, string]>(
    `SELECT agent_name, task_type, outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd, latency_ms, ts, agent_kind, trust_score
     FROM agent_performance
     WHERE task_type = ? AND COALESCE(agent_kind, '${DEFAULT_AGENT_KIND}') = ?
     ORDER BY ts DESC`,
  ).all(taskType, agentKind);
  return allowedAgents == null ? rows : rows.filter((row) => allowedAgents.includes(row.agent_name));
}

function buildRank(db: Database, input: RouteAgentInput, taskType: AgentTaskType, allowedAgents: string[] | null): AgentRankOutput {
  const now = input.now ?? new Date();
  const agentKind = input.agentKind ?? DEFAULT_AGENT_KIND;
  const rows = queryRows(db, taskType, agentKind, allowedAgents).filter((row) => input.since ? row.ts >= new Date(input.since).toISOString() : true);
  const visibleRows = input.includeNeutral ? rows : rows.filter((row) => outcomeBucket(row.outcome) !== 'neutral');
  const byAgent = new Map<string, PerformanceRow[]>();
  for (const row of visibleRows) {
    const list = byAgent.get(row.agent_name) ?? [];
    list.push(row);
    byAgent.set(row.agent_name, list);
  }
  const summaries = Array.from(byAgent.entries())
    .map(([agentName, agentRows]) => summarizeAgent(agentName, agentRows))
    .filter((c) => c.samples >= (input.minSamples ?? 1));
  const costs = input.includeCost ? summaries.map((s) => s.cost_per_success_usd).filter((v): v is number => v != null) : [];
  const minCost = costs.length > 0 ? Math.min(...costs) : null;
  const maxCost = costs.length > 0 ? Math.max(...costs) : null;
  return {
    task_type: taskType,
    window: { from: input.since ? new Date(input.since).toISOString() : null, to: now.toISOString() },
    candidates: summaries
      .map((s) => ({
        agent_name: s.agent_name,
        samples: s.samples,
        successes: s.successes,
        failures: s.failures,
        neutral: s.neutral,
        success_rate: s.success_rate,
        avg_rounds: s.avg_rounds,
        avg_latency_ms: s.avg_latency_ms,
        cost_per_success_usd: s.cost_per_success_usd,
        avg_reviewer_findings: s.avg_reviewer_findings,
        avg_trust_score: s.avg_trust_score,
        last_outcome_at: s.last_outcome_at,
        score: scoreCandidate(s, { includeCost: input.includeCost ?? false, minCost, maxCost }),
      }))
      .sort((a, b) => b.score - a.score || b.success_rate - a.success_rate || a.agent_name.localeCompare(b.agent_name)),
  };
}

function buildRecommendations(db: Database, input: RouteAgentInput, taskType: string, allowedAgents: string[] | null): AgentRecommendation[] {
  const windowDays = input.windowDays ?? 7;
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const agentKind = input.agentKind ?? DEFAULT_AGENT_KIND;
  void input.riskClass;
  const rows = db.query<{ agent_name: string; task_type: string; samples: number; successes: number; avg_latency_ms: number | null; last_observed_at: string }, [string, string, string]>(
    `SELECT agent_name, task_type, COUNT(*) AS samples, SUM(CASE WHEN ${SUCCESS_PREDICATE} THEN 1 ELSE 0 END) AS successes, AVG(latency_ms) AS avg_latency_ms, MAX(ts) AS last_observed_at
     FROM agent_performance
     WHERE task_type = ? AND ts >= ? AND COALESCE(agent_kind, '${DEFAULT_AGENT_KIND}') = ?
     GROUP BY agent_name
     ORDER BY (CAST(SUM(CASE WHEN ${SUCCESS_PREDICATE} THEN 1 ELSE 0 END) AS REAL) / COUNT(*)) DESC, (AVG(latency_ms) IS NULL) ASC, AVG(latency_ms) ASC`,
  ).all(taskType, cutoff, agentKind);
  const filtered = allowedAgents == null ? rows : rows.filter((row) => allowedAgents.includes(row.agent_name));
  return filtered.map((r) => ({
    agent_name: r.agent_name,
    task_type: r.task_type,
    samples: r.samples,
    success_rate: r.samples > 0 ? r.successes / r.samples : 0,
    avg_latency_seconds: r.avg_latency_ms != null ? r.avg_latency_ms / 1000 : null,
    last_observed_at: r.last_observed_at,
  }));
}

function chooseSingle(input: RouteAgentInput, allowedAgents: string[] | null): RoleRoute | null {
  if (!input.role || !input.agentchatConfig) return null;
  const roleAgents = allowedAgents ?? [];
  if (roleAgents.length === 0) return null;

  const taskType = input.taskType ?? inferAgentTaskTypeForRole(input.message ?? '', input.role);
  const ranked = buildRank(input.db, input, taskType, allowedAgents);
  const roleAgentSet = new Set(roleAgents);
  const sampledAgents = new Set(ranked.candidates.map((candidate) => candidate.agent_name));
  const defaultAgent = input.defaultRoles?.[input.role];
  const unsampledAlternate = roleAgents.find((agent) => agent !== defaultAgent && !sampledAgents.has(agent));
  const unsampledAgent = roleAgents.find((agent) => !sampledAgents.has(agent));
  const rankedAgent = ranked.candidates.find((candidate) => roleAgentSet.has(candidate.agent_name));

  const candidateOrder = input.roleExplorationPolicy === 'ranked-first'
    ? [rankedAgent?.agent_name ?? null, defaultAgent ?? null, unsampledAlternate ?? null, unsampledAgent ?? null, roleAgents[0] ?? null]
    : [unsampledAlternate ?? null, unsampledAgent ?? null, rankedAgent?.agent_name ?? null, defaultAgent ?? null, roleAgents[0] ?? null];

  const filteredAgent = candidateOrder.find((agentName): agentName is string => {
    if (!agentName || !roleAgentSet.has(agentName)) return false;
    if (!input.applyPressure) return true;
    const agent = input.agentchatConfig?.agents.find((candidate) => candidate.name === agentName);
    const provider = agent ? resolveProvider(agent) : null;
    return !provider || !isOverPressure(provider, input.applyPressure);
  }) ?? null;

  return filteredAgent ? { agent: filteredAgent, role: input.role, taskType } : null;
}

export function routeAgent(input: RouteAgentInput): RouteAgentOutput {
  const allowedAgents = getAllowedAgents(input);
  const taskType = input.taskType ?? (input.role ? inferAgentTaskTypeForRole(input.message ?? '', input.role) : undefined);
  if (input.detail === 'rank') {
    return { detail: 'rank', candidates: buildRank(input.db, input, taskType ?? 'unknown', allowedAgents) };
  }
  if (input.detail === 'summary') {
    return { detail: 'summary', recommendations: buildRecommendations(input.db, input, taskType ?? 'unknown', allowedAgents) };
  }
  return { detail: 'single', route: chooseSingle(input, allowedAgents) };
}

import type { Database } from 'bun:sqlite';
import {
  AgentRankInputSchema,
  type AgentRankInput,
  type AgentRankOutput,
  type AgentPerformanceRow,
} from '../schemas/agent-performance.js';

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
  last_outcome_at: string;
  _outcome_score: number;
  _rounds_score: number;
  _smoke_score: number;
  _reviewer_score: number;
  _maestro_score: number;
}

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

function summarizeAgent(agentName: string, rows: AgentPerformanceRow[]): CandidateSummary {
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
  let outcomeScoreSum = 0;
  let roundsScoreSum = 0;
  let smokeScoreSum = 0;
  let reviewerScoreSum = 0;
  let maestroScoreSum = 0;
  let lastOutcomeAt = rows[0]!.ts;

  for (const row of rows) {
    if (row.ts > lastOutcomeAt) lastOutcomeAt = row.ts;
    const outcomeBucketValue = outcomeBucket(row.outcome);
    if (outcomeBucketValue === 'success') {
      successes++;
    } else if (outcomeBucketValue === 'neutral') {
      neutral++;
    } else {
      failures++;
    }

    outcomeScoreSum += outcomeValue(row.outcome);

    if (outcomeBucketValue === 'success') {
      if (row.cost_usd != null) {
        successCostSum += row.cost_usd;
        successCostCount++;
      }
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
  }

  const samples = rows.length;
  const nonNeutral = successes + failures;
  const success_rate = nonNeutral > 0 ? successes / nonNeutral : 0;
  const avg_rounds = roundsCount > 0 ? roundsSum / roundsCount : null;
  const avg_latency_ms = latencyCount > 0 ? latencySum / latencyCount : null;
  const cost_per_success_usd = successCostCount > 0 ? successCostSum / successCostCount : null;
  const avgReviewerFindings = reviewerCount > 0 ? reviewerSum / reviewerCount : null;
  const avg_reviewer_findings = avgReviewerFindings;

  const outcome_score = outcomeScoreSum / samples;
  const rounds_score = roundsScoreSum / samples;
  const smoke_score = smokeScoreSum / samples;
  const reviewer_score = reviewerScoreSum / samples;
  const maestro_score = maestroScoreSum / samples;

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
    last_outcome_at: lastOutcomeAt,
    _outcome_score: outcome_score,
    _rounds_score: rounds_score,
    _smoke_score: smoke_score,
    _reviewer_score: reviewer_score,
    _maestro_score: maestro_score,
  };
}

function scoreCandidate(c: CandidateSummary, minCost: number | null, maxCost: number | null): number {
  let cost_score: number;
  if (c.cost_per_success_usd == null || minCost == null || maxCost == null) {
    cost_score = 0.5;
  } else if (maxCost === minCost) {
    cost_score = 1;
  } else {
    cost_score = clamp01((maxCost - c.cost_per_success_usd) / (maxCost - minCost));
  }

  const raw =
    0.30 * c._outcome_score +
    0.20 * c._rounds_score +
    0.20 * c._smoke_score +
    0.15 * c._reviewer_score +
    0.10 * c._maestro_score +
    0.05 * cost_score;

  return clamp01(Math.round(raw * 10000) / 10000);
}

export function rankAgents(db: Database, inputRaw: AgentRankInput, now: () => Date): AgentRankOutput {
  const input = AgentRankInputSchema.parse(inputRaw);
  const nowDate = now();
  const nowIso = nowDate.toISOString();
  const from = input.since ?? null;

  const rows = from == null
    ? db.query<AgentPerformanceRow, [string]>(
      `SELECT * FROM agent_performance WHERE task_type=? ORDER BY ts DESC`,
    ).all(input.task_type)
    : db.query<AgentPerformanceRow, [string, string]>(
      `SELECT * FROM agent_performance WHERE task_type=? AND ts >= ? ORDER BY ts DESC`,
    ).all(input.task_type, from);

  const visibleRows = input.include_neutral
    ? rows
    : rows.filter(row => outcomeBucket(row.outcome) !== 'neutral');

  const byAgent = new Map<string, AgentPerformanceRow[]>();
  for (const row of visibleRows) {
    const list = byAgent.get(row.agent_name) ?? [];
    list.push(row);
    byAgent.set(row.agent_name, list);
  }

  const summaries = Array.from(byAgent.entries())
    .map(([agentName, agentRows]) => summarizeAgent(agentName, agentRows))
    .filter(c => c.samples >= input.min_samples);

  const costs = summaries.map(s => s.cost_per_success_usd).filter((v): v is number => v != null);
  const minCost = costs.length > 0 ? Math.min(...costs) : null;
  const maxCost = costs.length > 0 ? Math.max(...costs) : null;

  const candidates = summaries
    .map(s => ({
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
      last_outcome_at: s.last_outcome_at,
      score: scoreCandidate(s, minCost, maxCost),
    }))
    .sort((a, b) =>
      b.score - a.score ||
      b.success_rate - a.success_rate ||
      a.agent_name.localeCompare(b.agent_name),
    );

  return { task_type: input.task_type, window: { from, to: nowIso }, candidates };
}

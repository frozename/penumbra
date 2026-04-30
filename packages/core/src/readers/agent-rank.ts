import type { Database } from 'bun:sqlite';
import {
  AgentRankInputSchema,
  type AgentRankInput,
  type AgentRankOutput,
  type AgentPerformanceRow,
} from '../schemas/agent-performance.js';

const successOutcomes = new Set(['pr_opened', 'merged']);
const failureOutcomes = new Set(['typecheck_failed', 'test_failed', 'pr_creation_failed', 'rejected', 'failed', 'partial']);
const neutralOutcomes = new Set(['no_changes']);

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
  _rounds_score: number;
  _smoke_score: number;
  _reviewer_score: number;
  _recency_score: number;
}

function smokeValue(smoke: string | null): number {
  if (smoke === 'y') return 1;
  if (smoke === 'partial') return 0.5;
  if (smoke === 'n/a') return 0.5;
  if (smoke === 'n') return 0;
  return 0.5;
}

function summarizeAgent(agentName: string, rows: AgentPerformanceRow[], now: Date): CandidateSummary {
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
  let roundsScoreSum = 0;
  let smokeScoreSum = 0;
  let lastOutcomeAt = rows[0]!.ts;

  for (const row of rows) {
    if (row.ts > lastOutcomeAt) lastOutcomeAt = row.ts;
    if (successOutcomes.has(row.outcome)) {
      successes++;
      if (row.cost_usd != null) {
        successCostSum += row.cost_usd;
        successCostCount++;
      }
    } else if (neutralOutcomes.has(row.outcome)) {
      neutral++;
    } else if (failureOutcomes.has(row.outcome)) {
      failures++;
    } else {
      failures++;
    }

    if (row.rounds != null) {
      roundsSum += row.rounds;
      roundsCount++;
      roundsScoreSum += 1 / row.rounds;
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

  const rounds_score = roundsScoreSum / samples;
  const smoke_score = smokeScoreSum / samples;
  const reviewer_score = avgReviewerFindings != null
    ? 1 - Math.min(avgReviewerFindings, 10) / 10
    : 0.5;

  const ageMs = now.getTime() - new Date(lastOutcomeAt).getTime();
  const ageDays = ageMs / 86_400_000;
  const recency_score = ageDays <= 7 ? 1 : ageDays <= 30 ? 0.5 : 0.25;

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
    _rounds_score: rounds_score,
    _smoke_score: smoke_score,
    _reviewer_score: reviewer_score,
    _recency_score: recency_score,
  };
}

function scoreCandidate(c: CandidateSummary, minCost: number | null, maxCost: number | null): number {
  let cost_score: number;
  if (c.cost_per_success_usd == null || minCost == null || maxCost == null) {
    cost_score = 0.5;
  } else if (maxCost === minCost) {
    cost_score = 1;
  } else {
    cost_score = (maxCost - c.cost_per_success_usd) / (maxCost - minCost);
  }

  const raw =
    0.40 * c.success_rate +
    0.20 * c._rounds_score +
    0.15 * c._smoke_score +
    0.10 * c._reviewer_score +
    0.10 * cost_score +
    0.05 * c._recency_score;

  return Math.round(raw * 10000) / 10000;
}

export function rankAgents(db: Database, inputRaw: AgentRankInput, now: () => Date): AgentRankOutput {
  const input = AgentRankInputSchema.parse(inputRaw);
  const nowDate = now();
  const nowIso = nowDate.toISOString();
  const from = input.since ?? new Date(nowDate.getTime() - 30 * 86_400_000).toISOString();

  const rows = db.query<AgentPerformanceRow, [string, string]>(
    `SELECT * FROM agent_performance WHERE task_type=? AND ts >= ? ORDER BY ts DESC`,
  ).all(input.task_type, from);

  const visibleRows = input.include_neutral
    ? rows
    : rows.filter(row => !neutralOutcomes.has(row.outcome));

  const byAgent = new Map<string, AgentPerformanceRow[]>();
  for (const row of visibleRows) {
    const list = byAgent.get(row.agent_name) ?? [];
    list.push(row);
    byAgent.set(row.agent_name, list);
  }

  const summaries = Array.from(byAgent.entries())
    .map(([agentName, agentRows]) => summarizeAgent(agentName, agentRows, nowDate))
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

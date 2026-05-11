import type { Database } from 'bun:sqlite';
import type { AgentRecommendInput } from '../schemas/agent-recommend.js';

export type RecommendInput = {
  db: Database;
  taskType: string;
  riskClass?: string;
  windowDays?: number;
  now?: Date;
  agentKind?: string;
};

export type AgentRecommendation = {
  agent_name: string;
  task_type: string;
  samples: number;
  success_rate: number;
  avg_latency_seconds: number | null;
  last_observed_at: string;
};

interface Row {
  agent_name: string;
  task_type: string;
  samples: number;
  successes: number;
  avg_latency_ms: number | null;
  last_observed_at: string;
}

export function getAgentRecommendations(input: RecommendInput): AgentRecommendation[] {
  const windowDays = input.windowDays ?? 7;
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const agentKind = input.agentKind ?? 'coding';

  // TODO(plan-meta): no risk_class column yet
  void input.riskClass;

  const rows = input.db.query<Row, [string, string, string]>(
    `SELECT
       agent_name,
       task_type,
       COUNT(*) AS samples,
       SUM(CASE WHEN outcome IN ('merged','pr_opened','merged_with_concerns') THEN 1 ELSE 0 END) AS successes,
       AVG(latency_ms) AS avg_latency_ms,
       MAX(ts) AS last_observed_at
     FROM agent_performance
     WHERE task_type = ? AND ts >= ? AND COALESCE(agent_kind, 'coding') = ?
     GROUP BY agent_name
     ORDER BY
       (CAST(SUM(CASE WHEN outcome IN ('merged','pr_opened','merged_with_concerns') THEN 1 ELSE 0 END) AS REAL) / COUNT(*)) DESC,
       (AVG(latency_ms) IS NULL) ASC,
       AVG(latency_ms) ASC`,
  ).all(input.taskType, cutoff, agentKind);

  return rows.map(r => ({
    agent_name: r.agent_name,
    task_type: r.task_type,
    samples: r.samples,
    success_rate: r.samples > 0 ? r.successes / r.samples : 0,
    avg_latency_seconds: r.avg_latency_ms != null ? r.avg_latency_ms / 1000 : null,
    last_observed_at: r.last_observed_at,
  }));
}

export function getAgentRecommendationsFromInput(
  db: Database,
  input: AgentRecommendInput,
  clock?: () => Date,
): AgentRecommendation[] {
  return getAgentRecommendations({
    db,
    taskType: input.task_type,
    riskClass: input.risk_class,
    windowDays: input.window_days,
    now: clock?.(),
    agentKind: (input as { agent_kind?: string }).agent_kind,
  });
}

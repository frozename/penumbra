import type { Database } from 'bun:sqlite';
import type { AgentRecommendInput } from '../schemas/agent-recommend.js';
import { routeAgent } from '../services/agent-routing.js';

export type RecommendInput = {
  db: Database;
  taskType: string;
  riskClass?: string;
  windowDays?: number;
  now?: Date;
  agentKind?: 'coding' | 'long_lived';
};

export type AgentRecommendation = {
  agent_name: string;
  task_type: string;
  samples: number;
  success_rate: number;
  avg_latency_seconds: number | null;
  last_observed_at: string;
};

export function getAgentRecommendations(input: RecommendInput): AgentRecommendation[] {
  const out = routeAgent({
    db: input.db,
    detail: 'summary',
    taskType: input.taskType as 'plan_refine' | 'implement_small' | 'implement_substantial' | 'review_adversarial' | 'docs_mechanical' | 'debug_diagnose' | 'smoke_test' | 'health_check' | 'unknown',
    riskClass: input.riskClass,
    windowDays: input.windowDays,
    now: input.now,
    agentKind: input.agentKind,
  });
  if (out.detail !== 'summary') {
    throw new Error('unexpected routeAgent detail for getAgentRecommendations');
  }
  return out.recommendations;
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
    agentKind: input.agent_kind,
  });
}

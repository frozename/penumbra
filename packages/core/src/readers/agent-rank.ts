import type { Database } from 'bun:sqlite';
import { routeAgent } from '../services/agent-routing.js';
import type { AgentRankInput, AgentRankOutput } from '../schemas/agent-performance.js';

export function rankAgents(db: Database, inputRaw: AgentRankInput, now: () => Date): AgentRankOutput {
  const out = routeAgent({
    db,
    detail: 'rank',
    taskType: inputRaw.task_type,
    since: inputRaw.since,
    minSamples: inputRaw.min_samples,
    includeNeutral: inputRaw.include_neutral,
    includeCost: inputRaw.include_cost,
    agentKind: inputRaw.agent_kind,
    now: now(),
  });
  if (out.detail !== 'rank') {
    throw new Error('unexpected routeAgent detail for rankAgents');
  }
  return out.candidates;
}

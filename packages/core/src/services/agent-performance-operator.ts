import type { Database } from 'bun:sqlite';
import type { Uuid } from '../utils/uuid.js';
import { HandoffReader } from '../readers/handoff.js';
import {
  RecordOperatorAgentPerformanceInputSchema,
  type AgentPerformanceRow,
  type RecordOperatorAgentPerformanceInput,
} from '../schemas/agent-performance.js';
import { aggregateHandoffUsage } from './agent-performance-capture.js';
import { AgentPerformanceWriter } from '../writers/agent-performance.js';

function computeResolvedLatencyMs(ts: string, resolvedAt: string | null): number | null {
  if (!resolvedAt) return null;
  const start = new Date(ts).getTime();
  const end = new Date(resolvedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

export function recordOperatorAgentPerformance(opts: {
  db: Database;
  uuid: Uuid;
  clock: () => Date;
  input: RecordOperatorAgentPerformanceInput;
}): AgentPerformanceRow {
  const inputResult = RecordOperatorAgentPerformanceInputSchema.safeParse(opts.input);
  if (!inputResult.success) {
    throw new Error(`invalid operator agent performance input: ${inputResult.error.issues.map((issue) => issue.message).join(', ')}`);
  }
  const input = inputResult.data;
  const handoff = new HandoffReader({ db: opts.db }).get(input.handoff_id);
  if (!handoff) throw new Error(`handoff not found: ${input.handoff_id}`);

  const nowIso = opts.clock().toISOString();
  const latencyMs = computeResolvedLatencyMs(handoff.ts, handoff.resolved_at);
  const usage = aggregateHandoffUsage(opts.db, input.handoff_id);
  const tokensUsed = usage.tokens_used;
  const row: AgentPerformanceRow = {
    performance_id: opts.uuid(),
    handoff_id: input.handoff_id,
    conversation_id: handoff.conversation_id,
    project_id: handoff.project_id,
    ts: nowIso,
    agent_name: handoff.to_agent,
    task_type: input.task_type,
    outcome: input.outcome,
    rounds: input.rounds ?? null,
    smoke_pass: input.smoke_pass ?? null,
    reviewer_findings: input.reviewer_findings ?? null,
    maestro_score: input.maestro_score ?? null,
    cost_usd: input.cost_usd ?? usage.cost_usd,
    tokens_used: tokensUsed,
    latency_ms: latencyMs,
    source: 'operator',
    notes: input.notes ?? null,
    metadata_json: JSON.stringify({ source: 'operator' }),
  };

  return new AgentPerformanceWriter(opts.db).upsert(row);
}

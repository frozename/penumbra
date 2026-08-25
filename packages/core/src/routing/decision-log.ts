import type { Database } from "bun:sqlite";

import type { RoutingDecision } from "./schemas.js";

export interface WriteRoutingDecisionOpts {
  decisionId: string;
  ts: string;
  handoffId: string | null;
  mode: string;
  applied: boolean;
  // Populated by the daemon routing integration; nullable by design for replay rows.
  role?: string;
  predictedCostUsd?: number;
  predictedLatencyMs?: number;
}

export interface RoutingDecisionLogRecord {
  decisionId: string;
  ts: string;
  handoffId: string | null;
  mode: string;
  role: string | null;
  selectedAgent: string | null;
  selectedProvider: string | null;
  applied: boolean;
  score: number;
  confidence: number;
  predictedCostUsd: number | null;
  predictedLatencyMs: number | null;
  taskProfile: RoutingDecision["taskProfile"];
  factors: RoutingDecision["factors"];
  alternatives: RoutingDecision["alternatives"];
  fallbackChain: RoutingDecision["fallbackChain"];
  dataFreshness: RoutingDecision["dataFreshness"];
  explanation: RoutingDecision["explanation"];
  routerSchemaVersion: string;
}

export interface ReadRoutingDecisionsOpts {
  handoffId?: string | null;
  sinceIso?: string;
  limit?: number;
}

export function writeRoutingDecision(
  db: Database,
  decision: RoutingDecision,
  opts: WriteRoutingDecisionOpts,
): void {
  db.prepare(
    `
      INSERT INTO routing_decisions (
        decision_id, ts, handoff_id, mode, role, selected_agent, selected_provider,
        applied, score, confidence, predicted_cost_usd, predicted_latency_ms,
        task_profile_json, factors_json, alternatives_json, fallback_chain_json,
        data_freshness_json, explanation_json, router_schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    opts.decisionId,
    opts.ts,
    opts.handoffId,
    opts.mode,
    opts.role ?? null,
    decision.selected?.agent ?? null,
    decision.selected?.provider ?? null,
    opts.applied ? 1 : 0,
    decision.score,
    decision.confidence,
    opts.predictedCostUsd ?? null,
    opts.predictedLatencyMs ?? null,
    JSON.stringify(decision.taskProfile),
    JSON.stringify(decision.factors),
    JSON.stringify(decision.alternatives),
    JSON.stringify(decision.fallbackChain),
    JSON.stringify(decision.dataFreshness),
    JSON.stringify(decision.explanation),
    decision.routerSchemaVersion,
  );
}

interface RoutingDecisionLogRow {
  decision_id: string;
  ts: string;
  handoff_id: string | null;
  mode: string;
  role: string | null;
  selected_agent: string | null;
  selected_provider: string | null;
  applied: number;
  score: number;
  confidence: number;
  predicted_cost_usd: number | null;
  predicted_latency_ms: number | null;
  task_profile_json: string;
  factors_json: string;
  alternatives_json: string;
  fallback_chain_json: string;
  data_freshness_json: string;
  explanation_json: string;
  router_schema_version: string;
}

export function readRoutingDecisions(
  db: Database,
  opts: ReadRoutingDecisionsOpts = {},
): RoutingDecisionLogRecord[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.handoffId === null) {
    conditions.push("handoff_id IS NULL");
  } else if (opts.handoffId !== undefined) {
    conditions.push("handoff_id = ?");
    params.push(opts.handoffId);
  }
  if (opts.sinceIso !== undefined) {
    conditions.push("ts >= ?");
    params.push(opts.sinceIso);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit === undefined ? "" : " LIMIT ?";
  if (opts.limit !== undefined) params.push(opts.limit);

  const rows = db
    .prepare(
      `
        SELECT decision_id, ts, handoff_id, mode, role, selected_agent, selected_provider,
               applied, score, confidence, predicted_cost_usd, predicted_latency_ms,
               task_profile_json, factors_json, alternatives_json, fallback_chain_json,
               data_freshness_json, explanation_json, router_schema_version
        FROM routing_decisions
        ${where}
        ORDER BY ts DESC${limit}
      `,
    )
    .all(...params) as RoutingDecisionLogRow[];

  return rows.map((row) => ({
    decisionId: row.decision_id,
    ts: row.ts,
    handoffId: row.handoff_id,
    mode: row.mode,
    role: row.role,
    selectedAgent: row.selected_agent,
    selectedProvider: row.selected_provider,
    applied: row.applied === 1,
    score: row.score,
    confidence: row.confidence,
    predictedCostUsd: row.predicted_cost_usd,
    predictedLatencyMs: row.predicted_latency_ms,
    taskProfile: JSON.parse(row.task_profile_json) as RoutingDecision["taskProfile"],
    factors: JSON.parse(row.factors_json) as RoutingDecision["factors"],
    alternatives: JSON.parse(row.alternatives_json) as RoutingDecision["alternatives"],
    fallbackChain: JSON.parse(row.fallback_chain_json) as RoutingDecision["fallbackChain"],
    dataFreshness: JSON.parse(row.data_freshness_json) as RoutingDecision["dataFreshness"],
    explanation: JSON.parse(row.explanation_json) as RoutingDecision["explanation"],
    routerSchemaVersion: row.router_schema_version,
  }));
}

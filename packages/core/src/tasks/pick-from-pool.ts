import type { Database } from "bun:sqlite";

import type { AgentTaskType } from "../schemas/agent-performance.js";

import {
  GATE_OUTCOME_PASS_VALUES,
  resolveClassifierDeclineCutoverIso,
  resolveGateOutcomeCutoverIso,
  routeAgent,
  type RouteAgentInput,
  SUCCESS_OUTCOME_VALUES,
} from "../services/agent-routing.js";
import { pickPreferred } from "./auction.js";

type AgentchatConfig = NonNullable<RouteAgentInput["agentchatConfig"]>;
type PressureSnapshot = NonNullable<RouteAgentInput["applyPressure"]>;
const RECENT_FAILURE_DEMOTION_WINDOW = 3;
// Failures older than this cannot demote: an agent whose only history is a
// stale outage (and no traffic since) must not stay blacklisted forever.
const RECENT_FAILURE_DEMOTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type RecentOutcomeRow = {
  outcome: string;
  failure_class: string | null;
  gate_outcome: string | null;
  ts: string;
};

function isSuccess(row: RecentOutcomeRow, gateOutcomeCutover: string): boolean {
  if (!(SUCCESS_OUTCOME_VALUES as readonly string[]).includes(row.outcome)) return false;
  if (row.gate_outcome === null) return row.ts < gateOutcomeCutover;
  return (GATE_OUTCOME_PASS_VALUES as readonly string[]).includes(row.gate_outcome);
}

function isNeutral(row: RecentOutcomeRow): boolean {
  return row.outcome === "no_changes" || row.outcome === "bypassed";
}

function recentlyFailingAgents(pool: string[], db: Database, taskType: AgentTaskType): Set<string> {
  const demoted = new Set<string>();
  const gateOutcomeCutover = resolveGateOutcomeCutoverIso();
  const classifierDeclineCutover = resolveClassifierDeclineCutoverIso();
  const recencyFloor = new Date(Date.now() - RECENT_FAILURE_DEMOTION_MAX_AGE_MS).toISOString();
  const stmt = db.query<RecentOutcomeRow, [string, string, string, string, number]>(
    `SELECT outcome, failure_class, gate_outcome, ts
     FROM agent_performance
     WHERE task_type = ? AND agent_name = ? AND ts >= ?
       AND (failure_class IS NULL OR failure_class != 'classifier_declined' OR ts < ?)
     ORDER BY ts DESC
     LIMIT ?`,
  );
  for (const agent of pool) {
    const rows = stmt.all(
      taskType,
      agent,
      recencyFloor,
      classifierDeclineCutover,
      RECENT_FAILURE_DEMOTION_WINDOW,
    );
    if (rows.length < RECENT_FAILURE_DEMOTION_WINDOW) continue;
    if (rows.every((row) => !isSuccess(row, gateOutcomeCutover) && !isNeutral(row))) {
      demoted.add(agent);
    }
  }
  return demoted;
}

export function pickFromPool(
  pool: string[],
  db: Database,
  agentchatConfig: AgentchatConfig | null | undefined,
  pressure: PressureSnapshot | null | undefined,
  taskType: AgentTaskType,
  // Caller-asserted "this dispatch will not call penumbra MCP tools" hint.
  // Forwarded verbatim to routeAgent so the scorer can mildly penalize ACP
  // candidates relative to HTTP candidates. Unset/false leaves scoring
  // byte-identical to today (inert default). Only set by callers that have
  // positively confirmed the role contract is text-only — routing a
  // tool-needing role to an HTTP seat breaks it.
  tool_free?: boolean,
): string {
  const [firstAgent, secondAgent] = pool;
  if (firstAgent === undefined) throw new Error("pickFromPool: pool must not be empty");
  if (secondAgent === undefined) return firstAgent;

  const localConfig: AgentchatConfig | undefined = agentchatConfig
    ? {
        ...agentchatConfig,
        role_routing: {
          ...agentchatConfig.role_routing,
          headroom_weighting: true,
          latency_weighting: true,
        },
      }
    : undefined;

  const out = routeAgent({
    db,
    detail: "rank",
    taskType,
    agentRegistry: pool,
    includeNeutral: true,
    applyPressure: pressure ?? undefined,
    agentchatConfig: localConfig,
    tool_free,
  });

  if (out.detail !== "rank") return firstAgent;
  const demoted = recentlyFailingAgents(pool, db, taskType);
  const eligiblePool = pool.filter((agent) => !demoted.has(agent));
  const pickPool = eligiblePool.length > 0 ? eligiblePool : pool;
  const [pickHead] = pickPool;
  if (pickHead === undefined) return firstAgent;

  const winner = pickPreferred(
    out.candidates.candidates,
    pickPool.map((name) => ({ name })),
  );
  return winner?.agent_id ?? pickHead;
}

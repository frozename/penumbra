import type { PermissionProfile } from "@penumbra/api-contract";
import type { Database } from "bun:sqlite";

import type { RoutingBias } from "../readers/routing-bias.js";
import type { AgentTaskType } from "../schemas/agent-performance.js";

import {
  isNeutralPerformanceOutcome,
  isTextOnlyAdapter,
  resolveBiasEffect,
  resolveClassifierDeclineCutoverIso,
  resolveProvider,
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
  environment_failure: string | null;
};

function isSuccess(row: RecentOutcomeRow): boolean {
  return (SUCCESS_OUTCOME_VALUES as readonly string[]).includes(row.outcome);
}

function isNeutral(row: RecentOutcomeRow): boolean {
  return isNeutralPerformanceOutcome(row);
}

function recentlyFailingAgents(pool: string[], db: Database, taskType: AgentTaskType): Set<string> {
  const demoted = new Set<string>();
  const classifierDeclineCutover = resolveClassifierDeclineCutoverIso();
  const recencyFloor = new Date(Date.now() - RECENT_FAILURE_DEMOTION_MAX_AGE_MS).toISOString();
  const stmt = db.query<RecentOutcomeRow, [string, string, string, string, number]>(
    `SELECT outcome, failure_class, environment_failure
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
    if (rows.every((row) => !isSuccess(row) && !isNeutral(row))) {
      demoted.add(agent);
    }
  }
  return demoted;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve the existing pool selection policy while grandfathering its pre-existing complexity.
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
  activeBiases?: RoutingBias[],
  // Permission profile the dispatch will run under. Callers are expected to
  // pre-filter `pool` to enforcing seats (see resolveAgent); the value is
  // forwarded to routeAgent so the ranker applies the same constraint.
  permission_profile?: PermissionProfile,
): string {
  if (pool.length === 0) throw new Error("pickFromPool: pool must not be empty");

  let constraintFilteredPool = pool;
  // requires_tools needs config to resolve adapters and is intentionally inert without it; production callers pass config.
  if (tool_free !== true && agentchatConfig) {
    const textOnlyAgents = new Set(
      agentchatConfig.agents
        .filter((agent) => isTextOnlyAdapter(agent.adapter))
        .map((agent) => agent.name),
    );
    constraintFilteredPool = pool.filter((name) => !textOnlyAgents.has(name));
  }
  if (constraintFilteredPool.length === 0) {
    throw new Error(
      `pickFromPool: no tool-capable agents remain after requires_tools constraint (taskType=${taskType}, pool=${pool.join(",")})`,
    );
  }

  let biasFilteredPool = pool;
  if (activeBiases && activeBiases.length > 0) {
    const nonExcluded = constraintFilteredPool.filter((name) => {
      const conf = agentchatConfig?.agents.find((agent) => agent.name === name);
      const provider = conf ? resolveProvider(conf) : null;
      return !resolveBiasEffect(name, provider, activeBiases).exclude;
    });
    // When every member is excluded, re-admit the full pool and fail toward
    // its configured preference order, matching the single-seat fallback.
    if (nonExcluded.length > 0) {
      biasFilteredPool = nonExcluded;
    } else {
      console.warn(
        "[pick-from-pool] all pool members are bias-excluded; re-admitting full pool in preference order",
        { pool: constraintFilteredPool, taskType },
      );
      biasFilteredPool = constraintFilteredPool;
    }
  } else {
    biasFilteredPool = constraintFilteredPool;
  }

  const [firstAgent, secondAgent] = biasFilteredPool;
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

  // The workflow pool resolver is a production caller. Forward its one bias
  // snapshot so persona-pool scoring observes the same routing policy.
  const out = routeAgent({
    db,
    detail: "rank",
    taskType,
    agentRegistry: biasFilteredPool,
    includeNeutral: true,
    applyPressure: pressure ?? undefined,
    agentchatConfig: localConfig,
    tool_free,
    activeBiases,
    permission_profile,
  });

  if (out.detail !== "rank") return firstAgent;
  const demoted = recentlyFailingAgents(biasFilteredPool, db, taskType);
  const eligiblePool = biasFilteredPool.filter((agent) => !demoted.has(agent));
  const finalPool = eligiblePool.length > 0 ? eligiblePool : biasFilteredPool;
  const [pickHead] = finalPool;
  if (pickHead === undefined) return firstAgent;

  const winner = pickPreferred(
    out.candidates.candidates,
    finalPool.map((name) => ({ name })),
  );
  return winner?.agent_id ?? pickHead;
}

import type { Database } from "bun:sqlite";

export type FleetLatencyInput = {
  window_hours?: number;
  now?: string | Date;
};

export type FleetLatencyAgentRow = {
  agent_name: string;
  dispatch_count: number;
  dispatches_per_hour: number;
  exec_ms_p50: number | null;
  exec_ms_p95: number | null;
  framework_overhead_ms_p50: number | null;
  framework_overhead_ms_p95: number | null;
  /**
   * ACP warm-pool observability (Phase 0). Split off whether each dispatch's
   * lifecycle emitted `acp.session.reuse` (warm) vs `acp.server.start` (cold).
   * `acp_session_reuse_rate` = reuse / (reuse + cold) over the window, or null
   * for agents with no ACP lifecycle events (e.g. non-stdio-acp agents).
   */
  acp_session_reuse_rate: number | null;
  framework_overhead_ms_p50_cold: number | null;
  framework_overhead_ms_p50_reuse: number | null;
  queue_depth: number;
};

export type FleetLatencyOutput = {
  window: {
    from: string;
    to: string;
    hours: number;
  };
  agents: FleetLatencyAgentRow[];
};

type DispatchRow = {
  agent_name: string;
  wall_ms: unknown;
};

type FrameworkOverheadRow = {
  agent_name: string;
  framework_overhead_ms: unknown;
};

type CountRow = {
  agent_name: string;
  dispatch_count: number;
};

type QueueRow = {
  agent_name: string;
  queue_depth: number;
};

export function readFleetLatency(db: Database, input: FleetLatencyInput = {}): FleetLatencyOutput {
  const hours = input.window_hours ?? 24;
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error("invalid now");
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("window_hours must be positive");

  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const fromIso = from.toISOString();
  const toIso = now.toISOString();
  const agents = new Map<string, FleetLatencyAgentRow>();

  const dispatchCounts = db
    .query<CountRow, [string, string]>(
      `
      SELECT h.to_agent AS agent_name, COUNT(*) AS dispatch_count
      FROM dispatch_events e
      JOIN handoffs h ON h.handoff_id = e.handoff_id
      WHERE e.kind = 'dispatch.end'
        AND e.ts >= ?
        AND e.ts <= ?
      GROUP BY h.to_agent
    `,
    )
    .all(fromIso, toIso);

  for (const row of dispatchCounts) {
    agents.set(row.agent_name, {
      agent_name: row.agent_name,
      dispatch_count: row.dispatch_count,
      dispatches_per_hour: row.dispatch_count / hours,
      exec_ms_p50: null,
      exec_ms_p95: null,
      framework_overhead_ms_p50: null,
      framework_overhead_ms_p95: null,
      acp_session_reuse_rate: null,
      framework_overhead_ms_p50_cold: null,
      framework_overhead_ms_p50_reuse: null,
      queue_depth: 0,
    });
  }

  const queueRows = db
    .query<QueueRow, []>(
      `
      SELECT to_agent AS agent_name, COUNT(*) AS queue_depth
      FROM handoffs
      WHERE status IN ('approved', 'dispatched')
      GROUP BY to_agent
    `,
    )
    .all();

  for (const row of queueRows) {
    const existing =
      agents.get(row.agent_name) ??
      ({
        agent_name: row.agent_name,
        dispatch_count: 0,
        dispatches_per_hour: 0,
        exec_ms_p50: null,
        exec_ms_p95: null,
        framework_overhead_ms_p50: null,
        framework_overhead_ms_p95: null,
        acp_session_reuse_rate: null,
        framework_overhead_ms_p50_cold: null,
        framework_overhead_ms_p50_reuse: null,
        queue_depth: 0,
      } satisfies FleetLatencyAgentRow);
    existing.queue_depth = row.queue_depth;
    agents.set(row.agent_name, existing);
  }

  const dispatchRows = db
    .query<DispatchRow, [string, string]>(
      `
      SELECT h.to_agent AS agent_name, json_extract(e.meta_json, '$.wall_ms') AS wall_ms
      FROM dispatch_events e
      JOIN handoffs h ON h.handoff_id = e.handoff_id
      WHERE e.kind = 'dispatch.end'
        AND e.ts >= ?
        AND e.ts <= ?
      ORDER BY h.to_agent ASC, e.ts ASC, e.id ASC
    `,
    )
    .all(fromIso, toIso);

  const wallMsByAgent = new Map<string, number[]>();
  for (const row of dispatchRows) {
    if (typeof row.wall_ms !== "number" || !Number.isFinite(row.wall_ms) || row.wall_ms < 0) {
      continue;
    }
    const values = wallMsByAgent.get(row.agent_name) ?? [];
    values.push(Math.round(row.wall_ms));
    wallMsByAgent.set(row.agent_name, values);
  }

  for (const [agentName, values] of wallMsByAgent) {
    values.sort((a, b) => a - b);
    const row = agents.get(agentName);
    if (!row) continue;
    row.exec_ms_p50 = percentileNearestRank(values, 0.5);
    row.exec_ms_p95 = percentileNearestRank(values, 0.95);
  }

  const frameworkRows = db
    .query<FrameworkOverheadRow, [string, string]>(
      `
      SELECT agent_name, framework_overhead_ms
      FROM agent_performance
      WHERE ts >= ?
        AND ts <= ?
      ORDER BY agent_name ASC, ts ASC
    `,
    )
    .all(fromIso, toIso);

  const overheadByAgent = new Map<string, number[]>();
  for (const row of frameworkRows) {
    if (
      typeof row.framework_overhead_ms !== "number" ||
      !Number.isFinite(row.framework_overhead_ms) ||
      row.framework_overhead_ms < 0
    ) {
      continue;
    }
    const values = overheadByAgent.get(row.agent_name) ?? [];
    values.push(Math.round(row.framework_overhead_ms));
    overheadByAgent.set(row.agent_name, values);
  }

  for (const [agentName, values] of overheadByAgent) {
    values.sort((a, b) => a - b);
    const row = agents.get(agentName);
    if (!row) continue;
    row.framework_overhead_ms_p50 = percentileNearestRank(values, 0.5);
    row.framework_overhead_ms_p95 = percentileNearestRank(values, 0.95);
  }

  // ACP warm-pool reuse rate (Phase 0): reuse / (reuse + cold) lifecycle events
  // per agent. Stays null for agents that emitted no ACP lifecycle events.
  const acpLifecycleRows = db
    .query<{ agent_name: string; reuse_count: number; cold_count: number }, [string, string]>(
      `
      SELECT h.to_agent AS agent_name,
             SUM(CASE WHEN e.kind = 'acp.session.reuse' THEN 1 ELSE 0 END) AS reuse_count,
             SUM(CASE WHEN e.kind = 'acp.server.start' THEN 1 ELSE 0 END) AS cold_count
      FROM dispatch_events e
      JOIN handoffs h ON h.handoff_id = e.handoff_id
      WHERE e.kind IN ('acp.session.reuse', 'acp.server.start')
        AND e.ts >= ?
        AND e.ts <= ?
      GROUP BY h.to_agent
    `,
    )
    .all(fromIso, toIso);

  for (const lifecycleRow of acpLifecycleRows) {
    const row = agents.get(lifecycleRow.agent_name);
    if (!row) continue;
    const denom = lifecycleRow.reuse_count + lifecycleRow.cold_count;
    if (denom > 0) row.acp_session_reuse_rate = lifecycleRow.reuse_count / denom;
  }

  // Cold vs reuse framework-overhead split (Phase 0): bucket each dispatch's
  // acp.session.start setup overhead by whether that handoff's lifecycle
  // emitted a session reuse (warm) rather than a cold session start.
  const overheadSplitRows = db
    .query<
      { agent_name: string; framework_overhead_ms: unknown; is_reuse: number },
      [string, string]
    >(
      `
      SELECT h.to_agent AS agent_name,
             json_extract(s.meta_json, '$.framework_overhead_ms') AS framework_overhead_ms,
             EXISTS(
               SELECT 1 FROM dispatch_events r
               WHERE r.handoff_id = e.handoff_id AND r.kind = 'acp.session.reuse'
             ) AS is_reuse
      FROM dispatch_events e
      JOIN handoffs h ON h.handoff_id = e.handoff_id
      JOIN dispatch_events s ON s.handoff_id = e.handoff_id AND s.kind = 'acp.session.start'
      WHERE e.kind = 'dispatch.end'
        AND e.ts >= ?
        AND e.ts <= ?
      ORDER BY h.to_agent ASC, s.ts ASC, s.id ASC
    `,
    )
    .all(fromIso, toIso);

  const coldOverheadByAgent = new Map<string, number[]>();
  const reuseOverheadByAgent = new Map<string, number[]>();
  for (const splitRow of overheadSplitRows) {
    if (
      typeof splitRow.framework_overhead_ms !== "number" ||
      !Number.isFinite(splitRow.framework_overhead_ms) ||
      splitRow.framework_overhead_ms < 0
    ) {
      continue;
    }
    const bucket = splitRow.is_reuse ? reuseOverheadByAgent : coldOverheadByAgent;
    const values = bucket.get(splitRow.agent_name) ?? [];
    values.push(Math.round(splitRow.framework_overhead_ms));
    bucket.set(splitRow.agent_name, values);
  }

  for (const [agentName, values] of coldOverheadByAgent) {
    values.sort((a, b) => a - b);
    const row = agents.get(agentName);
    if (!row) continue;
    row.framework_overhead_ms_p50_cold = percentileNearestRank(values, 0.5);
  }
  for (const [agentName, values] of reuseOverheadByAgent) {
    values.sort((a, b) => a - b);
    const row = agents.get(agentName);
    if (!row) continue;
    row.framework_overhead_ms_p50_reuse = percentileNearestRank(values, 0.5);
  }

  return {
    window: { from: fromIso, to: toIso, hours },
    agents: [...agents.values()].sort(
      (a, b) =>
        b.dispatch_count - a.dispatch_count ||
        b.queue_depth - a.queue_depth ||
        a.agent_name.localeCompare(b.agent_name),
    ),
  };
}

function percentileNearestRank(sortedValues: number[], percentile: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.max(0, Math.ceil(sortedValues.length * percentile) - 1);
  return sortedValues[index] ?? null;
}

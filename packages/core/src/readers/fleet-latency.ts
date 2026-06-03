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

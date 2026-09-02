import type { Database } from "bun:sqlite";

export type DispatchEvent = {
  id: number;
  handoff_id: string;
  worker_id: string | null;
  source: string;
  kind: string;
  ts: string;
  meta_json: string | null;
};

export type DispatchSummary = {
  handoff_id: string;
  agent: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  outcome: "ok" | "failed" | "in_progress";
  failed_event_kinds: string[];
};

export type DispatchSourceOutput = {
  events: DispatchEvent[];
  summaries?: DispatchSummary[];
  warnings: string[];
};

const HEARTBEAT_KINDS = ["heartbeat.received", "heartbeat.sent", "watchdog.tick"] as const;

type DispatchEventsArgs = {
  since?: string;
  until?: string;
  handoff_id?: string;
  limit?: number;
  include_heartbeats?: boolean;
  outcomes_only?: boolean;
};

function buildEventConditions(args: DispatchEventsArgs): {
  conditions: string[];
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (args.since) {
    conditions.push("ts >= ?");
    params.push(args.since);
  }
  if (args.until) {
    conditions.push("ts <= ?");
    params.push(args.until);
  }
  if (args.handoff_id) {
    conditions.push("handoff_id = ?");
    params.push(args.handoff_id);
  }
  if (!args.include_heartbeats) {
    conditions.push(`kind NOT IN (${HEARTBEAT_KINDS.map(() => "?").join(", ")})`);
    params.push(...HEARTBEAT_KINDS);
  }
  return { conditions, params };
}

function isActionableKind(rowKind: string): boolean {
  const kind = rowKind.toLowerCase();
  return (
    rowKind === "claim" ||
    rowKind === "dispatch.start" ||
    rowKind === "dispatch.end" ||
    rowKind === "dispatch.failed" ||
    kind.includes("failed") ||
    kind.includes("error") ||
    kind.includes("cancel") ||
    kind.includes("stall") ||
    kind.includes("timeout") ||
    kind.includes("agent.tool_call.failed")
  );
}

function isFailureKind(rowKind: string): boolean {
  const kind = rowKind.toLowerCase();
  return (
    kind.includes("failed") ||
    kind.includes("error") ||
    kind.includes("cancel") ||
    kind.includes("stall") ||
    kind.includes("timeout") ||
    kind.includes("agent.tool_call.failed")
  );
}

function loadAgentByHandoff(db: Database, handoffIds: string[]): Map<string, string | null> {
  const agentByHandoff = new Map<string, string | null>();
  if (handoffIds.length === 0) return agentByHandoff;
  const placeholders = handoffIds.map(() => "?").join(", ");
  const handoffRows = db
    .query<
      { handoff_id: string; to_agent: string },
      string[]
    >(`SELECT handoff_id, to_agent FROM handoffs WHERE handoff_id IN (${placeholders})`)
    .all(...handoffIds);
  for (const row of handoffRows) {
    agentByHandoff.set(row.handoff_id, row.to_agent);
  }
  return agentByHandoff;
}

function groupByHandoff(actionable: DispatchEvent[]): Map<string, DispatchEvent[]> {
  const byHandoff = new Map<string, DispatchEvent[]>();
  for (const row of actionable) {
    const current = byHandoff.get(row.handoff_id);
    if (current) {
      current.push(row);
    } else {
      byHandoff.set(row.handoff_id, [row]);
    }
  }
  return byHandoff;
}

function computeOutcome(events: DispatchEvent[]): DispatchSummary["outcome"] {
  const hasDispatchFailed = events.some((event) => event.kind === "dispatch.failed");
  const hasCancel = events.some((event) => event.kind.toLowerCase().includes("cancel"));
  if (hasDispatchFailed || hasCancel) return "failed";
  if (events.some((event) => event.kind === "dispatch.end")) return "ok";
  return "in_progress";
}

function summarizeOne(
  handoff_id: string,
  events: DispatchEvent[],
  agentByHandoff: Map<string, string | null>,
): DispatchSummary {
  const started_at = events[0]?.ts ?? null;
  const endedEvent = [...events].reverse().find((event) => {
    const kind = event.kind.toLowerCase();
    return (
      event.kind === "dispatch.end" || event.kind === "dispatch.failed" || kind.includes("cancel")
    );
  });
  const ended_at = endedEvent?.ts ?? null;
  const failedEventKinds = Array.from(
    new Set(events.filter((e) => isFailureKind(e.kind)).map((e) => e.kind)),
  );
  const outcome = computeOutcome(events);
  let duration_seconds: number | null = null;
  if (started_at && ended_at) {
    const startMs = Date.parse(started_at);
    const endMs = Date.parse(ended_at);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      duration_seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
    }
  }
  return {
    handoff_id,
    agent: agentByHandoff.get(handoff_id) ?? null,
    started_at,
    ended_at,
    duration_seconds,
    outcome,
    failed_event_kinds: failedEventKinds,
  };
}

function buildSummaries(db: Database, rows: DispatchEvent[]): DispatchSummary[] {
  const ordered = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
  const actionable = ordered.filter((row) => isActionableKind(row.kind));
  const handoffIds = Array.from(
    new Set(actionable.map((row) => row.handoff_id).filter((id) => id.length > 0)),
  );
  const agentByHandoff = loadAgentByHandoff(db, handoffIds);
  const byHandoff = groupByHandoff(actionable.filter((row) => agentByHandoff.has(row.handoff_id)));
  const summaries: DispatchSummary[] = [];
  for (const [handoff_id, events] of byHandoff.entries()) {
    summaries.push(summarizeOne(handoff_id, events, agentByHandoff));
  }
  return summaries;
}

const EVENT_ROWS_PER_HANDOFF = 200;

function runOutcomesOnly(db: Database, args: DispatchEventsArgs): DispatchSourceOutput {
  const limit = args.limit ?? 1000;
  const handoffConditions: string[] = [];
  const handoffParams: unknown[] = [];
  if (args.since) {
    handoffConditions.push("ts >= ?");
    handoffParams.push(args.since);
  }
  if (args.until) {
    handoffConditions.push("ts <= ?");
    handoffParams.push(args.until);
  }
  if (args.handoff_id) {
    handoffConditions.push("handoff_id = ?");
    handoffParams.push(args.handoff_id);
  }
  const handoffSql = `
    SELECT handoff_id
    FROM handoffs
    ${handoffConditions.length ? "WHERE " + handoffConditions.join(" AND ") : ""}
    ORDER BY ts DESC
    LIMIT ?
  `;
  handoffParams.push(limit);
  try {
    const handoffRows = db.query(handoffSql).all(...(handoffParams as never[])) as {
      handoff_id: string;
      to_agent: string;
      status: string;
      resolution_reason: string | null;
    }[];
    if (handoffRows.length === 0) {
      return { events: [], summaries: [], warnings: [] };
    }
    const handoffIds = handoffRows.map((r) => r.handoff_id);
    const eventConditions: string[] = [`handoff_id IN (${handoffIds.map(() => "?").join(", ")})`];
    const eventParams: unknown[] = [...handoffIds];
    if (!args.include_heartbeats) {
      eventConditions.push(`kind NOT IN (${HEARTBEAT_KINDS.map(() => "?").join(", ")})`);
      eventParams.push(...HEARTBEAT_KINDS);
    }
    const eventSql = `
      SELECT id, handoff_id, worker_id, source, kind, ts, meta_json
      FROM (
        SELECT
          id,
          handoff_id,
          worker_id,
          source,
          kind,
          ts,
          meta_json,
          ROW_NUMBER() OVER (
            PARTITION BY handoff_id
            ORDER BY
              CASE
                WHEN kind IN ('dispatch.end', 'dispatch.failed') OR lower(kind) LIKE '%cancel%' THEN 0
                ELSE 1
              END ASC,
              ts DESC,
              id DESC
          ) AS rn
        FROM dispatch_events
        WHERE ${eventConditions.join(" AND ")}
      )
      WHERE rn <= ?
      ORDER BY ts ASC, id ASC
    `;
    eventParams.push(EVENT_ROWS_PER_HANDOFF);
    const eventRows = db.query(eventSql).all(...(eventParams as never[])) as DispatchEvent[];
    const summaries = buildSummaries(db, eventRows);
    return { events: [], summaries, warnings: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { events: [], warnings: [`dispatch_events: ${msg}`] };
  }
}

export function runDispatchEventsSource(input: {
  db: Database;
  args: DispatchEventsArgs;
}): DispatchSourceOutput {
  const { db, args } = input;
  const outcomesOnly = args.outcomes_only === true;
  if (outcomesOnly) {
    return runOutcomesOnly(db, args);
  }
  const { conditions, params } = buildEventConditions(args);
  const limit = args.limit ?? 200;
  const sql = `
    SELECT id, handoff_id, worker_id, source, kind, ts, meta_json
    FROM dispatch_events
    ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
    ORDER BY ts ASC
    LIMIT ?
  `;
  params.push(limit);
  try {
    const rows = db.query(sql).all(...(params as never[])) as DispatchEvent[];
    return { events: rows, warnings: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { events: [], warnings: [`dispatch_events: ${msg}`] };
  }
}

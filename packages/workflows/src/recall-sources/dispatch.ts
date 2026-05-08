import type { Database } from 'bun:sqlite';

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
  outcome: 'ok' | 'failed' | 'in_progress';
  failed_event_kinds: string[];
};

export type DispatchSourceOutput = {
  events: DispatchEvent[];
  summaries?: DispatchSummary[];
  warnings: string[];
};

const HEARTBEAT_KINDS = ['heartbeat.received', 'heartbeat.sent', 'watchdog.tick'] as const;

export function runDispatchEventsSource(input: {
  db: Database;
  args: {
    since?: string;
    until?: string;
    handoff_id?: string;
    limit?: number;
    include_heartbeats?: boolean;
    outcomes_only?: boolean;
  };
}): DispatchSourceOutput {
  const { db, args } = input;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (args.since) {
    conditions.push('ts >= ?');
    params.push(args.since);
  }
  if (args.until) {
    conditions.push('ts <= ?');
    params.push(args.until);
  }
  if (args.handoff_id) {
    conditions.push('handoff_id = ?');
    params.push(args.handoff_id);
  }
  if (!args.include_heartbeats) {
    conditions.push(`kind NOT IN (${HEARTBEAT_KINDS.map(() => '?').join(', ')})`);
    params.push(...HEARTBEAT_KINDS);
  }
  const outcomesOnly = args.outcomes_only === true;
  const limit = args.limit ?? (outcomesOnly ? 1000 : 200);
  const orderBy = outcomesOnly ? 'DESC' : 'ASC';
  const sql = `
    SELECT id, handoff_id, worker_id, source, kind, ts, meta_json
    FROM dispatch_events
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY ts ${orderBy}
    LIMIT ?
  `;
  params.push(limit);
  try {
    const rows = db.query(sql).all(...(params as never[])) as DispatchEvent[];
    if (!outcomesOnly) {
      return { events: rows, warnings: [] };
    }

    const ordered = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
    const actionable = ordered.filter((row) => {
      const kind = row.kind.toLowerCase();
      return (
        row.kind === 'claim' ||
        row.kind === 'dispatch.start' ||
        row.kind === 'dispatch.end' ||
        row.kind === 'dispatch.failed' ||
        kind.includes('failed') ||
        kind.includes('error') ||
        kind.includes('cancel') ||
        kind.includes('stall') ||
        kind.includes('timeout') ||
        kind.includes('agent.tool_call.failed')
      );
    });

    const handoffIds = Array.from(new Set(actionable.map((row) => row.handoff_id).filter((id) => id.length > 0)));
    const agentByHandoff = new Map<string, string | null>();
    if (handoffIds.length > 0) {
      const placeholders = handoffIds.map(() => '?').join(', ');
      const handoffRows = db
        .query<{ handoff_id: string; to_agent: string }, string[]>(
          `SELECT handoff_id, to_agent FROM handoffs WHERE handoff_id IN (${placeholders})`,
        )
        .all(...handoffIds);
      for (const row of handoffRows) {
        agentByHandoff.set(row.handoff_id, row.to_agent);
      }
    }

    const byHandoff = new Map<string, DispatchEvent[]>();
    for (const row of actionable) {
      const current = byHandoff.get(row.handoff_id);
      if (current) {
        current.push(row);
      } else {
        byHandoff.set(row.handoff_id, [row]);
      }
    }

    const summaries: DispatchSummary[] = [];
    for (const [handoff_id, events] of byHandoff.entries()) {
      const started_at = events[0]?.ts ?? null;
      const endedEvent = [...events]
        .reverse()
        .find((event) => {
          const kind = event.kind.toLowerCase();
          return event.kind === 'dispatch.end' || event.kind === 'dispatch.failed' || kind.includes('cancel');
        });
      const ended_at = endedEvent?.ts ?? null;

      const failedEventKinds = Array.from(
        new Set(
          events
            .filter((event) => {
              const kind = event.kind.toLowerCase();
              return (
                kind.includes('failed') ||
                kind.includes('error') ||
                kind.includes('cancel') ||
                kind.includes('stall') ||
                kind.includes('timeout') ||
                kind.includes('agent.tool_call.failed')
              );
            })
            .map((event) => event.kind),
        ),
      );

      const hasDispatchFailed = events.some((event) => event.kind === 'dispatch.failed');
      const hasCancel = events.some((event) => event.kind.toLowerCase().includes('cancel'));
      const hasDispatchEnd = events.some((event) => event.kind === 'dispatch.end');

      let outcome: DispatchSummary['outcome'] = 'in_progress';
      if (hasDispatchFailed || hasCancel) {
        outcome = 'failed';
      } else if (hasDispatchEnd) {
        outcome = 'ok';
      }

      let duration_seconds: number | null = null;
      if (started_at && ended_at) {
        const startMs = Date.parse(started_at);
        const endMs = Date.parse(ended_at);
        if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
          duration_seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
        }
      }

      summaries.push({
        handoff_id,
        agent: agentByHandoff.get(handoff_id) ?? null,
        started_at,
        ended_at,
        duration_seconds,
        outcome,
        failed_event_kinds: failedEventKinds,
      });
    }

    return { events: [], summaries, warnings: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { events: [], warnings: [`dispatch_events: ${msg}`] };
  }
}

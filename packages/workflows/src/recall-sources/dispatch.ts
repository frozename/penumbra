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

export type DispatchSourceOutput = { events: DispatchEvent[]; warnings: string[] };

const HEARTBEAT_KINDS = ['heartbeat.received', 'heartbeat.sent', 'watchdog.tick'] as const;

export function runDispatchEventsSource(input: {
  db: Database;
  args: {
    since?: string;
    until?: string;
    handoff_id?: string;
    limit?: number;
    include_heartbeats?: boolean;
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
  const sql = `
    SELECT id, handoff_id, worker_id, source, kind, ts, meta_json
    FROM dispatch_events
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY ts ASC
    LIMIT ?
  `;
  params.push(args.limit ?? 200);
  try {
    const rows = db.query(sql).all(...(params as never[])) as DispatchEvent[];
    return { events: rows, warnings: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { events: [], warnings: [`dispatch_events: ${msg}`] };
  }
}

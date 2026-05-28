import { Database } from "bun:sqlite";

export interface RunTailOpts {
  dbPath: string;
  project: string | null;
  limit: number;
}

export interface TailRow {
  ts: string;
  event_type: string;
  source: string;
  project_id: string | null;
  session_id: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  payload_summary: string | null;
}

export function runTail(opts: RunTailOpts): TailRow[] {
  const db = new Database(opts.dbPath, { readonly: true });
  try {
    const sql = `
      SELECT ts, event_type, source, project_id, session_id, model,
             tokens_in, tokens_out, latency_ms, payload_summary
      FROM t0_events
      ${opts.project ? "WHERE project_id = ?" : ""}
      ORDER BY ts DESC
      LIMIT ?`;
    const rows = opts.project
      ? db.query<TailRow, [string, number]>(sql).all(opts.project, opts.limit)
      : db.query<TailRow, [number]>(sql).all(opts.limit);
    return rows.reverse();
  } finally {
    db.close();
  }
}

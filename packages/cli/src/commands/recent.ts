import { Database } from "bun:sqlite";

export interface RunRecentOpts {
  dbPath: string;
  project: string | null;
  limit: number;
}

export interface RecentRow {
  rollup_id: string;
  project_id: string | null;
  session_id: string;
  started_at: string;
  ended_at: string | null;
  n_events: number;
  tokens_in_total: number | null;
  tokens_out_total: number | null;
  first_prompt_excerpt: string | null;
  last_response_excerpt: string | null;
}

export function runRecent(opts: RunRecentOpts): RecentRow[] {
  const db = new Database(opts.dbPath, { readonly: true });
  try {
    const sql = `
      SELECT rollup_id, project_id, session_id, started_at, ended_at, n_events,
             tokens_in_total, tokens_out_total,
             first_prompt_excerpt, last_response_excerpt
      FROM t1_rollups
      ${opts.project ? "WHERE project_id = ?" : ""}
      ORDER BY COALESCE(ended_at, started_at) DESC
      LIMIT ?`;
    return opts.project
      ? db.query<RecentRow, [string, number]>(sql).all(opts.project, opts.limit)
      : db.query<RecentRow, [number]>(sql).all(opts.limit);
  } finally {
    db.close();
  }
}

import type { Database } from "bun:sqlite";

export type SessionEvent = {
  id: number;
  session_id: string | null;
  related_session_id: string | null;
  project_id: string | null;
  cwd: string | null;
  transcript_path: string | null;
  ref_path: string | null;
  kind: string;
  ts: string;
  meta_json: string | null;
};

export type SessionEventsArgs = {
  session_id?: string;
  kind_prefix?: string;
  since?: string;
  limit?: number;
};

export type SessionEventsSourceOutput = {
  events: SessionEvent[];
  warnings: string[];
};

function escapeLikePrefix(prefix: string): string {
  return prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function buildConditions(args: SessionEventsArgs): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (args.session_id) {
    conditions.push("session_id = ?");
    params.push(args.session_id);
  }
  if (args.kind_prefix) {
    conditions.push("kind LIKE ? ESCAPE '\\'");
    params.push(`${escapeLikePrefix(args.kind_prefix)}%`);
  }
  if (args.since) {
    conditions.push("ts >= ?");
    params.push(args.since);
  }
  return { conditions, params };
}

export function runSessionEventsSource(input: {
  db: Database;
  args: SessionEventsArgs;
}): SessionEventsSourceOutput {
  const { conditions, params } = buildConditions(input.args);
  const limit = Math.min(Math.max(Number(input.args.limit) || 100, 1), 500);
  params.push(limit);
  const sql = `
    SELECT id, session_id, related_session_id, project_id, cwd, transcript_path, ref_path, kind, ts, meta_json
    FROM session_events
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY ts DESC, id DESC
    LIMIT ?
  `;
  try {
    return {
      events: input.db.query(sql).all(...(params as never[])) as SessionEvent[],
      warnings: [],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { events: [], warnings: [`session_events: ${msg}`] };
  }
}

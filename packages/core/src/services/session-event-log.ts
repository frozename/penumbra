import type { SessionEventKind as ApiSessionEventKind } from "@penumbra/api-contract";
import type { Database } from "bun:sqlite";

export type SessionEventKind = ApiSessionEventKind;

export interface SessionEventInput {
  session_id?: string | null;
  related_session_id?: string | null;
  project_id?: string | null;
  cwd?: string | null;
  transcript_path?: string | null;
  ref_path?: string | null;
  kind: SessionEventKind;
  ts: string;
  meta?: unknown;
}

export interface SessionEventQuery {
  session_id?: string;
  kind_prefix?: string;
  since?: string;
  limit?: number;
}

export interface SessionEventRow {
  id: number;
  session_id: string | null;
  related_session_id: string | null;
  project_id: string | null;
  cwd: string | null;
  transcript_path: string | null;
  ref_path: string | null;
  kind: SessionEventKind;
  ts: string;
  meta_json: string | null;
}

const DEFAULT_SESSION_EVENT_LIMIT = 500;
const MAX_SESSION_EVENT_LIMIT = 5000;

function clampLimit(limit: number | undefined, defaultLimit: number, maxLimit: number): number {
  const numeric = Number(limit);
  if (!Number.isFinite(numeric) || numeric <= 0) return defaultLimit;
  return Math.min(Math.trunc(numeric), maxLimit);
}

function escapeLikePrefix(prefix: string): string {
  return prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export class SessionEventLog {
  constructor(private readonly db: Database) {}

  record(event: SessionEventInput): void {
    this.db.run(
      `INSERT INTO session_events (
         session_id, related_session_id, project_id, cwd, transcript_path, ref_path, kind, ts, meta_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.session_id ?? null,
        event.related_session_id ?? null,
        event.project_id ?? null,
        event.cwd ?? null,
        event.transcript_path ?? null,
        event.ref_path ?? null,
        event.kind,
        event.ts,
        event.meta === undefined || event.meta === null ? null : JSON.stringify(event.meta),
      ],
    );
  }

  recordBatch(events: SessionEventInput[]): void {
    if (events.length === 0) return;
    const tx = this.db.transaction((batch: SessionEventInput[]) => {
      for (const event of batch) this.record(event);
    });
    tx(events);
  }

  listBySession(session_id: string, limit?: number): SessionEventRow[] {
    const boundedLimit = clampLimit(limit, DEFAULT_SESSION_EVENT_LIMIT, MAX_SESSION_EVENT_LIMIT);
    return this.db
      .query("SELECT * FROM session_events WHERE session_id = ? ORDER BY ts ASC, id ASC LIMIT ?")
      .all(session_id, boundedLimit) as SessionEventRow[];
  }

  listContinuityChain(session_id: string, limit?: number): SessionEventRow[] {
    const boundedLimit = clampLimit(limit, DEFAULT_SESSION_EVENT_LIMIT, MAX_SESSION_EVENT_LIMIT);
    return this.db
      .query(
        `SELECT * FROM session_events
         WHERE session_id = ? OR related_session_id = ?
         ORDER BY ts ASC, id ASC
         LIMIT ?`,
      )
      .all(session_id, session_id, boundedLimit) as SessionEventRow[];
  }

  resolveSourceSessionForNote(ref_path: string): string | null {
    const row = this.db
      .query<{ session_id: string | null }, [string]>(
        `SELECT session_id FROM session_events
         WHERE ref_path = ? AND kind = 'continuity.skeleton_generated'
         ORDER BY ts DESC, id DESC
         LIMIT 1`,
      )
      .get(ref_path);
    return row?.session_id ?? null;
  }

  listRecent(query: SessionEventQuery = {}): SessionEventRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.session_id) {
      conditions.push("session_id = ?");
      params.push(query.session_id);
    }
    if (query.kind_prefix) {
      conditions.push("kind LIKE ? ESCAPE '\\'");
      params.push(`${escapeLikePrefix(query.kind_prefix)}%`);
    }
    if (query.since) {
      conditions.push("ts >= ?");
      params.push(query.since);
    }
    params.push(query.limit ?? 100);
    const sql = `
      SELECT * FROM session_events
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `;
    return this.db.query(sql).all(...(params as never[])) as SessionEventRow[];
  }
}

import type { SessionNoteDraft, SessionNoteDraftStatus } from "@penumbra/api-contract";
import type { Database } from "bun:sqlite";

export type SessionNoteDraftRow = SessionNoteDraft;

export interface RegisterSessionNoteDraftInput {
  draft_id: string;
  session_id?: string | null;
  project_id?: string | null;
  period_key: string;
  skeleton_path: string;
  draft_path: string;
  note_path: string;
  handoff_id?: string | null;
  composed_at: string;
  composed_event_id?: number | null;
}

export interface SessionNoteDraftListInput {
  status?: SessionNoteDraftStatus;
  limit?: number;
}

export interface ApproveSessionNoteDraftInput {
  draft_id: string;
  body?: string;
  reviewed_at: string;
  review_event_id?: number | null;
}

export type ApproveSessionNoteDraftResult =
  | { ok: true; draft: SessionNoteDraftRow }
  | { ok: false; code: "conflict" | "not_found" };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(limit), MAX_LIMIT);
}

export class SessionNoteDrafts {
  constructor(private readonly db: Database) {}

  registerDraft(input: RegisterSessionNoteDraftInput): SessionNoteDraftRow {
    this.db
      .prepare(
        `INSERT INTO session_note_drafts (
          draft_id,
          session_id,
          project_id,
          period_key,
          skeleton_path,
          draft_path,
          note_path,
          handoff_id,
          status,
          composed_at,
          reviewed_at,
          composed_event_id,
          review_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, NULL, ?, NULL)`,
      )
      .run(
        input.draft_id,
        input.session_id ?? null,
        input.project_id ?? null,
        input.period_key,
        input.skeleton_path,
        input.draft_path,
        input.note_path,
        input.handoff_id ?? null,
        input.composed_at,
        input.composed_event_id ?? null,
      );
    const row = this.get(input.draft_id);
    if (!row) throw new Error(`session note draft insert failed: ${input.draft_id}`);
    return row;
  }

  get(draft_id: string): SessionNoteDraftRow | null {
    return (
      this.db
        .query<
          SessionNoteDraftRow,
          [string]
        >(`SELECT * FROM session_note_drafts WHERE draft_id = ?`)
        .get(draft_id) ?? null
    );
  }

  list(input: SessionNoteDraftListInput = {}): SessionNoteDraftRow[] {
    const limit = boundedLimit(input.limit);
    if (input.status) {
      return this.db
        .query<SessionNoteDraftRow, [SessionNoteDraftStatus, number]>(
          `SELECT * FROM session_note_drafts
           WHERE status = ?
           ORDER BY composed_at ASC, draft_id ASC
           LIMIT ?`,
        )
        .all(input.status, limit);
    }
    return this.db
      .query<SessionNoteDraftRow, [number]>(
        `SELECT * FROM session_note_drafts
         ORDER BY composed_at ASC, draft_id ASC
         LIMIT ?`,
      )
      .all(limit);
  }

  supersedeAwaitingForPeriod(period_key: string, except_draft_id: string): number {
    const reviewedAt = new Date().toISOString();
    return this.db
      .prepare(
        `UPDATE session_note_drafts
         SET status = 'rejected', reviewed_at = ?
         WHERE period_key = ?
           AND status = 'awaiting_approval'
           AND draft_id <> ?`,
      )
      .run(reviewedAt, period_key, except_draft_id).changes;
  }

  approve(input: ApproveSessionNoteDraftInput): ApproveSessionNoteDraftResult {
    const status: Extract<SessionNoteDraftStatus, "approved" | "edited"> =
      input.body === undefined ? "approved" : "edited";
    const result = this.db
      .prepare(
        `UPDATE session_note_drafts
         SET status = ?, reviewed_at = ?, review_event_id = ?
         WHERE draft_id = ? AND status = 'awaiting_approval'`,
      )
      .run(status, input.reviewed_at, input.review_event_id ?? null, input.draft_id);
    if (result.changes === 1) {
      const row = this.get(input.draft_id);
      if (!row) throw new Error(`session note draft disappeared after approve: ${input.draft_id}`);
      return { ok: true, draft: row };
    }
    if (this.get(input.draft_id)) return { ok: false, code: "conflict" };
    return { ok: false, code: "not_found" };
  }

  revertApproval(draft_id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE session_note_drafts
         SET status = 'awaiting_approval', reviewed_at = NULL, review_event_id = NULL
         WHERE draft_id = ?
           AND status IN ('approved', 'edited')
           AND review_event_id IS NULL`,
      )
      .run(draft_id);
    return result.changes === 1;
  }

  setReviewEventId(draft_id: string, review_event_id: number): SessionNoteDraftRow {
    this.db
      .prepare(`UPDATE session_note_drafts SET review_event_id = ? WHERE draft_id = ?`)
      .run(review_event_id, draft_id);
    const row = this.get(draft_id);
    if (!row) throw new Error(`session note draft disappeared after event stamp: ${draft_id}`);
    return row;
  }
}

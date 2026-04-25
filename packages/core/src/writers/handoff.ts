import type { Database } from 'bun:sqlite';
import type { CreateHandoffRequest } from '../schemas/handoff.js';

export interface HandoffWriterOpts { db: Database }

export interface CreateHandoffParams extends CreateHandoffRequest {
  handoff_id: string;
  ts: string;
}

export interface ApproveOpts {
  resolved_by: string;
  resolved_at: string;
  redirect_to?: string;
}

export interface ApproveResult {
  status: 'approved' | 'redirected' | 'rejected';
  redirected_to: string | null;
}

export class HandoffWriter {
  private readonly db: Database;
  constructor(opts: HandoffWriterOpts) {
    this.db = opts.db;
  }

  create(params: CreateHandoffParams): string {
    this.db
      .query<unknown, [string, string, string | null, string, string, string, string | null, string, string | null]>(
        `INSERT INTO handoffs (
          handoff_id, ts, project_id, conversation_id,
          from_agent, to_agent, to_role, message, status, triggered_by_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        params.handoff_id, params.ts, params.project_id ?? null,
        params.conversation_id, params.from, params.to, params.to_role ?? null,
        params.message, params.triggered_by_event_id,
      );
    return params.handoff_id;
  }

  approve(handoff_id: string, opts: ApproveOpts): ApproveResult {
    const status = opts.redirect_to ? 'redirected' : 'approved';
    const redirected_to = opts.redirect_to ?? null;
    const changes = this.db
      .query<unknown, [string, string, string, string | null, string]>(
        `UPDATE handoffs
            SET status=?, resolved_by=?, resolved_at=?, redirected_to=?
          WHERE handoff_id=? AND status='pending'`,
      )
      .run(status, opts.resolved_by, opts.resolved_at, redirected_to, handoff_id);
    if (changes.changes === 0) {
      throw new Error(`conflict: handoff ${handoff_id} is not pending`);
    }
    return { status, redirected_to };
  }

  reject(handoff_id: string, opts: { resolved_by: string; resolved_at: string; reason?: string }): void {
    const changes = this.db
      .query<unknown, [string, string, string]>(
        `UPDATE handoffs SET status='rejected', resolved_by=?, resolved_at=? WHERE handoff_id=? AND status='pending'`,
      )
      .run(opts.resolved_by, opts.resolved_at, handoff_id);
    if (changes.changes === 0) {
      throw new Error(`conflict: handoff ${handoff_id} is not pending`);
    }
  }

  /** Atomically claim approved → dispatched. Returns true if this caller won. */
  claimDispatch(handoff_id: string): boolean {
    const changes = this.db
      .query<unknown, [string]>(
        `UPDATE handoffs SET status='dispatched' WHERE handoff_id=? AND status IN ('approved','redirected')`,
      )
      .run(handoff_id);
    return changes.changes > 0;
  }

  markCompleted(handoff_id: string): void {
    this.db
      .query<unknown, [string]>(
        `UPDATE handoffs SET status='completed' WHERE handoff_id=? AND status='dispatched'`,
      )
      .run(handoff_id);
  }
}

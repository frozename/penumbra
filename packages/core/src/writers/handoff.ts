import type { Database } from 'bun:sqlite';
import type { CreateHandoffRequest, HandoffRow } from '../schemas/handoff.js';
import type { HandoffEventBus } from '../events/handoff-events.js';

export interface HandoffWriterOpts { db: Database; events?: HandoffEventBus }

export interface CreateHandoffParams extends CreateHandoffRequest {
  handoff_id: string;
  ts: string;
}

export interface CreateApprovedParams {
  handoff_id: string;
  ts: string;
  project_id: string | null;
  conversation_id: string;
  from: string;
  to: string;
  to_role: string | null;
  message: string;
  triggered_by_event_id: string | null;
  resolved_by: string;
  resolved_at: string | null;
  chain_max_hops: number | null;
  chain_trust_mode: 'all' | 'config' | null;
  chain_task_type: string | null;
  use_worktree: boolean | null;
  parent_handoff_id: string | null;
  branch_base?: string | null;
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
  private readonly events: HandoffEventBus | undefined;
  constructor(opts: HandoffWriterOpts) {
    this.db = opts.db;
    this.events = opts.events;
  }

  create(params: CreateHandoffParams): string {
    const root_handoff_id = this.resolveRootHandoffId(params.handoff_id, params.parent_handoff_id ?? null);
    this.db
      .query<unknown, [string, string, string | null, string, string, string, string | null, string, string | null, number | null, string | null, string | null, string]>(
        `INSERT INTO handoffs (
          handoff_id, ts, project_id, conversation_id,
          from_agent, to_agent, to_role, message, status, triggered_by_event_id, use_worktree, parent_handoff_id, chain_task_type, root_handoff_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        params.handoff_id, params.ts, params.project_id ?? null,
        params.conversation_id, params.from, params.to, params.to_role ?? null,
        params.message, params.triggered_by_event_id,
        params.use_worktree ? 1 : (params.use_worktree === false ? 0 : null),
        params.parent_handoff_id ?? null,
        params.chain_task_type ?? null,
        root_handoff_id,
      );
    return params.handoff_id;
  }

  createApproved(params: CreateApprovedParams): string {
    const root_handoff_id = this.resolveRootHandoffId(params.handoff_id, params.parent_handoff_id ?? null);
    this.db
      .query<unknown, [string, string, string | null, string, string, string, string | null, string, string, string | null, number | null, string | null, string | null, number | null, string | null, string | null, string | null, string]>(
        `INSERT INTO handoffs (
          handoff_id, ts, project_id, conversation_id,
          from_agent, to_agent, to_role, message, status,
          resolved_by, resolved_at, chain_max_hops, chain_trust_mode, triggered_by_event_id, use_worktree, parent_handoff_id, chain_task_type, branch_base, root_handoff_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.handoff_id, params.ts, params.project_id, params.conversation_id,
        params.from, params.to, params.to_role, params.message,
        params.resolved_by, params.resolved_at,
        params.chain_max_hops, params.chain_trust_mode, params.triggered_by_event_id,
        params.use_worktree ? 1 : (params.use_worktree === false ? 0 : null),
        params.parent_handoff_id ?? null,
        params.chain_task_type ?? null,
        params.branch_base ?? null,
        root_handoff_id,
      );
    if (this.events) {
      const row = this.db.query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`).get(params.handoff_id);
      if (row) this.events.emit(row);
    }
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
    if (this.events) {
      const row = this.db
        .query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
        .get(handoff_id);
      if (row) this.events.emit(row);
    }
    return { status, redirected_to };
  }

  reject(handoff_id: string, opts: { resolved_by: string; resolved_at: string; reason?: string }): void {
    const changes = this.db
      .query<unknown, [string, string, string | null, string]>(
        `UPDATE handoffs SET status='rejected', resolved_by=?, resolved_at=?, resolution_reason=? WHERE handoff_id=? AND status='pending'`,
      )
      .run(opts.resolved_by, opts.resolved_at, opts.reason ?? null, handoff_id);
    if (changes.changes === 0) {
      throw new Error(`conflict: handoff ${handoff_id} is not pending`);
    }
  }

  /** Atomically transitions any non-terminal status (pending, approved, redirected, dispatched) → failed. */
  markFailed(handoff_id: string, opts: { reason: string; ts?: string; resolved_by?: string }): boolean {
    const ts = opts.ts ?? new Date().toISOString();
    const changes = this.db
      .query<unknown, [string, string | null, string, string]>(
        `UPDATE handoffs
            SET status='failed', resolution_reason=?, resolved_by=?, resolved_at=?
          WHERE handoff_id=? AND status NOT IN ('completed', 'rejected', 'failed')`,
      )
      .run(opts.reason, opts.resolved_by ?? null, ts, handoff_id);

    return changes.changes > 0;
  }

  /** Atomically claim approved → dispatched. Returns true if this caller won. */
  claimDispatch(handoff_id: string, worker_id: string): boolean {
    const changes = this.db
      .query<unknown, [string, string]>(
        `UPDATE handoffs SET status='dispatched', worker_id=? WHERE handoff_id=? AND status IN ('approved','redirected')`,
      )
      .run(worker_id, handoff_id);
    return changes.changes > 0;
  }

  /** Atomically dispatched → completed. Returns true if this caller won (i.e. the row was actually transitioned). */
  markCompleted(handoff_id: string, opts: { ts?: string } = {}): boolean {
    const ts = opts.ts ?? new Date().toISOString();
    const changes = this.db
      .query<unknown, [string, string]>(
        `UPDATE handoffs
            SET status='completed', resolved_at=?
          WHERE handoff_id=? AND status='dispatched' AND cancel_requested_at IS NULL`,
      )
      .run(ts, handoff_id);
    return changes.changes > 0;
  }

  private resolveRootHandoffId(handoff_id: string, parent_handoff_id: string | null): string {
    if (parent_handoff_id == null) return handoff_id;
    const parent = this.db
      .query<{ root_handoff_id: string | null }, [string]>(
        `SELECT root_handoff_id FROM handoffs WHERE handoff_id = ?`,
      )
      .get(parent_handoff_id);
    if (parent == null) {
      console.warn('[handoff-writer] orphaned parent fallback: ' + handoff_id);
      return handoff_id;
    }
    return parent.root_handoff_id ?? handoff_id;
  }

  /** Marks all handoffs in a conversation as cancel-requested. */
  requestCancellation(conversation_id: string, ts: string): boolean {
    const changes = this.db
      .query<unknown, [string, string]>(
        `UPDATE handoffs SET cancel_requested_at=? WHERE conversation_id=? AND cancel_requested_at IS NULL`,
      )
      .run(ts, conversation_id);
    return changes.changes > 0;
  }
}

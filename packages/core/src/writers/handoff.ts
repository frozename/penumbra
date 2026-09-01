import type { Database } from "bun:sqlite";

import type { HandoffEventBus } from "../events/handoff-events.js";
import type { HandoffTransitionBus, LeftDispatchedEvent } from "../events/handoff-transitions.js";
import type { CreateHandoffRequest, HandoffRow } from "../schemas/handoff.js";
type SqlParam = string | number | null;
type DispatchedExitStatus = "approved" | "completed" | "failed" | "expired";
export interface HandoffWriterOpts {
  db: Database;
  events?: HandoffEventBus;
  transitions?: HandoffTransitionBus;
}
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
  requested_agent?: string | null;
  routing_resolution_reason?: string | null;
  message: string;
  triggered_by_event_id: string | null;
  resolved_by: string;
  resolved_at: string | null;
  chain_max_hops: number | null;
  chain_trust_mode: "all" | "config" | null;
  chain_task_type: string | null;
  dispatch_kind?: "long_lived_tick" | "workflow" | "thought_analyzer" | "orchestrate" | null;
  long_lived_agent_id?: string | null;
  long_lived_tick_id?: string | null;
  use_worktree: boolean | null;
  isolated_install?: boolean | null;
  open_pr_on_review?: boolean | null;
  parent_handoff_id: string | null;
  branch_base?: string | null;
  branch_name?: string | null;
  workflow_run_id?: string | null;
  max_dispatch_attempts?: number | null;
}
export interface ApproveOpts {
  resolved_by: string;
  resolved_at: string;
  redirect_to?: string;
}
export interface ApproveResult {
  status: "approved" | "redirected" | "rejected";
  redirected_to: string | null;
}
export class HandoffWriter {
  private readonly db: Database;
  private readonly events: HandoffEventBus | undefined;
  private readonly transitions: HandoffTransitionBus | undefined;
  private syncTransitionInOwnedTransactionDepth = 0;
  constructor(opts: HandoffWriterOpts) {
    this.db = opts.db;
    this.events = opts.events;
    this.transitions = opts.transitions;
  }
  create(params: CreateHandoffParams): string {
    const root_handoff_id = this.resolveRootHandoffId(
      params.handoff_id,
      params.parent_handoff_id ?? null,
    );
    this.db
      .query<
        unknown,
        [
          string,
          string,
          string | null,
          string,
          string,
          string,
          string | null,
          string,
          string | null,
          number | null,
          number | null,
          string | null,
          string | null,
          string | null,
          number | null,
          string | null,
          string,
        ]
      >(
        `INSERT INTO handoffs (
          handoff_id, ts, project_id, conversation_id,
          from_agent, to_agent, to_role, message, status, triggered_by_event_id, use_worktree, isolated_install, parent_handoff_id, chain_task_type, branch_base, chain_max_hops, branch_name, root_handoff_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.handoff_id,
        params.ts,
        params.project_id ?? null,
        params.conversation_id,
        params.from,
        params.to,
        params.to_role ?? null,
        params.message,
        params.triggered_by_event_id,
        params.use_worktree ? 1 : params.use_worktree === false ? 0 : null,
        params.isolated_install === true ? 1 : params.isolated_install === false ? 0 : null,
        params.parent_handoff_id ?? null,
        params.chain_task_type ?? null,
        params.branch_base ?? null,
        params.chain_max_hops ?? null,
        params.branch_name ?? null,
        root_handoff_id,
      );
    return params.handoff_id;
  }

  createApproved(params: CreateApprovedParams): string {
    const root_handoff_id = this.resolveRootHandoffId(
      params.handoff_id,
      params.parent_handoff_id ?? null,
    );
    this.db
      .query<
        unknown,
        [
          string,
          string,
          string | null,
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
          string,
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          number | null,
          "all" | "config" | null,
          string | null,
          number | null,
          number | null,
          number | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string,
          string | null,
          number | null,
        ]
      >(
        `INSERT INTO handoffs (
          handoff_id, ts, project_id, conversation_id,
          from_agent, to_agent, to_role, requested_agent, routing_resolution_reason, message, status,
          resolved_by, resolved_at, dispatch_kind, long_lived_agent_id, long_lived_tick_id, chain_max_hops, chain_trust_mode, triggered_by_event_id, use_worktree, isolated_install, open_pr_on_review, parent_handoff_id, chain_task_type, branch_base, branch_name, root_handoff_id, workflow_run_id, max_dispatch_attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.handoff_id,
        params.ts,
        params.project_id,
        params.conversation_id,
        params.from,
        params.to,
        params.to_role,
        params.requested_agent ?? null,
        params.routing_resolution_reason ?? null,
        params.message,
        params.resolved_by,
        params.resolved_at,
        params.dispatch_kind ?? null,
        params.long_lived_agent_id ?? null,
        params.long_lived_tick_id ?? null,
        params.chain_max_hops,
        params.chain_trust_mode,
        params.triggered_by_event_id,
        params.use_worktree ? 1 : params.use_worktree === false ? 0 : null,
        params.isolated_install === true ? 1 : params.isolated_install === false ? 0 : null,
        params.open_pr_on_review === true ? 1 : params.open_pr_on_review === false ? 0 : null,
        params.parent_handoff_id ?? null,
        params.chain_task_type ?? null,
        params.branch_base ?? null,
        params.branch_name ?? null,
        root_handoff_id,
        params.workflow_run_id ?? null,
        params.max_dispatch_attempts ?? 3,
      );
    if (this.events) {
      const row = this.db
        .query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
        .get(params.handoff_id);
      if (row) this.events.emit(row);
    }
    return params.handoff_id;
  }
  approve(handoff_id: string, opts: ApproveOpts): ApproveResult {
    const status = opts.redirect_to ? "redirected" : "approved";
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

  reject(
    handoff_id: string,
    opts: { resolved_by: string; resolved_at: string; reason?: string },
  ): void {
    const changes = this.db
      .query<
        unknown,
        [string, string, string | null, string]
      >(`UPDATE handoffs SET status='rejected', resolved_by=?, resolved_at=?, resolution_reason=? WHERE handoff_id=? AND status='pending'`)
      .run(opts.resolved_by, opts.resolved_at, opts.reason ?? null, handoff_id);
    if (changes.changes === 0) {
      throw new Error(`conflict: handoff ${handoff_id} is not pending`);
    }
  }
  /** The only dispatched-exit status writer. Emits synchronously outside a transaction; inside one, defers and verifies commit so rollbacks emit nothing. */
  private exitDispatched(args: {
    handoff_id: string;
    extraSet: string;
    setParams: SqlParam[];
    extraWhere?: string;
    extraParams?: SqlParam[];
    to_status: DispatchedExitStatus;
    ts: string;
  }): boolean {
    const row = this.db
      .query<
        { to_agent: string },
        SqlParam[]
      >(`UPDATE handoffs SET status=?${args.extraSet ? ", " + args.extraSet : ""} WHERE handoff_id=? AND status='dispatched' ${args.extraWhere ?? ""} RETURNING to_agent`)
      .get(args.to_status, ...args.setParams, args.handoff_id, ...(args.extraParams ?? []));
    if (!row) return false;
    const evt: LeftDispatchedEvent = {
      kind: "left_dispatched",
      handoff_id: args.handoff_id,
      to_agent: row.to_agent,
      to_status: args.to_status,
      ts: args.ts,
    };
    if (!this.transitions) return true;
    if (!this.db.inTransaction || this.syncTransitionInOwnedTransactionDepth > 0) {
      this.transitions.emit(evt);
      return true;
    }
    queueMicrotask(() => {
      const cur = this.db
        .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id=?")
        .get(args.handoff_id);
      if (!cur || cur.status === "dispatched") return;
      this.transitions?.emit(evt);
    });
    return true;
  }
  /**
   * Atomically transitions any non-terminal status -> failed. Two arms: dispatched rows go through exitDispatched (emits left_dispatched); the general arm's WHERE excludes 'dispatched' by construction so it can never silently leave dispatched. The general arm still admits 'expired' -> failed (unchanged).
   */
  markFailed(
    handoff_id: string,
    opts: { reason: string; ts?: string; resolved_by?: string; expected_worker_id?: string },
  ): boolean {
    const ts = opts.ts ?? new Date().toISOString();
    const hadOuterTransaction = this.db.inTransaction;
    if (!hadOuterTransaction) this.syncTransitionInOwnedTransactionDepth++;
    try {
      return this.db.transaction(() => {
        const exited = this.exitDispatched({
          handoff_id,
          extraSet: "resolution_reason=?, resolved_by=?, resolved_at=?",
          setParams: [opts.reason, opts.resolved_by ?? null, ts],
          extraWhere: opts.expected_worker_id !== undefined ? "AND worker_id=?" : "",
          extraParams: opts.expected_worker_id !== undefined ? [opts.expected_worker_id] : [],
          to_status: "failed",
          ts,
        });
        if (exited) return true;

        if (opts.expected_worker_id !== undefined) {
          const changes = this.db
            .query<unknown, [string, string | null, string, string, string]>(
              `UPDATE handoffs
                  SET status='failed', resolution_reason=?, resolved_by=?, resolved_at=?
                WHERE handoff_id=? AND status NOT IN ('completed', 'rejected', 'failed', 'dispatched') AND worker_id=?`,
            )
            .run(opts.reason, opts.resolved_by ?? null, ts, handoff_id, opts.expected_worker_id);
          return changes.changes > 0;
        }
        const changes = this.db
          .query<unknown, [string, string | null, string, string]>(
            `UPDATE handoffs
                SET status='failed', resolution_reason=?, resolved_by=?, resolved_at=?
              WHERE handoff_id=? AND status NOT IN ('completed', 'rejected', 'failed', 'dispatched')`,
          )
          .run(opts.reason, opts.resolved_by ?? null, ts, handoff_id);
        return changes.changes > 0;
      })();
    } finally {
      if (!hadOuterTransaction) this.syncTransitionInOwnedTransactionDepth--;
    }
  }
  claimDispatch(
    handoff_id: string,
    worker_id: string,
    opts?: {
      workflow_run_id?: string | null;
      maxWorkflowSiblingsPerWorker?: number | null;
      providerSeatNames?: string[] | null;
      maxProviderInFlight?: number | null;
    },
  ): boolean {
    const last_dispatch_started_at = new Date().toISOString();
    const whereClauses = [
      "handoff_id=?",
      "status IN ('approved','redirected')",
      "dispatch_attempts < max_dispatch_attempts",
    ];
    const params: (string | number)[] = [worker_id, last_dispatch_started_at, handoff_id];

    if (
      opts?.workflow_run_id &&
      opts.maxWorkflowSiblingsPerWorker !== null &&
      opts.maxWorkflowSiblingsPerWorker !== undefined &&
      Number.isFinite(opts.maxWorkflowSiblingsPerWorker) &&
      opts.maxWorkflowSiblingsPerWorker >= 0
    ) {
      whereClauses.push(`(
            SELECT COUNT(*)
              FROM handoffs sibling
             WHERE sibling.dispatch_kind='workflow'
               AND sibling.workflow_run_id=?
               AND sibling.status='dispatched'
               AND sibling.worker_id=?
          ) < ?`);
      params.push(opts.workflow_run_id, worker_id, opts.maxWorkflowSiblingsPerWorker);
    }

    if (
      Array.isArray(opts?.providerSeatNames) &&
      opts.providerSeatNames.length > 0 &&
      opts.maxProviderInFlight !== null &&
      opts.maxProviderInFlight !== undefined &&
      Number.isFinite(opts.maxProviderInFlight) &&
      opts.maxProviderInFlight >= 0
    ) {
      const seatPlaceholders = opts.providerSeatNames.map(() => "?").join(",");
      whereClauses.push(`(
            SELECT COUNT(*)
              FROM handoffs provider_sibling
             WHERE provider_sibling.status='dispatched'
               AND provider_sibling.to_agent IN (${seatPlaceholders})
          ) < ?`);
      params.push(...opts.providerSeatNames, opts.maxProviderInFlight);
    }

    const changes = this.db
      .query<
        unknown,
        (string | number)[]
      >(`UPDATE handoffs SET status='dispatched', worker_id=?, dispatch_attempts = dispatch_attempts + 1, last_dispatch_started_at=? WHERE ${whereClauses.join(" AND ")}`)
      .run(...params);
    return changes.changes > 0;
  }
  recordBranchName(handoff_id: string, branch_name: string): boolean {
    const changes = this.db
      .query<unknown, [string, string]>(`UPDATE handoffs SET branch_name = ? WHERE handoff_id = ?`)
      .run(branch_name, handoff_id);
    return changes.changes > 0;
  }
  requeueOrphanedDispatch(handoffId: string, deadWorkerId: string): boolean {
    const ts = new Date().toISOString();
    return this.exitDispatched({
      handoff_id: handoffId,
      extraSet: "worker_id=NULL",
      setParams: [],
      extraWhere: "AND worker_id=?",
      extraParams: [deadWorkerId],
      to_status: "approved",
      ts,
    });
  }
  failOrphanedDispatchExhausted(handoffId: string, deadWorkerId: string): boolean {
    const ts = new Date().toISOString();
    const reason = "failed_worker_restart: attempts exhausted";
    return this.exitDispatched({
      handoff_id: handoffId,
      extraSet: "resolution_reason=?, resolved_at=?, worker_id=NULL",
      setParams: [reason, ts],
      extraWhere: "AND worker_id=?",
      extraParams: [deadWorkerId],
      to_status: "failed",
      ts,
    });
  }
  expireDispatchedIdle(
    handoff_id: string,
    opts: { ts: string; reason: string; activitySinceIso: string },
  ): boolean {
    return this.exitDispatched({
      handoff_id,
      extraSet: "resolved_at=?, resolution_reason=?",
      setParams: [opts.ts, opts.reason],
      extraWhere: "AND NOT EXISTS (SELECT 1 FROM dispatch_events WHERE handoff_id=? AND ts >= ?)",
      extraParams: [handoff_id, opts.activitySinceIso],
      to_status: "expired",
      ts: opts.ts,
    });
  }
  expirePendingOlderThan(opts: { olderThanIso: string; ts: string; reason: string }): number {
    const changes = this.db
      .query<
        unknown,
        [string, string, string]
      >(`UPDATE handoffs SET status='expired', resolved_at=?, resolution_reason=? WHERE status='pending' AND ts < ?`)
      .run(opts.ts, opts.reason, opts.olderThanIso);
    return changes.changes;
  }
  markCompleted(
    handoff_id: string,
    opts: { ts?: string; expected_worker_id?: string } = {},
  ): boolean {
    const ts = opts.ts ?? new Date().toISOString();
    return this.exitDispatched({
      handoff_id,
      extraSet: "resolved_at=?",
      setParams: [ts],
      extraWhere:
        opts.expected_worker_id !== undefined
          ? "AND cancel_requested_at IS NULL AND worker_id=?"
          : "AND cancel_requested_at IS NULL",
      extraParams: opts.expected_worker_id !== undefined ? [opts.expected_worker_id] : [],
      to_status: "completed",
      ts,
    });
  }
  private resolveRootHandoffId(handoff_id: string, parent_handoff_id: string | null): string {
    if (parent_handoff_id === null) return handoff_id;
    const parent = this.db
      .query<
        { root_handoff_id: string | null },
        [string]
      >(`SELECT root_handoff_id FROM handoffs WHERE handoff_id = ?`)
      .get(parent_handoff_id);
    if (!parent) {
      console.warn("[handoff-writer] orphaned parent fallback: " + handoff_id);
      return handoff_id;
    }
    return parent.root_handoff_id ?? parent_handoff_id;
  }
  /** Marks all handoffs in a conversation as cancel-requested. */
  requestCancellation(conversation_id: string, ts: string): boolean {
    const changes = this.db
      .query<
        unknown,
        [string, string]
      >(`UPDATE handoffs SET cancel_requested_at=? WHERE conversation_id=? AND cancel_requested_at IS NULL`)
      .run(ts, conversation_id);
    return changes.changes > 0;
  }
}

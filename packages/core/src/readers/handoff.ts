import type { Database } from "bun:sqlite";
import type { HandoffRow, HandoffStatus } from "../schemas/handoff.js";

export interface HandoffReaderOpts {
  db: Database;
}

function coerceBoolCol(v: unknown): boolean | null {
  if (v === 1) return true;
  if (v === 0) return false;
  if (v == null) return null;
  return v as boolean;
}

function normalizeHandoffRow(row: HandoffRow): HandoffRow {
  return {
    ...row,
    use_worktree: coerceBoolCol(row.use_worktree),
    isolated_install: coerceBoolCol(row.isolated_install) ?? undefined,
    open_pr_on_review: coerceBoolCol(row.open_pr_on_review) ?? undefined,
  };
}

export class HandoffReader {
  private readonly db: Database;
  constructor(opts: HandoffReaderOpts) {
    this.db = opts.db;
  }

  listPending(opts?: { conversation_id?: string }): HandoffRow[] {
    const orderByFairRootLoad = `ORDER BY (
      SELECT COUNT(*) FROM handoffs h2
      WHERE h2.status='dispatched' AND h2.root_handoff_id = h.root_handoff_id
    ) ASC,
    h.ts ASC`;
    // Correlated COUNT(*) keeps the claim queue fair while SQLite still uses
    // idx_handoffs_root_status for the dispatched-row lookup in EXPLAIN.
    if (opts?.conversation_id) {
      return this.db
        .query<
          HandoffRow,
          [string]
        >(`SELECT h.* FROM handoffs h WHERE h.status='pending' AND h.conversation_id=? ${orderByFairRootLoad}`)
        .all(opts.conversation_id)
        .map(normalizeHandoffRow);
    }
    return this.db
      .query<
        HandoffRow,
        []
      >(`SELECT h.* FROM handoffs h WHERE h.status='pending' ${orderByFairRootLoad}`)
      .all()
      .map(normalizeHandoffRow);
  }

  listByStatus(opts: {
    statuses: HandoffStatus[];
    conversation_id?: string;
    project_id?: string | null;
  }): HandoffRow[] {
    if (opts.statuses.length === 0) {
      throw new Error("listByStatus: statuses must not be empty");
    }

    const conditions = [`h.status IN (${opts.statuses.map(() => "?").join(",")})`];
    const params: Array<string> = [...opts.statuses];

    if (opts.conversation_id) {
      conditions.push("h.conversation_id=?");
      params.push(opts.conversation_id);
    }

    if (opts.project_id === null) {
      conditions.push("h.project_id IS NULL");
    } else if (typeof opts.project_id === "string") {
      conditions.push("h.project_id=?");
      params.push(opts.project_id);
    }

    const sql = `SELECT h.* FROM handoffs h WHERE ${conditions.join(" AND ")} ORDER BY (
      SELECT COUNT(*) FROM handoffs h2
      WHERE h2.status='dispatched' AND h2.root_handoff_id = h.root_handoff_id
    ) ASC,
    h.ts ASC`;
    return this.db
      .query<HandoffRow, string[]>(sql)
      .all(...params)
      .map(normalizeHandoffRow);
  }

  /** Returns dispatched rows whose worker_id is in the stale set. */
  listOrphanedDispatches(staleWorkerIds: string[], limit?: number): HandoffRow[] {
    if (staleWorkerIds.length === 0) return [];
    const placeholders = staleWorkerIds.map(() => "?").join(",");
    let sql = `SELECT * FROM handoffs WHERE status='dispatched' AND worker_id IN (${placeholders}) ORDER BY ts ASC`;
    if (limit != null) {
      sql += " LIMIT ?";
      return this.db
        .query<HandoffRow, (string | number)[]>(sql)
        .all(...staleWorkerIds, limit)
        .map(normalizeHandoffRow);
    }
    return this.db
      .query<HandoffRow, string[]>(sql)
      .all(...staleWorkerIds)
      .map(normalizeHandoffRow);
  }

  countCompletedSince(opts: { since: string; conversation_id?: string }): number {
    if (opts.conversation_id) {
      const row = this.db
        .query<{ count: number }, [string, string]>(
          `SELECT COUNT(*) AS count
             FROM handoffs
            WHERE status='completed'
              AND COALESCE(resolved_at, ts) >= ?
              AND conversation_id=?`,
        )
        .get(opts.since, opts.conversation_id);
      return row?.count ?? 0;
    }

    const row = this.db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
           FROM handoffs
          WHERE status='completed'
            AND COALESCE(resolved_at, ts) >= ?`,
      )
      .get(opts.since);
    return row?.count ?? 0;
  }

  get(handoff_id: string): HandoffRow | null {
    const row = this.db
      .query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
      .get(handoff_id);
    return row ? normalizeHandoffRow(row) : null;
  }

  getLatestForConversation(conversation_id: string): HandoffRow | null {
    const row = this.db
      .query<
        HandoffRow,
        [string]
      >(`SELECT * FROM handoffs WHERE conversation_id=? ORDER BY ts DESC LIMIT 1`)
      .get(conversation_id);
    return row ? normalizeHandoffRow(row) : null;
  }

  getRootForConversation(conversation_id: string): HandoffRow | null {
    const row = this.db
      .query<
        HandoffRow,
        [string]
      >(`SELECT * FROM handoffs WHERE conversation_id = ? AND parent_handoff_id IS NULL ORDER BY ts ASC LIMIT 1`)
      .get(conversation_id);
    return row ?? null;
  }

  /** Lists active handoffs (non-terminal) that have a cancel request. */
  listActiveCancellations(): Array<{ conversation_id: string; handoff_id: string }> {
    return this.db
      .query<{ conversation_id: string; handoff_id: string }, []>(
        `SELECT conversation_id, handoff_id FROM handoffs 
         WHERE cancel_requested_at IS NOT NULL 
         AND status NOT IN ('completed', 'rejected', 'failed')`,
      )
      .all();
  }

  /**
   * Walks parent_handoff_id upward, counting hops until a root handoff
   * (parent_handoff_id IS NULL) is reached. Caps at SPAWN_DEPTH_SANITY_CAP
   * (64) to defend against malformed cycles. Returns 0 for root handoffs
   * and for unknown handoff_ids.
   *
   * Used by chain.start to enforce a cumulative recursion depth cap on
   * ACP-spawned chains.
   */
  getSpawnDepth(handoff_id: string): number {
    const SPAWN_DEPTH_SANITY_CAP = 64;
    const stmt = this.db.query<{ parent_handoff_id: string | null }, [string]>(
      `SELECT parent_handoff_id FROM handoffs WHERE handoff_id=?`,
    );
    let cur: string = handoff_id;
    for (let i = 0; i < SPAWN_DEPTH_SANITY_CAP; i++) {
      const row = stmt.get(cur);
      if (!row || !row.parent_handoff_id) return i;
      cur = row.parent_handoff_id;
    }
    return SPAWN_DEPTH_SANITY_CAP;
  }
}

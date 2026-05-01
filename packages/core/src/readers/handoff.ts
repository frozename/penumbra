import type { Database } from 'bun:sqlite';
import type { HandoffRow, HandoffStatus } from '../schemas/handoff.js';

export interface HandoffReaderOpts { db: Database }

export class HandoffReader {
  private readonly db: Database;
  constructor(opts: HandoffReaderOpts) { this.db = opts.db; }

  listPending(opts?: { conversation_id?: string }): HandoffRow[] {
    if (opts?.conversation_id) {
      return this.db
        .query<HandoffRow, [string]>(
          `SELECT * FROM handoffs WHERE status='pending' AND conversation_id=? ORDER BY ts ASC`,
        )
        .all(opts.conversation_id);
    }
    return this.db
      .query<HandoffRow, []>(
        `SELECT * FROM handoffs WHERE status='pending' ORDER BY ts ASC`,
      )
      .all();
  }

  listByStatus(opts: { statuses: HandoffStatus[]; conversation_id?: string }): HandoffRow[] {
    if (opts.statuses.length === 0) {
      throw new Error('listByStatus: statuses must not be empty');
    }
    const placeholders = opts.statuses.map(() => '?').join(',');
    if (opts.conversation_id) {
      const sql = `SELECT * FROM handoffs WHERE status IN (${placeholders}) AND conversation_id=? ORDER BY ts ASC`;
      return this.db.query<HandoffRow, string[]>(sql).all(...opts.statuses, opts.conversation_id);
    }
    const sql = `SELECT * FROM handoffs WHERE status IN (${placeholders}) ORDER BY ts ASC`;
    return this.db.query<HandoffRow, string[]>(sql).all(...opts.statuses);
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
    return row ?? null;
  }

  getLatestForConversation(conversation_id: string): HandoffRow | null {
    const row = this.db
      .query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE conversation_id=? ORDER BY ts DESC LIMIT 1`)
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

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

  get(handoff_id: string): HandoffRow | null {
    const row = this.db
      .query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
      .get(handoff_id);
    return row ?? null;
  }

  /** Lists conversation IDs that have an active (non-terminal) handoff with a cancel request. */
  listActiveCancellations(): string[] {
    return this.db
      .query<{ conversation_id: string }, []>(
        `SELECT DISTINCT conversation_id FROM handoffs 
         WHERE cancel_requested_at IS NOT NULL 
         AND status NOT IN ('completed', 'rejected', 'failed')`,
      )
      .all()
      .map((r) => r.conversation_id);
  }
}

import type { Database } from 'bun:sqlite';
import type { HandoffRow } from '../schemas/handoff.js';

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

  get(handoff_id: string): HandoffRow | null {
    const row = this.db
      .query<HandoffRow, [string]>(`SELECT * FROM handoffs WHERE handoff_id=?`)
      .get(handoff_id);
    return row ?? null;
  }
}

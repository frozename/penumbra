import type { Database } from "bun:sqlite";

export type NotificationOutboxKind =
  | "task_draft"
  | "task_draft_escalation"
  | "pending_action_created"
  | "pending_action_expired";

export interface NotificationOutboxEntry {
  id: number;
  project_id: string | null;
  kind: NotificationOutboxKind;
  reference_id: string;
  summary: string | null;
  payload_json: string;
  status: string;
  created_at: number;
  coalesce_key: string;
  attempted_at: number | null;
  completed_at: number | null;
  error: string | null;
  attempt_count: number;
  deliver_after: number | null;
}

export class NotificationOutboxWriter {
  private readonly insert;
  private readonly selectByKindRef;

  constructor(private readonly db: Database) {
    this.insert = db.prepare(`
      INSERT INTO notification_outbox (project_id, kind, reference_id, summary, payload_json, status, created_at, coalesce_key)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(kind, reference_id) DO NOTHING
    `);
    this.selectByKindRef = db.prepare(
      `SELECT id FROM notification_outbox WHERE kind = ? AND reference_id = ?`,
    );
  }

  enqueue(input: {
    project_id: string | null;
    kind: NotificationOutboxKind;
    reference_id: string;
    summary?: string;
    payload?: Record<string, unknown>;
    created_at: number;
  }): void {
    const coalesceKey = input.project_id ?? "_default";
    this.insert.run(
      input.project_id,
      input.kind,
      input.reference_id,
      input.summary ?? null,
      JSON.stringify(input.payload ?? {}),
      input.created_at,
      coalesceKey,
    );
  }

  listPending(limit: number): NotificationOutboxEntry[] {
    return this.db
      .query<
        NotificationOutboxEntry,
        [number]
      >(`SELECT * FROM notification_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`)
      .all(limit);
  }

  listPendingBeforeCutoff(cutoffMs: number, limit: number): NotificationOutboxEntry[] {
    return this.db
      .query<
        NotificationOutboxEntry,
        [number, number]
      >(`SELECT * FROM notification_outbox WHERE status = 'pending' AND created_at < ? ORDER BY created_at ASC LIMIT ?`)
      .all(cutoffMs, limit);
  }

  markProcessing(id: number, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE notification_outbox
            SET status = 'processing',
                attempted_at = ?,
                attempt_count = attempt_count + 1,
                deliver_after = NULL
          WHERE id = ?
            AND status = 'pending'`,
      )
      .run(now, id);
    return result.changes === 1;
  }

  requeueStaleProcessing(staleBefore: number): number {
    const result = this.db
      .prepare(
        `UPDATE notification_outbox
            SET status = 'pending'
          WHERE status = 'processing'
            AND attempted_at IS NOT NULL
            AND attempted_at <= ?`,
      )
      .run(staleBefore);
    return result.changes;
  }

  markDone(id: number, now: number): void {
    this.db
      .prepare(
        `UPDATE notification_outbox
            SET status = 'done',
                completed_at = ?,
                error = NULL,
                deliver_after = NULL
          WHERE id = ?`,
      )
      .run(now, id);
  }

  markFailed(id: number, now: number, error: string): void {
    this.db
      .prepare(
        `UPDATE notification_outbox
            SET status = 'failed',
                completed_at = ?,
                error = ?,
                deliver_after = NULL
          WHERE id = ?`,
      )
      .run(now, error, id);
  }

  markRetry(id: number, error: string, deliverAfter: number): void {
    this.db
      .prepare(
        `UPDATE notification_outbox
            SET status = 'pending',
                completed_at = NULL,
                error = ?,
                deliver_after = ?
          WHERE id = ?`,
      )
      .run(error, deliverAfter, id);
  }

  exists(kind: string, referenceId: string): boolean {
    const row = this.selectByKindRef.get(kind, referenceId) as { id: number } | null;
    return row != null;
  }
}

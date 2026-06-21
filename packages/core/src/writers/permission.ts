import type { Database } from "bun:sqlite";

import type { ApprovePermissionRequest, PermissionRequestRow } from "../schemas/permission.js";

export interface PermissionWriterOpts {
  db: Database;
}

export interface CreatePermissionInput {
  permission_id: string;
  parent_handoff_id: string;
  conversation_id: string;
  agent_name: string;
  tool_name: string;
  raw_input: unknown;
  ttl_seconds: number;
  now: Date;
}

export interface DecidePermissionInput {
  decision: "approve" | "reject";
  remember?: ApprovePermissionRequest["remember"];
  decided_by: string;
  decided_at: string;
  reason: string | null;
}

export class PermissionWriter {
  private readonly db: Database;
  constructor(opts: PermissionWriterOpts) {
    this.db = opts.db;
  }

  /**
   * Insert a new pending permission_requests row, OR return the existing row
   * if the permission_id already exists (idempotent). Returns {row, created}
   * so callers (e.g., the daemon route) can branch on whether this call
   * actually created a fresh row vs. observed an idempotent re-POST.
   *
   * The idempotency check is SELECT-then-INSERT under bun:sqlite's
   * single-connection serialization; safe under our current daemon model.
   */
  create(input: CreatePermissionInput): { row: PermissionRequestRow; created: boolean } {
    const created_at = input.now.toISOString();
    const ttl_at = new Date(input.now.getTime() + input.ttl_seconds * 1000).toISOString();
    const raw_input_json = JSON.stringify(input.raw_input ?? null);

    // Idempotent: if a row exists with this permission_id, return it unchanged.
    const existing = this.db
      .query<
        PermissionRequestRow,
        [string]
      >(`SELECT * FROM permission_requests WHERE permission_id=?`)
      .get(input.permission_id);
    if (existing) return { row: existing, created: false };

    this.db
      .query<unknown, [string, string, string, string, string, string, string, string]>(
        `INSERT INTO permission_requests
           (permission_id, parent_handoff_id, conversation_id, agent_name,
            tool_name, raw_input_json, status, ttl_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.permission_id,
        input.parent_handoff_id,
        input.conversation_id,
        input.agent_name,
        input.tool_name,
        raw_input_json,
        ttl_at,
        created_at,
      );

    const row = this.db
      .query<
        PermissionRequestRow,
        [string]
      >(`SELECT * FROM permission_requests WHERE permission_id=?`)
      .get(input.permission_id);
    if (!row)
      throw new Error(`PermissionWriter.create: row vanished after insert: ${input.permission_id}`);
    return { row, created: true };
  }

  /** Atomic CAS: pending → approved|rejected. Returns the row or null if not pending. */
  decide(permission_id: string, input: DecidePermissionInput): PermissionRequestRow | null {
    const status = input.decision === "approve" ? "approved" : "rejected";
    const updated = this.db
      .query<unknown, [string, string | null, string | null, string, string, string]>(
        `UPDATE permission_requests
            SET status=?, remember_scope=?, decision_reason=?, decided_by=?, decided_at=?
          WHERE permission_id=? AND status='pending'`,
      )
      .run(
        status,
        input.remember ?? null,
        input.reason,
        input.decided_by,
        input.decided_at,
        permission_id,
      );
    if (updated.changes === 0) return null;
    return this.db
      .query<
        PermissionRequestRow,
        [string]
      >(`SELECT * FROM permission_requests WHERE permission_id=?`)
      .get(permission_id);
  }

  /** Atomic CAS: all pending rows with ttl_at <= now → expired. Returns count transitioned. */
  expirePastDue(now_iso: string): number {
    const updated = this.db
      .query<unknown, [string, string]>(
        `UPDATE permission_requests
            SET status='expired', decided_at=?
          WHERE status='pending' AND ttl_at <= ?`,
      )
      .run(now_iso, now_iso);
    return updated.changes;
  }
}

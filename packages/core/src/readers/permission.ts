import type { Database } from "bun:sqlite";
import type { PermissionRequestRow, PermissionStatus } from "../schemas/permission.js";

export interface PermissionReaderOpts {
  db: Database;
}

export class PermissionReader {
  private readonly db: Database;
  constructor(opts: PermissionReaderOpts) {
    this.db = opts.db;
  }

  get(permission_id: string): PermissionRequestRow | null {
    const row = this.db
      .query<
        PermissionRequestRow,
        [string]
      >(`SELECT * FROM permission_requests WHERE permission_id=?`)
      .get(permission_id);
    return row ?? null;
  }

  listByStatus(opts: {
    statuses: PermissionStatus[];
    conversation_id?: string;
    parent_handoff_id?: string;
  }): PermissionRequestRow[] {
    if (opts.statuses.length === 0) {
      throw new Error("PermissionReader.listByStatus: statuses must not be empty");
    }
    const placeholders = opts.statuses.map(() => "?").join(",");
    const where: string[] = [`status IN (${placeholders})`];
    const params: string[] = [...opts.statuses];
    if (opts.conversation_id) {
      where.push("conversation_id=?");
      params.push(opts.conversation_id);
    }
    if (opts.parent_handoff_id) {
      where.push("parent_handoff_id=?");
      params.push(opts.parent_handoff_id);
    }
    const sql = `SELECT * FROM permission_requests WHERE ${where.join(" AND ")} ORDER BY created_at ASC`;
    return this.db.query<PermissionRequestRow, string[]>(sql).all(...params);
  }
}

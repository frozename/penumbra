import type { Database } from 'bun:sqlite';
import type { PermissionRequestRow } from '../schemas/permission.js';

export interface PermissionReaderOpts { db: Database }

export class PermissionReader {
  private readonly db: Database;
  constructor(opts: PermissionReaderOpts) { this.db = opts.db; }

  get(permission_id: string): PermissionRequestRow | null {
    const row = this.db
      .query<PermissionRequestRow, [string]>(`SELECT * FROM permission_requests WHERE permission_id=?`)
      .get(permission_id);
    return row ?? null;
  }
}

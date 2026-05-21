import type { Database } from 'bun:sqlite';
import { randomBytes, createHash } from 'node:crypto';

export interface WorkerTokenRow {
  token_hash: string;
  worker_id: string;
  issued_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  metadata_json: string | null;
}

export interface IssueArgs {
  worker_id: string;
  metadata?: Record<string, unknown>;
}

export interface IssueResult {
  token: string;
  token_hash: string;
}

export class WorkerTokenStore {
  constructor(private readonly db: Database) {}

  issue(args: IssueArgs, nowMs: number): IssueResult {
    const token = randomBytes(32).toString('base64url');
    const token_hash = createHash('sha256').update(token).digest('hex');
    const metadata_json = args.metadata != null ? JSON.stringify(args.metadata) : null;

    this.db.run(
      `INSERT INTO worker_tokens (token_hash, worker_id, issued_at, last_seen_at, revoked_at, metadata_json)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      [token_hash, args.worker_id, nowMs, nowMs, metadata_json],
    );

    return { token, token_hash };
  }

  lookup(plaintextToken: string): WorkerTokenRow | null {
    const token_hash = createHash('sha256').update(plaintextToken).digest('hex');
    return (
      this.db
        .query<WorkerTokenRow, [string]>(
          `SELECT token_hash, worker_id, issued_at, last_seen_at, revoked_at, metadata_json
           FROM worker_tokens
           WHERE token_hash = ? AND revoked_at IS NULL`,
        )
        .get(token_hash) ?? null
    );
  }

  touch(token_hash: string, nowMs: number): void {
    this.db.run(
      `UPDATE worker_tokens SET last_seen_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
      [nowMs, token_hash],
    );
  }

  revoke(token_hash: string, nowMs: number): void {
    this.db.run(
      `UPDATE worker_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
      [nowMs, token_hash],
    );
  }
}

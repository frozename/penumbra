import type { Database } from "bun:sqlite";

export interface MemoryEfficacyJobRow {
  job_id: string;
  ts_enqueued: string;
  ts_started: string | null;
  ts_finished: string | null;
  status: string;
  claimed_at: string | null;
  claimed_by: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  since_iso: string | null;
  reviews_dir: string;
  scanned: number | null;
  classified: number | null;
  skipped: number | null;
  error_message: string | null;
  enqueued_by: string | null;
}

export function enqueueMemoryEfficacyJob(
  db: Database,
  opts: { reviewsDir: string; sinceISO?: string; enqueuedBy?: string },
): { job_id: string } {
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO memory_efficacy_jobs (job_id, ts_enqueued, status, since_iso, reviews_dir, enqueued_by)
     VALUES (?, ?, 'queued', ?, ?, ?)`,
    [jobId, now, opts.sinceISO ?? null, opts.reviewsDir, opts.enqueuedBy ?? null],
  );
  return { job_id: jobId };
}

export function claimNextJob(
  db: Database,
  now: string,
  opts: { workerId: string; leaseTtlMs: number },
): { job_id: string; reviews_dir: string; since_iso: string | null } | null {
  const row = db.transaction(() => {
    const pending = db
      .query<{ job_id: string; reviews_dir: string; since_iso: string | null }, [string]>(
        `SELECT job_id, reviews_dir, since_iso
         FROM memory_efficacy_jobs
         WHERE status = 'queued'
            OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
         ORDER BY ts_enqueued ASC
         LIMIT 1`,
      )
      .get(now);
    if (!pending) return null;
    const leaseExpiresAt = new Date(Date.parse(now) + opts.leaseTtlMs).toISOString();
    const result = db.run(
      `UPDATE memory_efficacy_jobs
       SET status = 'running',
           ts_started = COALESCE(ts_started, ?),
           claimed_at = ?,
           claimed_by = ?,
           heartbeat_at = ?,
           lease_expires_at = ?
       WHERE job_id = ?
         AND (
           status = 'queued'
           OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
         )`,
      [now, now, opts.workerId, now, leaseExpiresAt, pending.job_id, now],
    );
    return result.changes > 0 ? pending : null;
  })();
  return row;
}

export function heartbeatJob(
  db: Database,
  jobId: string,
  workerId: string,
  now: string,
  opts: { leaseTtlMs: number },
): boolean {
  const leaseExpiresAt = new Date(Date.parse(now) + opts.leaseTtlMs).toISOString();
  const result = db.run(
    `UPDATE memory_efficacy_jobs
     SET heartbeat_at = ?, lease_expires_at = ?
     WHERE job_id = ? AND claimed_by = ? AND status = 'running'`,
    [now, leaseExpiresAt, jobId, workerId],
  );
  return result.changes > 0;
}

export function sweepStaleJobs(
  db: Database,
  now: string,
  opts?: { leaseTtlMs?: number },
): string[] {
  void opts;
  try {
    return db
      .query<{ job_id: string }, [string]>(
        `UPDATE memory_efficacy_jobs
         SET status = 'queued',
             ts_started = NULL,
             claimed_at = NULL,
             claimed_by = NULL,
             heartbeat_at = NULL,
             lease_expires_at = NULL
         WHERE status = 'running'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < ?
         RETURNING job_id`,
      )
      .all(now)
      .map((row) => row.job_id);
  } catch {
    db.run(
      `UPDATE memory_efficacy_jobs
       SET status = 'queued',
           ts_started = NULL,
           claimed_at = NULL,
           claimed_by = NULL,
           heartbeat_at = NULL,
           lease_expires_at = NULL
       WHERE status = 'running'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < ?`,
      [now],
    );
    return [];
  }
}

export function completeJob(
  db: Database,
  jobId: string,
  result: { scanned: number; classified: number; skipped: number } | { error: string },
  now: string,
  opts?: { workerId?: string },
): boolean {
  const workerId = opts?.workerId;
  if ("error" in result) {
    const sql = workerId
      ? `UPDATE memory_efficacy_jobs
         SET status = 'failed',
             ts_finished = ?,
             error_message = ?,
             claimed_at = NULL,
             claimed_by = NULL,
             heartbeat_at = NULL,
             lease_expires_at = NULL
         WHERE job_id = ? AND claimed_by = ? AND status = 'running'`
      : `UPDATE memory_efficacy_jobs
         SET status = 'failed',
             ts_finished = ?,
             error_message = ?,
             claimed_at = NULL,
             claimed_by = NULL,
             heartbeat_at = NULL,
             lease_expires_at = NULL
         WHERE job_id = ?`;
    const update = db.run(
      sql,
      workerId ? [now, result.error, jobId, workerId] : [now, result.error, jobId],
    );
    return update.changes > 0;
  } else {
    const sql = workerId
      ? `UPDATE memory_efficacy_jobs
         SET status = 'completed',
             ts_finished = ?,
             scanned = ?,
             classified = ?,
             skipped = ?,
             claimed_at = NULL,
             claimed_by = NULL,
             heartbeat_at = NULL,
             lease_expires_at = NULL
         WHERE job_id = ? AND claimed_by = ? AND status = 'running'`
      : `UPDATE memory_efficacy_jobs
         SET status = 'completed',
             ts_finished = ?,
             scanned = ?,
             classified = ?,
             skipped = ?,
             claimed_at = NULL,
             claimed_by = NULL,
             heartbeat_at = NULL,
             lease_expires_at = NULL
         WHERE job_id = ?`;
    const update = db.run(
      sql,
      workerId
        ? [now, result.scanned, result.classified, result.skipped, jobId, workerId]
        : [now, result.scanned, result.classified, result.skipped, jobId],
    );
    return update.changes > 0;
  }
}

export function getJobStatus(db: Database, jobId: string): MemoryEfficacyJobRow | null {
  return (
    db
      .query<MemoryEfficacyJobRow, [string]>(`SELECT * FROM memory_efficacy_jobs WHERE job_id = ?`)
      .get(jobId) ?? null
  );
}

export function listRecentJobs(
  db: Database,
  opts?: { limit?: number; status?: string },
): MemoryEfficacyJobRow[] {
  const limit = opts?.limit ?? 20;
  if (opts?.status) {
    return db
      .query<
        MemoryEfficacyJobRow,
        [string, number]
      >(`SELECT * FROM memory_efficacy_jobs WHERE status = ? ORDER BY ts_enqueued DESC LIMIT ?`)
      .all(opts.status, limit);
  }
  return db
    .query<
      MemoryEfficacyJobRow,
      [number]
    >(`SELECT * FROM memory_efficacy_jobs ORDER BY ts_enqueued DESC LIMIT ?`)
    .all(limit);
}

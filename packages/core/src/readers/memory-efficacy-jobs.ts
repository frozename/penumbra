import type { Database } from 'bun:sqlite';

export interface MemoryEfficacyJobRow {
  job_id: string;
  ts_enqueued: string;
  ts_started: string | null;
  ts_finished: string | null;
  status: string;
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
     VALUES (?, ?, 'pending', ?, ?, ?)`,
    [jobId, now, opts.sinceISO ?? null, opts.reviewsDir, opts.enqueuedBy ?? null],
  );
  return { job_id: jobId };
}

export function claimNextJob(
  db: Database,
  now: string,
): { job_id: string; reviews_dir: string; since_iso: string | null } | null {
  const row = db.transaction(() => {
    const pending = db
      .query<{ job_id: string; reviews_dir: string; since_iso: string | null }, []>(
        `SELECT job_id, reviews_dir, since_iso
         FROM memory_efficacy_jobs
         WHERE status = 'pending'
         ORDER BY ts_enqueued ASC
         LIMIT 1`,
      )
      .get();
    if (!pending) return null;
    db.run(`UPDATE memory_efficacy_jobs SET status = 'running', ts_started = ? WHERE job_id = ?`, [
      now,
      pending.job_id,
    ]);
    return pending;
  })();
  return row;
}

export function completeJob(
  db: Database,
  jobId: string,
  result: { scanned: number; classified: number; skipped: number } | { error: string },
  now: string,
): void {
  if ('error' in result) {
    db.run(
      `UPDATE memory_efficacy_jobs SET status = 'failed', ts_finished = ?, error_message = ? WHERE job_id = ?`,
      [now, result.error, jobId],
    );
  } else {
    db.run(
      `UPDATE memory_efficacy_jobs
       SET status = 'completed', ts_finished = ?, scanned = ?, classified = ?, skipped = ?
       WHERE job_id = ?`,
      [now, result.scanned, result.classified, result.skipped, jobId],
    );
  }
}

export function getJobStatus(db: Database, jobId: string): MemoryEfficacyJobRow | null {
  return db
    .query<MemoryEfficacyJobRow, [string]>(
      `SELECT * FROM memory_efficacy_jobs WHERE job_id = ?`,
    )
    .get(jobId) ?? null;
}

export function listRecentJobs(
  db: Database,
  opts?: { limit?: number; status?: string },
): MemoryEfficacyJobRow[] {
  const limit = opts?.limit ?? 20;
  if (opts?.status) {
    return db
      .query<MemoryEfficacyJobRow, [string, number]>(
        `SELECT * FROM memory_efficacy_jobs WHERE status = ? ORDER BY ts_enqueued DESC LIMIT ?`,
      )
      .all(opts.status, limit);
  }
  return db
    .query<MemoryEfficacyJobRow, [number]>(
      `SELECT * FROM memory_efficacy_jobs ORDER BY ts_enqueued DESC LIMIT ?`,
    )
    .all(limit);
}

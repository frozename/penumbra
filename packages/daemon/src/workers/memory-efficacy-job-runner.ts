import type { Database } from 'bun:sqlite';
import type { SiriusChatFn, Services } from '@penumbra/core';
import { createSiriusChat } from '@penumbra/core';
import { randomUUID } from 'node:crypto';
import { buildMemoryEfficacyCache, claimNextJob, completeJob, heartbeatJob } from '@penumbra/core';

export interface MemoryEfficacyJobRunnerOpts {
  db: Database;
  services: Services;
  siriusChat: SiriusChatFn;
  model: string;
  intervalMs?: number;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}

export interface JobRunnerHandle {
  start(): void;
  stop(): void;
}

export function createMemoryEfficacyJobRunner(opts: MemoryEfficacyJobRunnerOpts): JobRunnerHandle {
  const intervalMs = opts.intervalMs ?? 5000;
  const leaseTtlMs = opts.leaseTtlMs ?? 300000;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 60000;
  const log = opts.log ?? { info: () => {}, error: () => {} };
  const workerId = randomUUID();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = new Date().toISOString();
      opts.services.memoryEfficacyRunnerHeartbeatAt = Date.now();
      const job = claimNextJob(opts.db, now, { workerId, leaseTtlMs });
      if (!job) return;

      log.info({ job_id: job.job_id }, 'memory-efficacy-job-runner: claimed job');

      const heartbeatTimer = setInterval(() => {
        const beatAt = new Date().toISOString();
        opts.services.memoryEfficacyRunnerHeartbeatAt = Date.now();
        const ok = (heartbeatJob as unknown as (
          db: Database,
          jobId: string,
          workerId: string,
          now: string,
          opts: { leaseTtlMs: number },
        ) => boolean)(opts.db, job.job_id, workerId, beatAt, { leaseTtlMs });
        if (!ok) {
          log.error({ job_id: job.job_id }, 'memory-efficacy-job-runner: lease lost during run');
        }
      }, heartbeatIntervalMs);
      if (typeof (heartbeatTimer as any).unref === 'function') (heartbeatTimer as any).unref();
      try {
        const result = await buildMemoryEfficacyCache(opts.db, {
          reviewsDir: job.reviews_dir,
          siriusChat: opts.siriusChat,
          model: opts.model,
          sinceISO: job.since_iso ?? undefined,
        });

        const finishedAt = new Date().toISOString();
        const ok = (completeJob as unknown as (
          db: Database,
          jobId: string,
          result: { scanned: number; classified: number; skipped: number } | { error: string },
          now: string,
          opts?: { workerId?: string },
        ) => boolean)(opts.db, job.job_id, result, finishedAt, { workerId });
        if (!ok) {
          log.error({ job_id: job.job_id }, 'memory-efficacy-job-runner: lease lost - terminal write rejected');
        } else {
          log.info(
            { job_id: job.job_id, ...result },
            'memory-efficacy-job-runner: completed job',
          );
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const finishedAt = new Date().toISOString();
        const ok = (completeJob as unknown as (
          db: Database,
          jobId: string,
          result: { scanned: number; classified: number; skipped: number } | { error: string },
          now: string,
          opts?: { workerId?: string },
        ) => boolean)(opts.db, job.job_id, { error: errorMessage }, finishedAt, { workerId });
        if (!ok) {
          log.error({ job_id: job.job_id }, 'memory-efficacy-job-runner: lease lost - terminal write rejected');
        } else {
          log.error(
            { job_id: job.job_id, err: errorMessage },
            'memory-efficacy-job-runner: job failed',
          );
        }
      } finally {
        clearInterval(heartbeatTimer);
      }
    } catch (err) {
      log.error({ err }, 'memory-efficacy-job-runner: tick error');
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      opts.services.memoryEfficacyRunnerHeartbeatAt = Date.now();
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

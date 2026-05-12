import type { Database } from 'bun:sqlite';
import type { SiriusChatFn, Services } from '@penumbra/core';
import {
  claimNextJob,
  completeJob,
  buildMemoryEfficacyCache,
} from '@penumbra/core';
import { createSiriusChat } from '@penumbra/core';

export interface MemoryEfficacyJobRunnerOpts {
  db: Database;
  siriusChat: SiriusChatFn;
  model: string;
  intervalMs?: number;
  log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}

export interface JobRunnerHandle {
  start(): void;
  stop(): void;
}

export function createMemoryEfficacyJobRunner(opts: MemoryEfficacyJobRunnerOpts): JobRunnerHandle {
  const intervalMs = opts.intervalMs ?? 5000;
  const log = opts.log ?? { info: () => {}, error: () => {} };
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = new Date().toISOString();
      const job = claimNextJob(opts.db, now);
      if (!job) return;

      log.info({ job_id: job.job_id }, 'memory-efficacy-job-runner: claimed job');

      try {
        const result = await buildMemoryEfficacyCache(opts.db, {
          reviewsDir: job.reviews_dir,
          siriusChat: opts.siriusChat,
          model: opts.model,
          sinceISO: job.since_iso ?? undefined,
        });

        const finishedAt = new Date().toISOString();
        completeJob(opts.db, job.job_id, result, finishedAt);
        log.info(
          { job_id: job.job_id, ...result },
          'memory-efficacy-job-runner: completed job',
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const finishedAt = new Date().toISOString();
        completeJob(opts.db, job.job_id, { error: errorMessage }, finishedAt);
        log.error(
          { job_id: job.job_id, err: errorMessage },
          'memory-efficacy-job-runner: job failed',
        );
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

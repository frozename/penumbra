import type { Database } from "bun:sqlite";
import type { JudgeChatFn, Services } from "@penumbra/core";
import { randomUUID } from "node:crypto";
import {
  buildMemoryEfficacyCache as defaultBuildMemoryEfficacyCache,
  claimNextJob as defaultClaimNextJob,
  completeJob as defaultCompleteJob,
  heartbeatJob as defaultHeartbeatJob,
} from "@penumbra/core";

type ClaimNextJobFn = typeof defaultClaimNextJob;
type HeartbeatJobFn = typeof defaultHeartbeatJob;
type CompleteJobFn = typeof defaultCompleteJob;
type BuildMemoryEfficacyCacheFn = typeof defaultBuildMemoryEfficacyCache;

export interface MemoryEfficacyJobRunnerOpts {
  db: Database;
  services: Services;
  judgeChat: JudgeChatFn;
  model: string;
  intervalMs?: number;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  collaborators?: Partial<MemoryEfficacyJobRunnerCollaborators>;
}

export interface MemoryEfficacyJobRunnerCollaborators {
  claimNextJob: ClaimNextJobFn;
  heartbeatJob: HeartbeatJobFn;
  completeJob: CompleteJobFn;
  buildMemoryEfficacyCache: BuildMemoryEfficacyCacheFn;
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
  const collab = {
    claimNextJob: defaultClaimNextJob,
    heartbeatJob: defaultHeartbeatJob,
    completeJob: defaultCompleteJob,
    buildMemoryEfficacyCache: defaultBuildMemoryEfficacyCache,
    ...opts.collaborators,
  };
  const workerId = randomUUID();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = new Date().toISOString();
      opts.services.memoryEfficacyRunnerHeartbeatAt = Date.now();
      const job = collab.claimNextJob(opts.db, now, { workerId, leaseTtlMs });
      if (!job) return;

      log.info({ job_id: job.job_id }, "memory-efficacy-job-runner: claimed job");

      const heartbeatTimer = setInterval(() => {
        const beatAt = new Date().toISOString();
        opts.services.memoryEfficacyRunnerHeartbeatAt = Date.now();
        const ok = collab.heartbeatJob(opts.db, job.job_id, workerId, beatAt, { leaseTtlMs });
        if (!ok) {
          log.error({ job_id: job.job_id }, "memory-efficacy-job-runner: lease lost during run");
        }
      }, heartbeatIntervalMs);
      if (typeof (heartbeatTimer as any).unref === "function") (heartbeatTimer as any).unref();
      try {
        const result = await collab.buildMemoryEfficacyCache(opts.db, {
          reviewsDir: job.reviews_dir,
          judgeChat: opts.judgeChat,
          model: opts.model,
          sinceISO: job.since_iso ?? undefined,
        });

        const finishedAt = new Date().toISOString();
        const ok = collab.completeJob(opts.db, job.job_id, result, finishedAt, { workerId });
        if (!ok) {
          log.error(
            { job_id: job.job_id },
            "memory-efficacy-job-runner: lease lost - terminal write rejected",
          );
        } else {
          log.info({ job_id: job.job_id, ...result }, "memory-efficacy-job-runner: completed job");
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const finishedAt = new Date().toISOString();
        const ok = collab.completeJob(opts.db, job.job_id, { error: errorMessage }, finishedAt, {
          workerId,
        });
        if (!ok) {
          log.error(
            { job_id: job.job_id },
            "memory-efficacy-job-runner: lease lost - terminal write rejected",
          );
        } else {
          log.error(
            { job_id: job.job_id, err: errorMessage },
            "memory-efficacy-job-runner: job failed",
          );
        }
      } finally {
        clearInterval(heartbeatTimer);
      }
    } catch (err) {
      log.error({ err }, "memory-efficacy-job-runner: tick error");
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

import type { JudgeChatFn, Services } from "@penumbra/core";
import type { Database } from "bun:sqlite";

import {
  buildMemoryEfficacyCache as defaultBuildMemoryEfficacyCache,
  claimNextJob as defaultClaimNextJob,
  completeJob as defaultCompleteJob,
  heartbeatJob as defaultHeartbeatJob,
} from "@penumbra/core";
import { randomUUID } from "node:crypto";

import { checkDbPressure } from "../pressure.js";

type ClaimNextJobFn = typeof defaultClaimNextJob;
type HeartbeatJobFn = typeof defaultHeartbeatJob;
type CompleteJobFn = typeof defaultCompleteJob;
type BuildMemoryEfficacyCacheFn = typeof defaultBuildMemoryEfficacyCache;

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

export interface MemoryEfficacyJobRunnerOpts {
  db: Database;
  services: Services;
  judgeChat: JudgeChatFn;
  model: string;
  intervalMs?: number;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  pressureGuardEnabled?: boolean;
  log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  collaborators?: Partial<MemoryEfficacyJobRunnerCollaborators>;
}

export interface MemoryEfficacyJobRunnerCollaborators {
  claimNextJob: ClaimNextJobFn;
  heartbeatJob: HeartbeatJobFn;
  completeJob: CompleteJobFn;
  buildMemoryEfficacyCache: BuildMemoryEfficacyCacheFn;
  checkPressure?: () => boolean;
}

export interface JobRunnerHandle {
  start(): void;
  stop(): void;
}

type RunnerLogger = NonNullable<MemoryEfficacyJobRunnerOpts["log"]>;

function noopLog(_obj: object, _msg: string): void {
  // intentional no-op default logger
}

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

export function createMemoryEfficacyJobRunner(opts: MemoryEfficacyJobRunnerOpts): JobRunnerHandle {
  const intervalMs = opts.intervalMs ?? 5000;
  const leaseTtlMs = opts.leaseTtlMs ?? 300000;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 60000;
  const log: RunnerLogger = opts.log ?? { info: noopLog, error: noopLog };
  const collab: MemoryEfficacyJobRunnerCollaborators = {
    claimNextJob: defaultClaimNextJob,
    heartbeatJob: defaultHeartbeatJob,
    completeJob: defaultCompleteJob,
    buildMemoryEfficacyCache: defaultBuildMemoryEfficacyCache,
    ...opts.collaborators,
  };
  const workerId = randomUUID();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function runClaimedJob(job: {
    job_id: string;
    reviews_dir: string;
    since_iso: string | null;
  }): Promise<void> {
    log.info({ job_id: job.job_id }, "memory-efficacy-job-runner: claimed job");

    const heartbeatTimer = setInterval(() => {
      const beatAt = new Date().toISOString();
      opts.services.memoryEfficacyRunnerHeartbeatAt = Date.now();
      const ok = collab.heartbeatJob(opts.db, job.job_id, workerId, beatAt, { leaseTtlMs });
      if (!ok) {
        log.error({ job_id: job.job_id }, "memory-efficacy-job-runner: lease lost during run");
      }
    }, heartbeatIntervalMs);
    maybeUnref(heartbeatTimer);

    try {
      const result = await collab.buildMemoryEfficacyCache(opts.db, {
        reviewsDir: job.reviews_dir,
        judgeChat: opts.judgeChat,
        model: opts.model,
        sinceISO: job.since_iso ?? undefined,
      });
      const finishedAt = new Date().toISOString();
      const ok = collab.completeJob(opts.db, job.job_id, result, finishedAt, { workerId });
      if (ok) {
        log.info({ job_id: job.job_id, ...result }, "memory-efficacy-job-runner: completed job");
      } else {
        log.error(
          { job_id: job.job_id },
          "memory-efficacy-job-runner: lease lost - terminal write rejected",
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const finishedAt = new Date().toISOString();
      const ok = collab.completeJob(opts.db, job.job_id, { error: errorMessage }, finishedAt, {
        workerId,
      });
      if (ok) {
        log.error(
          { job_id: job.job_id, err: errorMessage },
          "memory-efficacy-job-runner: job failed",
        );
      } else {
        log.error(
          { job_id: job.job_id },
          "memory-efficacy-job-runner: lease lost - terminal write rejected",
        );
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  async function tick(): Promise<void> {
    if (running) return;
    if (opts.pressureGuardEnabled) {
      const check = collab.checkPressure ?? ((): boolean => checkDbPressure(opts.db));
      if (check()) {
        log.info({}, "memory-efficacy-job-runner: deferred due to subscription pressure");
        return;
      }
    }
    running = true;
    try {
      const now = new Date().toISOString();
      opts.services.memoryEfficacyRunnerHeartbeatAt = Date.now();
      const job = collab.claimNextJob(opts.db, now, { workerId, leaseTtlMs });
      if (!job) return;
      await runClaimedJob(job);
    } catch (err) {
      log.error({ err }, "memory-efficacy-job-runner: tick error");
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      if (timer) return;
      opts.services.memoryEfficacyRunnerHeartbeatAt = Date.now();
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

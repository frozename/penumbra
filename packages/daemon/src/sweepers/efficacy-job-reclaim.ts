import type { Services } from "@penumbra/core";

import { sweepStaleJobs } from "@penumbra/core";

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

export function runEfficacyJobReclaimSweep(opts: {
  services: Services;
  leaseTtlMs?: number;
  log?: { info: (obj: object, msg: string) => void };
}): string[] {
  const leaseTtlMs = opts.leaseTtlMs ?? 300_000;
  const reclaimed = sweepStaleJobs(opts.services.db, new Date().toISOString(), { leaseTtlMs });
  for (const jobId of reclaimed) {
    opts.log?.info({ job_id: jobId }, "efficacy-job-reclaim: reclaimed stale job");
  }
  return reclaimed;
}

export function startEfficacyJobReclaimSweeper(opts: {
  services: Services;
  intervalMs?: number;
  leaseTtlMs?: number;
  log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  runSweep?: (opts: {
    services: Services;
    leaseTtlMs?: number;
    log?: { info: (obj: object, msg: string) => void };
  }) => string[];
}): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  const timer = setInterval(() => {
    try {
      (opts.runSweep ?? runEfficacyJobReclaimSweep)(opts);
    } catch (err) {
      opts.log?.error({ err: String(err) }, "efficacy-job-reclaim: sweep failed");
    }
  }, intervalMs);
  maybeUnref(timer);
  return () => {
    clearInterval(timer);
  };
}

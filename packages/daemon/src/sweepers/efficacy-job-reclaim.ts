import type { Services } from '@penumbra/core';
import { sweepStaleJobs } from '../../../core/src/readers/memory-efficacy-jobs.js';

export function runEfficacyJobReclaimSweep(opts: { services: Services; leaseTtlMs?: number; log?: { info: (obj: object, msg: string) => void } }): string[] {
  const leaseTtlMs = opts.leaseTtlMs ?? 300_000;
  const reclaimed = sweepStaleJobs(opts.services.db, new Date().toISOString(), { leaseTtlMs });
  for (const jobId of reclaimed) {
    opts.log?.info?.({ job_id: jobId }, 'efficacy-job-reclaim: reclaimed stale job');
  }
  return reclaimed;
}

export function startEfficacyJobReclaimSweeper(opts: {
  services: Services;
  intervalMs?: number;
  leaseTtlMs?: number;
  log?: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  const timer = setInterval(() => {
    runEfficacyJobReclaimSweep(opts);
  }, intervalMs);
  return () => clearInterval(timer);
}

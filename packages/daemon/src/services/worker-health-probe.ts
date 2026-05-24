import type { Services } from '@penumbra/core';

interface WorkerHealthProbeServices extends Services {
  extraWorkerSupervisor: {
    getKnownWorkerIds(): string[];
  };
  orphanHandoffRecovery: {
    recoverForWorker(workerId: string): {
      requeued: number;
      exhausted: number;
      exhaustedRowIds: string[];
      requeuedRowIds: string[];
      _exhaustedRows: unknown[];
      _requeuedRows: unknown[];
    };
  };
}

export class WorkerHealthProbe {
  private readonly intervalMs: number;
  private readonly missThreshold: number;
  private readonly log: Services['log'];
  private readonly services: WorkerHealthProbeServices;
  private timer: ReturnType<typeof setInterval> | null = null;
  private probeSeq = 0;
  private readonly pending = new Map<string, Map<string, number>>();
  private readonly missCounts = new Map<string, number>();
  private readonly recoveredThisStreak = new Set<string>();

  constructor(opts: {
    services: WorkerHealthProbeServices;
    intervalMs?: number;
    missThreshold?: number;
    log: Services['log'];
  }) {
    this.services = opts.services;
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.missThreshold = opts.missThreshold ?? 3;
    this.log = opts.log;
  }

  start(): void {
    if (this.timer !== null) return;
    if (process.env.PENUMBRA_WORKER_PROBE_ENABLED === '0') return;
    if (this.intervalMs <= 0) return;

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.log.error({ err }, 'worker health probe tick failed');
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getMissCount(worker_id: string): number {
    return this.missCounts.get(worker_id) ?? 0;
  }

  recordAck(worker_id: string, probe_id: string): boolean {
    const workerPending = this.pending.get(worker_id);
    if (!workerPending || !workerPending.delete(probe_id)) {
      return false;
    }
    this.missCounts.set(worker_id, 0);
    this.recoveredThisStreak.delete(worker_id);
    return true;
  }

  private async tick(): Promise<void> {
    const now = this.services.clock().getTime();
    const deadlineMs = now - this.intervalMs * 2;
    for (const worker_id of this.services.extraWorkerSupervisor.getKnownWorkerIds()) {
      let workerPending = this.pending.get(worker_id);
      if (!workerPending) {
        workerPending = new Map<string, number>();
        this.pending.set(worker_id, workerPending);
      }

      for (const [probeId, issuedAt] of workerPending) {
        if (issuedAt > deadlineMs) continue;
        workerPending.delete(probeId);
        const misses = (this.missCounts.get(worker_id) ?? 0) + 1;
        this.missCounts.set(worker_id, misses);

        if (misses >= this.missThreshold && !this.recoveredThisStreak.has(worker_id)) {
          this.recoveredThisStreak.add(worker_id);
          this.services.dispatchEventLog.record({
            handoff_id: '',
            worker_id,
            source: 'daemon',
            kind: 'extra_worker_wedge_evicted',
            ts: new Date().toISOString(),
            meta: {
              worker_id,
              probe_id: probeId,
              misses,
              probe_interval_ms: this.intervalMs,
              event: 'probe_timeout',
            },
          });
          this.services.orphanHandoffRecovery.recoverForWorker(worker_id);
        }
      }

      if (workerPending.size === 0) {
        workerPending = new Map<string, number>();
        this.pending.set(worker_id, workerPending);
      }

      const probe_id = `${now}-${this.services.uuid()}-${++this.probeSeq}`;
      workerPending.set(probe_id, now);
      this.services.workerControl.emit({
        type: 'ping',
        worker_id,
        probe_id,
      });
    }
  }
}

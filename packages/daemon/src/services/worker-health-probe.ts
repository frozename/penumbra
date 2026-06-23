import type { Services } from "@penumbra/core";

export type WorkerHealthSignalKind = "miss_threshold_exceeded";

export interface WorkerHealthSignal {
  kind: WorkerHealthSignalKind;
  worker_id: string;
  misses: number;
  probe_id: string;
  probe_interval_ms: number;
}

export interface WorkerHealthController {
  /**
   * Probe guarantees one `onSignal` callback per miss streak while a worker is unresponsive.
   * Callers should not assume idempotency beyond that contract.
   */
  onSignal(signal: WorkerHealthSignal): void | Promise<void>;
}

interface WorkerHealthProbeServices extends Services {
  extraWorkerSupervisor?: {
    getKnownWorkerIds(): string[];
  };
}

export class WorkerHealthProbe {
  private readonly intervalMs: number;
  private readonly missThreshold: number;
  private readonly log: Services["log"];
  private readonly services: WorkerHealthProbeServices;
  private readonly controller: WorkerHealthController;
  private timer: ReturnType<typeof setInterval> | null = null;
  private probeSeq = 0;
  private readonly pending = new Map<string, Map<string, number>>();
  private readonly missCounts = new Map<string, number>();
  private readonly recoveredThisStreak = new Set<string>();

  constructor(opts: {
    services: WorkerHealthProbeServices;
    intervalMs?: number;
    missThreshold?: number;
    log: Services["log"];
    controller: WorkerHealthController;
  }) {
    this.services = opts.services;
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.missThreshold = opts.missThreshold ?? 3;
    this.log = opts.log;
    this.controller = opts.controller;
  }

  start(): void {
    if (this.timer !== null) return;
    if (process.env.PENUMBRA_WORKER_PROBE_ENABLED === "0") return;
    if (this.intervalMs <= 0) return;
    if (!this.services.extraWorkerSupervisor) {
      this.log.warn("worker-health-probe-disabled-no-supervisor");
      return;
    }

    this.timer = setInterval(() => {
      this.tick().catch((err: unknown) => {
        this.log.error({ err }, "worker health probe tick failed");
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

  prune(activeWorkerIds: string[]): void {
    const active = new Set(activeWorkerIds);
    for (const worker_id of this.pending.keys()) {
      if (!active.has(worker_id)) {
        this.pending.delete(worker_id);
        this.missCounts.delete(worker_id);
        this.recoveredThisStreak.delete(worker_id);
      }
    }
  }

  recordAck(worker_id: string, probe_id: string): boolean {
    const workerPending = this.pending.get(worker_id);
    if (!workerPending?.delete(probe_id)) {
      return false;
    }
    this.missCounts.set(worker_id, 0);
    this.recoveredThisStreak.delete(worker_id);
    return true;
  }

  private tick(): Promise<void> {
    const knownWorkerIds = this.services.extraWorkerSupervisor?.getKnownWorkerIds() ?? [];
    const now = this.services.clock().getTime();
    const deadlineMs = now - this.intervalMs * 2;
    this.prune(knownWorkerIds);
    for (const worker_id of knownWorkerIds) {
      this.tickWorker(worker_id, now, deadlineMs);
    }
    return Promise.resolve();
  }

  private tickWorker(worker_id: string, now: number, deadlineMs: number): void {
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
        void this.controller.onSignal({
          kind: "miss_threshold_exceeded",
          worker_id,
          probe_id: probeId,
          misses,
          probe_interval_ms: this.intervalMs,
        });
      }
    }

    if (workerPending.size === 0) {
      workerPending = new Map<string, number>();
      this.pending.set(worker_id, workerPending);
    }

    const probe_id = `${String(now)}-${this.services.uuid()}-${String(++this.probeSeq)}`;
    workerPending.set(probe_id, now);
    this.services.workerControl.emit({
      type: "ping",
      worker_id,
      probe_id,
    });
  }
}

export interface WorkerHealthControllerDeps {
  extraWorkerSupervisor: {
    restartWorkerById(workerId: string): Promise<boolean>;
  };
  dispatchEventLog: {
    record(event: {
      handoff_id: string;
      worker_id: string;
      source: "daemon";
      kind: "extra_worker_wedge_evicted";
      ts: string;
      meta: {
        worker_id: string;
        probe_id: string;
        misses: number;
        probe_interval_ms: number;
        event: "probe_timeout";
      };
    }): void;
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

export function createWorkerHealthController(
  services: WorkerHealthControllerDeps,
): WorkerHealthController {
  return {
    onSignal: async (signal): Promise<void> => {
      const dispatchEvent = {
        handoff_id: "",
        worker_id: signal.worker_id,
        source: "daemon" as const,
        kind: "extra_worker_wedge_evicted" as const,
        ts: new Date().toISOString(),
        meta: {
          worker_id: signal.worker_id,
          probe_id: signal.probe_id,
          misses: signal.misses,
          probe_interval_ms: signal.probe_interval_ms,
          event: "probe_timeout" as const,
        },
      };
      services.dispatchEventLog.record(dispatchEvent);
      try {
        await services.extraWorkerSupervisor.restartWorkerById(signal.worker_id);
      } finally {
        services.orphanHandoffRecovery.recoverForWorker(signal.worker_id);
      }
    },
  };
}

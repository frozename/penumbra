import type { HandoffRow, Services } from "@penumbra/core";

// Post-dispatch.start handoffs only recover when the worker's staleness is
// this many multiples of the base threshold — deep enough that a transient
// pause cannot trigger a double-dispatch.
const POST_START_STALENESS_MULTIPLIER = 3;

export interface TerminalHandoffNotifier {
  notifyTerminalHandoff(row: HandoffRow, reason: string): void;
}

function getTerminalNotifier(services: Services): TerminalHandoffNotifier | undefined {
  const watchdog = services.watchdog as {
    notifyTerminalHandoff?: TerminalHandoffNotifier["notifyTerminalHandoff"];
  };
  return typeof watchdog.notifyTerminalHandoff === "function"
    ? (watchdog as TerminalHandoffNotifier)
    : undefined;
}

export interface OrphanHandoffRecoveryOpts {
  staleMs?: number;
  intervalMs?: number;
  batchSize?: number;
  failFastMode?: boolean;
}

interface RecoveryResult {
  requeued: number;
  exhausted: number;
  exhaustedRowIds: string[];
  requeuedRowIds: string[];
  _exhaustedRows: HandoffRow[];
  _requeuedRows: HandoffRow[];
}

export class OrphanHandoffRecoveryService {
  private staleMs: number;
  private intervalMs: number;
  private batchSize: number;
  private failFastMode: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private recoveryInFlight: Promise<void> | null = null;

  constructor(
    private readonly services: Services,
    opts?: OrphanHandoffRecoveryOpts,
  ) {
    this.staleMs = opts?.staleMs ?? 90000;
    this.intervalMs = opts?.intervalMs ?? 15000;
    this.batchSize = opts?.batchSize ?? 100;
    this.failFastMode = opts?.failFastMode ?? false;
  }

  recoverForWorker(workerId: string, opts?: { workerKnownDead?: boolean }): RecoveryResult {
    const deepStale = this.listDeepStaleNeverHeartbeatWorkerIds().filter((id) => id === workerId);
    if (opts?.workerKnownDead) {
      deepStale.push(workerId);
    }
    return this.recoverForWorkerIds([workerId], deepStale);
  }

  async recoverAll(): Promise<void> {
    if (this.recoveryInFlight) {
      await this.recoveryInFlight;
      return;
    }

    this.recoveryInFlight = Promise.resolve().then((): void => {
      const { _exhaustedRows } = this.runOnce();
      const notifier = getTerminalNotifier(this.services);
      if (notifier) {
        for (const row of _exhaustedRows) {
          notifier.notifyTerminalHandoff(row, "worker timeout");
        }
      }
    });

    try {
      await this.recoveryInFlight;
    } finally {
      this.recoveryInFlight = null;
    }
  }

  runOnce(workerId?: string, opts?: { workerKnownDead?: boolean }): RecoveryResult {
    if (workerId) {
      return this.recoverForWorker(workerId, opts);
    }
    return this.recoverAllInner();
  }

  private recoverForWorkerIds(
    staleWorkerIds: string[],
    additionalVeryStaleWorkerIds: string[] = [],
  ): RecoveryResult {
    let requeued = 0;
    let exhausted = 0;
    const _exhaustedRows: HandoffRow[] = [];
    const _requeuedRows: HandoffRow[] = [];
    const exhaustedRowIds: string[] = [];
    const requeuedRowIds: string[] = [];

    if (staleWorkerIds.length === 0) {
      return {
        requeued,
        exhausted,
        exhaustedRowIds,
        requeuedRowIds,
        _exhaustedRows,
        _requeuedRows,
      };
    }

    const MAX_STALE_WORKERS_PER_CALL = 50;
    if (staleWorkerIds.length > MAX_STALE_WORKERS_PER_CALL) {
      this.services.log.warn(
        { count: staleWorkerIds.length, cap: MAX_STALE_WORKERS_PER_CALL },
        "orphan-recovery: too many stale workers, capping this tick",
      );
      staleWorkerIds = staleWorkerIds.slice(0, MAX_STALE_WORKERS_PER_CALL);
    }

    const orphans = this.services.handoffReader.listOrphanedDispatches(
      staleWorkerIds,
      this.batchSize,
    );

    // Handoffs already past dispatch.start only recover when their worker is
    // DEEPLY stale: a transient pause (GC, CPU saturation) barely crosses the
    // base threshold and the worker is usually still alive — requeueing then
    // double-dispatches the handoff. A dead worker's staleness keeps growing,
    // so the deeper threshold rescues genuinely stuck work.
    const veryStaleWorkers = new Set([
      ...this.services.watchdog.getStaleWorkers(this.staleMs * POST_START_STALENESS_MULTIPLIER),
      ...additionalVeryStaleWorkerIds,
    ]);

    // Perf: wrap per-orphan write+event in a single transaction.
    // Trades a small lock per orphan for atomicity (event row only exists if state transition won the CAS).
    const processOrphan = this.services.db.transaction(
      (orphan: HandoffRow, attempt: number, maxAttempts: number, failFastMode: boolean) => {
        if (!orphan.worker_id) return "skip";
        if (this.hasDispatchStarted(orphan.handoff_id) && !veryStaleWorkers.has(orphan.worker_id)) {
          return "skip";
        }
        if (failFastMode || attempt >= maxAttempts) {
          const won = this.services.handoffWriter.failOrphanedDispatchExhausted(
            orphan.handoff_id,
            orphan.worker_id,
          );
          if (won) {
            this.services.dispatchEventLog.record({
              handoff_id: orphan.handoff_id,
              source: "daemon",
              kind: "worker.recovery.exhausted",
              ts: new Date().toISOString(),
              meta: {
                attempt,
                max_attempts: maxAttempts,
                from_worker_id: orphan.worker_id,
                handoff_id: orphan.handoff_id,
              },
            });
            return "exhausted";
          }
        } else {
          const won = this.services.handoffWriter.requeueOrphanedDispatch(
            orphan.handoff_id,
            orphan.worker_id,
          );
          if (won) {
            this.services.dispatchEventLog.record({
              handoff_id: orphan.handoff_id,
              source: "daemon",
              kind: "worker.recovery.requeued",
              ts: new Date().toISOString(),
              meta: {
                attempt,
                max_attempts: maxAttempts,
                from_worker_id: orphan.worker_id,
                handoff_id: orphan.handoff_id,
              },
            });
            return "requeued";
          }
        }
        return "skip";
      },
    );

    for (const orphan of orphans) {
      if (!orphan.worker_id) continue;

      const maxAttempts = orphan.max_dispatch_attempts;
      const attempt = orphan.dispatch_attempts;

      const result = processOrphan(orphan, attempt, maxAttempts, this.failFastMode);
      if (result === "exhausted") {
        exhausted++;
        _exhaustedRows.push(orphan);
        exhaustedRowIds.push(orphan.handoff_id);
      } else if (result === "requeued") {
        requeued++;
        _requeuedRows.push(orphan);
        requeuedRowIds.push(orphan.handoff_id);
      }
    }

    return { requeued, exhausted, exhaustedRowIds, requeuedRowIds, _exhaustedRows, _requeuedRows };
  }

  private recoverAllInner(): RecoveryResult {
    const deepStaleWorkerIds = this.listDeepStaleNeverHeartbeatWorkerIds();
    const staleWorkerIds = [
      ...new Set([...this.services.watchdog.getStaleWorkers(this.staleMs), ...deepStaleWorkerIds]),
    ];
    return this.recoverForWorkerIds(staleWorkerIds, deepStaleWorkerIds);
  }

  private listDeepStaleNeverHeartbeatWorkerIds(): string[] {
    const cutoff = new Date(
      Date.now() - this.staleMs * POST_START_STALENESS_MULTIPLIER,
    ).toISOString();
    const rows = this.services.db
      .query<{ worker_id: string }, [string]>(
        `SELECT DISTINCT worker_id FROM handoffs
          WHERE status='dispatched'
            AND worker_id IS NOT NULL
            AND last_dispatch_started_at IS NOT NULL
            AND last_dispatch_started_at < ?`,
      )
      .all(cutoff);
    return rows.map((row) => row.worker_id).filter((workerId) => !this.hasWatchdogWorker(workerId));
  }

  private hasWatchdogWorker(workerId: string): boolean {
    const watchdog = this.services.watchdog as { hasWorker?: (workerId: string) => boolean };
    return typeof watchdog.hasWorker === "function" ? watchdog.hasWorker(workerId) : false;
  }

  private hasDispatchStarted(handoffId: string): boolean {
    const row = this.services.db
      .query<
        { found: number },
        [string]
      >(`SELECT 1 AS found FROM dispatch_events WHERE handoff_id = ? AND kind = 'dispatch.start' LIMIT 1`)
      .get(handoffId);
    return row !== null;
  }

  start(): { stop: () => void } {
    if (this.intervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => {
        void this.recoverAll().catch((err: unknown) => {
          this.services.log.error({ err }, "orphan-recovery: runOnce failed");
        });
      }, this.intervalMs);
    }
    return {
      stop: (): void => {
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
      },
    };
  }
}

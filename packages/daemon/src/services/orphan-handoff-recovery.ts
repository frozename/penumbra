import type { Services, HandoffRow } from '@penumbra/core';

export interface OrphanHandoffRecoveryOpts {
  staleMs?: number;
  intervalMs?: number;
  batchSize?: number;
  strictMode?: boolean;
}

export class OrphanHandoffRecoveryService {
  private staleMs: number;
  private intervalMs: number;
  private batchSize: number;
  private strictMode: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly services: Services, opts?: OrphanHandoffRecoveryOpts) {
    this.staleMs = opts?.staleMs ?? 90000;
    this.intervalMs = opts?.intervalMs ?? 15000;
    this.batchSize = opts?.batchSize ?? 100;
    this.strictMode = opts?.strictMode ?? false;
  }

  runOnce(workerId?: string): { requeued: number; exhausted: number; exhaustedRows: HandoffRow[]; requeuedRows: HandoffRow[] } {
    let requeued = 0;
    let exhausted = 0;
    const exhaustedRows: HandoffRow[] = [];
    const requeuedRows: HandoffRow[] = [];

    let staleWorkerIds = workerId ? [workerId] : this.services.watchdog.getStaleWorkers(this.staleMs);
    if (staleWorkerIds.length === 0) {
      return { requeued, exhausted, exhaustedRows, requeuedRows };
    }

    const MAX_STALE_WORKERS_PER_CALL = 50;
    if (staleWorkerIds.length > MAX_STALE_WORKERS_PER_CALL) {
      this.services.log.warn(
        { count: staleWorkerIds.length, cap: MAX_STALE_WORKERS_PER_CALL },
        'orphan-recovery: too many stale workers, capping this tick'
      );
      staleWorkerIds = staleWorkerIds.slice(0, MAX_STALE_WORKERS_PER_CALL);
    }

    const orphans = this.services.handoffReader.listOrphanedDispatches(staleWorkerIds, this.batchSize);

    // Perf: wrap per-orphan write+event in a single transaction.
    // Trades a small lock per orphan for atomicity (event row only exists if state transition won the CAS).
    const processOrphan = this.services.db.transaction((orphan: HandoffRow, attempt: number, maxAttempts: number, strictMode: boolean) => {
      if (strictMode || attempt >= maxAttempts) {
        const won = this.services.handoffWriter.failOrphanedDispatchExhausted(orphan.handoff_id, orphan.worker_id!);
        if (won) {
          this.services.dispatchEventLog.record({
            handoff_id: orphan.handoff_id,
            source: 'daemon',
            kind: 'worker.recovery.exhausted',
            ts: new Date().toISOString(),
            meta: {
              attempt,
              max_attempts: maxAttempts,
              from_worker_id: orphan.worker_id,
              handoff_id: orphan.handoff_id,
            },
          });
          return 'exhausted';
        }
      } else {
        const won = this.services.handoffWriter.requeueOrphanedDispatch(orphan.handoff_id, orphan.worker_id!);
        if (won) {
          this.services.dispatchEventLog.record({
            handoff_id: orphan.handoff_id,
            source: 'daemon',
            kind: 'worker.recovery.requeued',
            ts: new Date().toISOString(),
            meta: {
              attempt,
              max_attempts: maxAttempts,
              from_worker_id: orphan.worker_id,
              handoff_id: orphan.handoff_id,
            },
          });
          return 'requeued';
        }
      }
      return 'skip';
    });

    for (const orphan of orphans) {
      if (!orphan.worker_id) continue;

      const maxAttempts = orphan.max_dispatch_attempts ?? 3;
      const attempt = orphan.dispatch_attempts ?? 1;

      const result = processOrphan(orphan, attempt, maxAttempts, this.strictMode);
      if (result === 'exhausted') {
        exhausted++;
        exhaustedRows.push(orphan);
      } else if (result === 'requeued') {
        requeued++;
        requeuedRows.push(orphan);
      }
    }

    return { requeued, exhausted, exhaustedRows, requeuedRows };
  }

  start(): { stop: () => void } {
    if (this.intervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => {
        try {
          const { exhaustedRows } = this.runOnce();
          const watchdog = this.services.watchdog as { notifyTerminalHandoff?: (row: HandoffRow, reason: string) => void };
          if (watchdog.notifyTerminalHandoff) {
            for (const row of exhaustedRows) {
              watchdog.notifyTerminalHandoff(row, 'worker timeout');
            }
          }
        } catch (err) {
          this.services.log.error({ err }, 'orphan-recovery: runOnce failed');
        }
      }, this.intervalMs);
    }
    return {
      stop: () => {
        if (this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
      },
    };
  }
}

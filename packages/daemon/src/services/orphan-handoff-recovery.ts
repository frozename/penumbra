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

    const staleWorkerIds = workerId ? [workerId] : (this.services.watchdog as any).getStaleWorkers(this.staleMs);
    if (staleWorkerIds.length === 0) {
      return { requeued, exhausted, exhaustedRows, requeuedRows };
    }

    const orphans = this.services.handoffReader.listOrphanedDispatches(staleWorkerIds).slice(0, this.batchSize);

    for (const orphan of orphans) {
      if (!orphan.worker_id) continue;

      const maxAttempts = orphan.max_dispatch_attempts ?? 3;
      const attempt = orphan.dispatch_attempts ?? 1;

      if (this.strictMode || attempt >= maxAttempts) {
        const won = this.services.handoffWriter.failOrphanedDispatchExhausted(orphan.handoff_id, orphan.worker_id);
        if (won) {
          exhausted++;
          exhaustedRows.push(orphan);
          this.services.dispatchEventLog.record({
            handoff_id: orphan.handoff_id,
            source: 'daemon',
            kind: 'worker.recovery.exhausted' as any,
            ts: new Date().toISOString(),
            meta: {
              attempt,
              max_attempts: maxAttempts,
              from_worker_id: orphan.worker_id,
              handoff_id: orphan.handoff_id,
            },
          });
        }
      } else {
        const won = this.services.handoffWriter.requeueOrphanedDispatch(orphan.handoff_id, orphan.worker_id);
        if (won) {
          requeued++;
          requeuedRows.push(orphan);
          this.services.dispatchEventLog.record({
            handoff_id: orphan.handoff_id,
            source: 'daemon',
            kind: 'worker.recovery.requeued' as any,
            ts: new Date().toISOString(),
            meta: {
              attempt,
              max_attempts: maxAttempts,
              from_worker_id: orphan.worker_id,
              handoff_id: orphan.handoff_id,
            },
          });
        }
      }
    }

    return { requeued, exhausted, exhaustedRows, requeuedRows };
  }

  start(): { stop: () => void } {
    if (this.intervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => {
        const { exhaustedRows } = this.runOnce();
        const watchdog = (this.services as any).watchdog;
        if (watchdog?.notifyTerminalHandoff) {
          for (const row of exhaustedRows) {
            watchdog.notifyTerminalHandoff(row, 'worker timeout');
          }
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

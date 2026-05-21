import type { Services, HandoffRow } from '@penumbra/core';

export interface TerminalHandoffNotifier {
  notifyTerminalHandoff(row: HandoffRow, reason: string): void;
}

function getTerminalNotifier(services: Services): TerminalHandoffNotifier | undefined {
  const watchdog = services.watchdog as { notifyTerminalHandoff?: TerminalHandoffNotifier['notifyTerminalHandoff'] };
  return typeof watchdog.notifyTerminalHandoff === 'function' ? (watchdog as TerminalHandoffNotifier) : undefined;
}

export interface OrphanHandoffRecoveryOpts {
  staleMs?: number;
  intervalMs?: number;
  batchSize?: number;
  failFastMode?: boolean;
}

export class OrphanHandoffRecoveryService {
  private staleMs: number;
  private intervalMs: number;
  private batchSize: number;
  private failFastMode: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly services: Services, opts?: OrphanHandoffRecoveryOpts) {
    this.staleMs = opts?.staleMs ?? 90000;
    this.intervalMs = opts?.intervalMs ?? 15000;
    this.batchSize = opts?.batchSize ?? 100;
    this.failFastMode = opts?.failFastMode ?? false;
  }

  runOnce(workerId?: string): { requeued: number; exhausted: number; exhaustedRowIds: string[]; requeuedRowIds: string[]; _exhaustedRows: HandoffRow[]; _requeuedRows: HandoffRow[] } {
    let requeued = 0;
    let exhausted = 0;
    const _exhaustedRows: HandoffRow[] = [];
    const _requeuedRows: HandoffRow[] = [];
    const exhaustedRowIds: string[] = [];
    const requeuedRowIds: string[] = [];
    

    let staleWorkerIds = workerId ? [workerId] : this.services.watchdog.getStaleWorkers(this.staleMs);
    if (staleWorkerIds.length === 0) {
      return { requeued, exhausted, exhaustedRowIds, requeuedRowIds, _exhaustedRows, _requeuedRows };
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
    const processOrphan = this.services.db.transaction((orphan: HandoffRow, attempt: number, maxAttempts: number, failFastMode: boolean) => {
      if (failFastMode || attempt >= maxAttempts) {
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

      const result = processOrphan(orphan, attempt, maxAttempts, this.failFastMode);
      if (result === 'exhausted') {
        exhausted++;
        _exhaustedRows.push(orphan);
        exhaustedRowIds.push(orphan.handoff_id);
      } else if (result === 'requeued') {
        requeued++;
        _requeuedRows.push(orphan);
        requeuedRowIds.push(orphan.handoff_id);
      }
    }

    return { requeued, exhausted, exhaustedRowIds, requeuedRowIds, _exhaustedRows, _requeuedRows };
  }

  start(): { stop: () => void } {
    if (this.intervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => {
        try {
          const { _exhaustedRows } = this.runOnce();
          const notifier = getTerminalNotifier(this.services);
          if (notifier) {
            for (const row of _exhaustedRows) {
              notifier.notifyTerminalHandoff(row, 'worker timeout');
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

import type { Services, Watchdog, HandoffRow } from "@penumbra/core";
import type { OrphanHandoffRecoveryService } from "./orphan-handoff-recovery.js";

interface WatchdogFailureNotification {
  kind: "watchdog_failure";
  worker_id: string;
  handoff_id: string;
  conversation_id: string;
  project_id: string | null;
  agent: string | null;
  error_summary: string;
}

export class WatchdogService implements Watchdog {
  private lastHeartbeats = new Map<string, number>();
  private readonly timeoutMs: number;

  constructor(
    private readonly services: Services,
    timeoutMs?: number,
  ) {
    this.timeoutMs = timeoutMs ?? (Number(process.env.PENUMBRA_WORKER_HEARTBEAT_STALE_MS) || 90000);
  }

  recordHeartbeat(worker_id: string): void {
    this.lastHeartbeats.set(worker_id, Date.now());
  }

  hasActiveWorker(timeoutMs: number): boolean {
    const now = Date.now();
    for (const lastSeen of this.lastHeartbeats.values()) {
      if (now - lastSeen <= timeoutMs) return true;
    }
    return false;
  }

  getStaleWorkers(timeoutMs: number): string[] {
    const now = Date.now();
    const stale = [];
    for (const [worker_id, lastSeen] of this.lastHeartbeats) {
      if (now - lastSeen > timeoutMs) stale.push(worker_id);
    }
    return stale;
  }

  hasWorker(worker_id: string): boolean {
    return this.lastHeartbeats.has(worker_id);
  }

  tick = async (): Promise<void> => {
    const now = Date.now();
    const tickTs = new Date(now).toISOString();

    const snapshot = new Map(this.lastHeartbeats);
    let staleCount = 0;

    const recoveryService = this.services.orphanHandoffRecovery as
      | OrphanHandoffRecoveryService
      | undefined;

    for (const [worker_id, lastSeen] of snapshot) {
      if (now - lastSeen > this.timeoutMs) {
        staleCount++;
        this.services.log.warn(
          { worker_id },
          "worker watchdog timeout; processing associated handoffs",
        );

        if (recoveryService) {
          const { _exhaustedRows } = recoveryService.runOnce(worker_id);
          for (const row of _exhaustedRows) {
            this.notifyTerminalHandoff(row, "worker timeout");
          }
        } else {
          // Fallback if no recovery service wired (e.g. some test fixtures)
          const affectedHandoffs = this.services.db
            .query<
              HandoffRow,
              [string]
            >("SELECT * FROM handoffs WHERE worker_id=? AND status='dispatched'")
            .all(worker_id);

          for (const row of affectedHandoffs) {
            this.services.handoffWriter.markFailed(row.handoff_id, {
              reason: "worker timeout",
              ts: tickTs,
              resolved_by: "watchdog",
            });
            this.services.dispatchEventLog.record({
              handoff_id: row.handoff_id,
              worker_id,
              source: "daemon",
              kind: "watchdog.auto_fail",
              ts: tickTs,
              meta: { worker_id, ms_since_heartbeat: now - lastSeen },
            });
            this.notifyTerminalHandoff(row, "worker timeout");
          }
        }

        this.lastHeartbeats.delete(worker_id);
      }
    }
    this.services.dispatchEventLog.record({
      handoff_id: "",
      source: "daemon",
      kind: "watchdog.tick",
      ts: tickTs,
      meta: { workers_checked: snapshot.size, stale_count: staleCount },
    });
  };

  notifyTerminalHandoff(
    row: Pick<
      HandoffRow,
      "handoff_id" | "conversation_id" | "project_id" | "to_agent" | "worker_id"
    >,
    error_summary: string,
  ): void {
    if (!row.worker_id) return;
    this.emitFailureNotification({
      kind: "watchdog_failure",
      worker_id: row.worker_id,
      handoff_id: row.handoff_id,
      conversation_id: row.conversation_id,
      project_id: row.project_id,
      agent: row.to_agent,
      error_summary,
    });

    this.services.conversationStream.emit(row.conversation_id, {
      type: "chain-end",
      chain_id: row.conversation_id,
      reason: "error",
    });
  }

  private emitFailureNotification(event: WatchdogFailureNotification): void {
    const notificationEvents = this.services.notificationEvents;
    if (!notificationEvents) return;

    try {
      notificationEvents.emit(event);
    } catch {}
  }
}

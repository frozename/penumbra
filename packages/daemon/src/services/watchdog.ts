import type { HandoffRow, Services, Watchdog } from "@penumbra/core";

import type { OrphanHandoffRecoveryService } from "./orphan-handoff-recovery.js";

import { workerHeartbeatStaleMs } from "../worker-heartbeat-stale.js";

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
    this.timeoutMs = timeoutMs ?? workerHeartbeatStaleMs();
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
    return this.getStaleHeartbeatAges(timeoutMs).map(({ worker_id }) => worker_id);
  }

  getStaleHeartbeatAges(timeoutMs: number): { worker_id: string; last_seen_age_ms: number }[] {
    const now = Date.now();
    const stale = [];
    for (const [worker_id, lastSeen] of this.lastHeartbeats) {
      const last_seen_age_ms = now - lastSeen;
      if (last_seen_age_ms > timeoutMs) stale.push({ worker_id, last_seen_age_ms });
    }
    return stale;
  }

  hasWorker(worker_id: string): boolean {
    return this.lastHeartbeats.has(worker_id);
  }

  tick = (): Promise<void> => {
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
        this.processStaleWorker(worker_id, lastSeen, now, tickTs, recoveryService);
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
    return Promise.resolve();
  };

  private processStaleWorker(
    worker_id: string,
    lastSeen: number,
    now: number,
    tickTs: string,
    recoveryService: OrphanHandoffRecoveryService | undefined,
  ): void {
    if (recoveryService) {
      const { _exhaustedRows } = recoveryService.runOnce(worker_id);
      for (const row of _exhaustedRows) {
        this.notifyTerminalHandoff(row, "worker timeout");
      }
      return;
    }
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
        expected_worker_id: worker_id,
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
    } catch {
      // Notification bus errors must not propagate and kill the watchdog tick.
    }
  }
}

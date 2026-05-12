import type { Services, Watchdog } from '@penumbra/core';

interface WatchdogFailureNotification {
  kind: 'watchdog_failure';
  worker_id: string;
  handoff_id: string;
  conversation_id: string;
  project_id: string | null;
  agent: string | null;
  error_summary: string;
}

interface NotificationEventsBus {
  emit(event: WatchdogFailureNotification): void;
}

export class WatchdogService implements Watchdog {
  private lastHeartbeats = new Map<string, number>();

  constructor(private readonly services: Services) {}

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

  tick = async (): Promise<void> => {
    const now = Date.now();
    const tickTs = new Date(now).toISOString();
    const TIMEOUT_MS = 60_000;

    // Snapshot the map to avoid concurrent modification issues during async loop
    const snapshot = new Map(this.lastHeartbeats);
    let staleCount = 0;

    for (const [worker_id, lastSeen] of snapshot) {
      if (now - lastSeen > TIMEOUT_MS) {
        staleCount++;
        this.services.log.warn(
          { worker_id },
          'worker watchdog timeout; failing associated handoffs',
        );

        // 1. Identify handoffs assigned to this worker that are still 'dispatched'
        // Note: Handoff status transitions atomically from 'approved' to 'dispatched' during claim.
        // There is no intermediate 'claimed' state, so filtering by 'dispatched' covers all active assignments.
        const affectedHandoffs = this.services.db
          .query<{ handoff_id: string; conversation_id: string; project_id: string | null; to_agent: string | null }, [string]>(
            `SELECT handoff_id, conversation_id, project_id, to_agent FROM handoffs 
             WHERE worker_id=? AND status='dispatched'`,
          )
          .all(worker_id);

        for (const { handoff_id, conversation_id, project_id, to_agent } of affectedHandoffs) {
          // 2. Mark as failed in DB
          this.services.handoffWriter.markFailed(handoff_id, {
            reason: 'worker timeout',
            ts: tickTs,
            resolved_by: 'watchdog',
          });
          this.services.dispatchEventLog.record({
            handoff_id,
            worker_id,
            source: 'daemon',
            kind: 'watchdog.auto_fail',
            ts: tickTs,
            meta: { worker_id, ms_since_heartbeat: now - lastSeen },
          });

          this.emitFailureNotification({
            kind: 'watchdog_failure',
            worker_id,
            handoff_id,
            conversation_id,
            project_id,
            agent: to_agent,
            error_summary: 'worker timeout',
          });

          // 3. Broadcast chain-end to conversation stream so thin clients stop waiting
          this.services.conversationStream.emit(conversation_id, {
            type: 'chain-end',
            chain_id: conversation_id,
            reason: 'error',
          });
        }

        // Stop tracking this worker until it checks in again
        this.lastHeartbeats.delete(worker_id);
      }
    }
    this.services.dispatchEventLog.record({
      handoff_id: '',
      source: 'daemon',
      kind: 'watchdog.tick',
      ts: tickTs,
      meta: { workers_checked: snapshot.size, stale_count: staleCount },
    });
  };

  private emitFailureNotification(event: WatchdogFailureNotification): void {
    const notificationEvents = this.services.notificationEvents;
    if (!notificationEvents) return;

    try {
      notificationEvents.emit(event);
    } catch {
      // Notification delivery must never break watchdog failure handling.
    }
  }
}

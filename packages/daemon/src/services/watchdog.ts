import type { Services, Watchdog } from '@penumbra/core';

export class WatchdogService implements Watchdog {
  private lastHeartbeats = new Map<string, number>();

  constructor(private readonly services: Services) {}

  recordHeartbeat(worker_id: string): void {
    this.lastHeartbeats.set(worker_id, Date.now());
  }

  tick = async (): Promise<void> => {
    const now = Date.now();
    const TIMEOUT_MS = 60_000;

    for (const [worker_id, lastSeen] of this.lastHeartbeats) {
      if (now - lastSeen > TIMEOUT_MS) {
        this.services.log.warn(
          { worker_id },
          'worker watchdog timeout; failing associated handoffs',
        );

        // 1. Identify handoffs assigned to this worker that are still 'dispatched'
        const affectedHandoffs = this.services.db
          .query<{ handoff_id: string; conversation_id: string }, [string]>(
            `SELECT handoff_id, conversation_id FROM handoffs 
             WHERE worker_id=? AND status='dispatched'`,
          )
          .all(worker_id);

        for (const { handoff_id, conversation_id } of affectedHandoffs) {
          // 2. Mark as failed in DB
          this.services.handoffWriter.markFailed(handoff_id, {
            reason: 'worker timeout',
            ts: new Date(now).toISOString(),
            resolved_by: 'watchdog',
          });

          // 3. Broadcast chain-end to conversation stream so thin clients stop waiting
          this.services.conversationStream.emit(conversation_id, {
            type: 'chain-end',
            conversation_id,
            reason: 'error',
            error_message: 'worker timeout',
          });
        }

        // Stop tracking this worker until it checks in again
        this.lastHeartbeats.delete(worker_id);
      }
    }
  };
}

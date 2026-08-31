export type LeftDispatchedToStatus = "completed" | "failed" | "approved" | "expired";

export interface LeftDispatchedEvent {
  kind: "left_dispatched";
  handoff_id: string;
  to_agent: string;
  to_status: LeftDispatchedToStatus;
  ts: string;
}

export type HandoffTransitionEvent = LeftDispatchedEvent;

export type HandoffTransitionListener = (evt: HandoffTransitionEvent) => void;

/**
 * Kept separate from HandoffEventBus on purpose: GET /handoffs/events forwards every HandoffEventBus emit verbatim to workers (packages/daemon/src/routes/handoffs-events.ts:8-10), and the worker dispatcher runs consumePendingCancel + attemptClaim on every row it receives (packages/agentchat/src/worker/dispatcher.ts:1096-1104), so transition/terminal payloads must never ride the worker bus.
 */
export class HandoffTransitionBus {
  private listeners = new Set<HandoffTransitionListener>();

  subscribe(fn: HandoffTransitionListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(evt: HandoffTransitionEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(evt);
      } catch {
        /* one bad subscriber must not block the others */
      }
    }
  }
}

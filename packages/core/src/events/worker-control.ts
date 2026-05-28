import type { WorkerControlStreamEvent } from "../schemas/sse-events.js";

export type WorkerControlListener = (event: WorkerControlStreamEvent) => void;

/**
 * Manages live emission of worker control events (e.g. cancellations).
 * Workers subscribe to this via the /worker/control SSE endpoint.
 */
export class WorkerControlBus {
  private listeners = new Set<WorkerControlListener>();

  subscribe(fn: WorkerControlListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(event: WorkerControlStreamEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* one bad subscriber must not block the others */
      }
    }
  }
}

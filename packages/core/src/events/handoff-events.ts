import type { HandoffRow } from "../schemas/handoff.js";

export type HandoffEventListener = (row: HandoffRow) => void;

export class HandoffEventBus {
  private listeners = new Set<HandoffEventListener>();

  subscribe(fn: HandoffEventListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(row: HandoffRow): void {
    for (const fn of this.listeners) {
      try {
        fn(row);
      } catch {
        /* one bad subscriber must not block the others */
      }
    }
  }
}

import type { DispatchEventInput } from "../services/dispatch-event-log.js";

export type DispatchEvent = Omit<DispatchEventInput, "worker_id" | "meta"> & {
  worker_id: string | null;
  meta: Record<string, unknown> | null;
};

interface DispatchSubscriber {
  closed: boolean;
  evictionWarned: boolean;
  predicate: (event: DispatchEvent) => boolean;
  queue: DispatchEvent[];
  pending: ((result: IteratorResult<DispatchEvent>) => void)[];
}

export interface DispatchEventBusOptions {
  maxQueueLength?: number;
}

export class DispatchEventBus {
  private subscribers = new Set<DispatchSubscriber>();
  private readonly maxQueueLength: number;

  constructor(opts: DispatchEventBusOptions = {}) {
    this.maxQueueLength = opts.maxQueueLength ?? 1000;
  }

  publish(event: DispatchEvent): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.closed || !subscriber.predicate(event)) continue;
      const waiter = subscriber.pending.shift();
      if (waiter) {
        waiter({ value: event, done: false });
        continue;
      }
      subscriber.queue.push(event);
      if (subscriber.queue.length > this.maxQueueLength) {
        const evicted = subscriber.queue.length - this.maxQueueLength;
        subscriber.queue.splice(0, evicted);
        if (!subscriber.evictionWarned) {
          subscriber.evictionWarned = true;
          console.warn(
            `DispatchEventBus subscriber queue exceeded ${String(this.maxQueueLength)}; evicting oldest event(s)`,
          );
        }
      }
    }
  }

  subscribe(
    predicate: (event: DispatchEvent) => boolean = () => true,
  ): AsyncIterableIterator<DispatchEvent> {
    const subscriber: DispatchSubscriber = {
      closed: false,
      evictionWarned: false,
      predicate,
      queue: [],
      pending: [],
    };
    this.subscribers.add(subscriber);

    const close = (): void => {
      if (subscriber.closed) return;
      subscriber.closed = true;
      this.subscribers.delete(subscriber);
      while (subscriber.pending.length > 0) {
        const waiter = subscriber.pending.shift();
        waiter?.({ value: undefined as never, done: true });
      }
      subscriber.queue.length = 0;
    };

    const iterator: AsyncIterableIterator<DispatchEvent> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next() {
        if (subscriber.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        const queued = subscriber.queue.shift();
        if (queued) {
          return Promise.resolve({ value: queued, done: false });
        }
        return new Promise<IteratorResult<DispatchEvent>>((resolve) => {
          subscriber.pending.push(resolve);
        });
      },
      return() {
        close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
      throw(error: unknown) {
        close();
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      },
    };

    return iterator;
  }
}

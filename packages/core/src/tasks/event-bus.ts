import type { TaskEventKind } from "./schema.js";

export interface TaskEvent {
  task_id: string;
  at: number;
  kind: TaskEventKind;
  actor: string | null;
  payload: Record<string, unknown> | null;
}

interface TaskSubscriber {
  closed: boolean;
  evictionWarned: boolean;
  predicate: (event: TaskEvent) => boolean;
  queue: TaskEvent[];
  pending: ((result: IteratorResult<TaskEvent>) => void)[];
}

export interface TaskEventBusOptions {
  maxQueueLength?: number;
}

export class TaskEventBus {
  private subscribers = new Set<TaskSubscriber>();
  private readonly maxQueueLength: number;

  constructor(opts: TaskEventBusOptions = {}) {
    this.maxQueueLength = opts.maxQueueLength ?? 1000;
  }

  publish(event: TaskEvent): void {
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
            `TaskEventBus subscriber queue exceeded ${String(this.maxQueueLength)}; evicting oldest event(s)`,
          );
        }
      }
    }
  }

  subscribe(
    predicate: (event: TaskEvent) => boolean = () => true,
  ): AsyncIterableIterator<TaskEvent> {
    const subscriber: TaskSubscriber = {
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

    const iterator: AsyncIterableIterator<TaskEvent> = {
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
        return new Promise<IteratorResult<TaskEvent>>((resolve) => {
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

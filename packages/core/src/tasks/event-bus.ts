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
  predicate: (event: TaskEvent) => boolean;
  queue: TaskEvent[];
  pending: Array<(result: IteratorResult<TaskEvent>) => void>;
}

export class TaskEventBus {
  private subscribers = new Set<TaskSubscriber>();

  publish(event: TaskEvent): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.closed || !subscriber.predicate(event)) continue;
      const waiter = subscriber.pending.shift();
      if (waiter) {
        waiter({ value: event, done: false });
        continue;
      }
      subscriber.queue.push(event);
    }
  }

  subscribe(
    predicate: (event: TaskEvent) => boolean = () => true,
  ): AsyncIterableIterator<TaskEvent> {
    const subscriber: TaskSubscriber = {
      closed: false,
      predicate,
      queue: [],
      pending: [],
    };
    this.subscribers.add(subscriber);

    const close = () => {
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
        return Promise.reject(error);
      },
    };

    return iterator;
  }
}

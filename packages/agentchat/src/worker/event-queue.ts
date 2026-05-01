import type { DispatchEventInput } from '@penumbra/core';

export interface DispatchEventQueueOpts {
  send: (events: DispatchEventInput[]) => Promise<void>;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
}

export class DispatchEventQueue {
  private buffer: DispatchEventInput[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | null;
  private flushing = false;
  private readonly send: (events: DispatchEventInput[]) => Promise<void>;
  private readonly maxBatch: number;
  private readonly maxQueue: number;

  constructor(opts: DispatchEventQueueOpts) {
    this.send = opts.send;
    this.maxBatch = opts.maxBatch ?? 50;
    this.maxQueue = opts.maxQueue ?? 1000;
    this.timer = setInterval(() => {
      void this.flush();
    }, opts.flushIntervalMs ?? 500);
  }

  enqueue(event: DispatchEventInput): void {
    if (this.buffer.length >= this.maxQueue) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(event);
  }

  droppedCount(): number {
    return this.dropped;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.maxBatch);
        try {
          await this.send(batch);
        } catch {
          // Drop failed instrumentation batches.
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}

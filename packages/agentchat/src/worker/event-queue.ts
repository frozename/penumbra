import type { DispatchEventInput } from '@penumbra/core';

export interface DispatchEventQueueOpts {
  send: (events: DispatchEventInput[]) => Promise<void>;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
  sendTimeoutMs?: number;
}

export class DispatchEventQueue {
  private buffer: DispatchEventInput[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | null;
  private flushing = false;
  private flushPromise: Promise<void> | null = null;
  private readonly send: (events: DispatchEventInput[]) => Promise<void>;
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private readonly sendTimeoutMs: number;

  constructor(opts: DispatchEventQueueOpts) {
    this.send = opts.send;
    this.maxBatch = opts.maxBatch ?? 50;
    this.maxQueue = opts.maxQueue ?? 1000;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? 10_000;
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
    if (this.flushing) {
      await this.flushPromise;
      if (this.buffer.length === 0) return;
      return this.flush();
    }
    if (this.buffer.length === 0) return;
    this.flushing = true;
    this.flushPromise = (async () => {
      try {
        while (this.buffer.length > 0) {
          const batch = this.buffer.splice(0, this.maxBatch);
          try {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                this.send(batch),
                new Promise<void>((_, reject) => {
                  timeoutId = setTimeout(() => {
                    reject(new Error(`event_queue_send_timeout_${this.sendTimeoutMs}ms`));
                  }, this.sendTimeoutMs);
                }),
              ]);
            } finally {
              if (timeoutId) {
                clearTimeout(timeoutId);
              }
            }
          } catch {
            // Drop failed instrumentation batches.
          }
        }
      } finally {
        this.flushing = false;
        this.flushPromise = null;
      }
    })();
    await this.flushPromise;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}

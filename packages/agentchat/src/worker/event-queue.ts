import type { DispatchEventInput } from "@penumbra/core";

export interface DispatchEventQueueOpts {
  send: (events: DispatchEventInput[], signal: AbortSignal) => Promise<void>;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxQueue?: number;
  sendTimeoutMs?: number;
}

export class DispatchEventQueue {
  private buffer: DispatchEventInput[] = [];
  private dropped = 0;
  private sendFailures = 0;
  private timer: ReturnType<typeof setInterval> | null;
  private flushing = false;
  private flushPromise: Promise<void> | null = null;
  private readonly send: (events: DispatchEventInput[], signal: AbortSignal) => Promise<void>;
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

  sendFailureCount(): number {
    return this.sendFailures;
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushPromise;
      if (this.buffer.length === 0) return;
      await this.flush();
      return;
    }
    if (this.buffer.length === 0) return;
    this.flushing = true;
    this.flushPromise = (async (): Promise<void> => {
      try {
        while (this.buffer.length > 0) {
          const batch = this.buffer.splice(0, this.maxBatch);
          const controller = new AbortController();
          try {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                this.send(batch, controller.signal),
                new Promise<void>((_, reject) => {
                  timeoutId = setTimeout(() => {
                    reject(new Error(`event_queue_send_timeout_${String(this.sendTimeoutMs)}ms`));
                  }, this.sendTimeoutMs);
                }),
              ]);
            } finally {
              if (timeoutId) {
                clearTimeout(timeoutId);
              }
            }
          } catch {
            controller.abort(new Error(`event_queue_send_timeout_${String(this.sendTimeoutMs)}ms`));
            this.sendFailures++;
            this.buffer.unshift(...batch);
            while (this.buffer.length > this.maxQueue) {
              this.buffer.shift();
              this.dropped++;
            }
            break;
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

import type { Logger } from "@penumbra/core";

export class LagSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private maxLagMs = 0;
  private lastTickMs: number | null = null;

  constructor(
    private readonly log: Logger,
    private readonly thresholdMs: number,
    private readonly intervalMs: number = 2000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start() {
    if (this.timer) return;
    this.lastTickMs = this.now();
    this.timer = setInterval(() => {
      this.sample();
    }, this.intervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  sample() {
    const now = this.now();
    if (this.lastTickMs === null) {
      this.lastTickMs = now;
      return 0;
    }

    const delta = now - this.lastTickMs;
    this.lastTickMs = now;
    const lag = Math.max(0, delta - this.intervalMs);

    if (lag > this.maxLagMs) {
      this.maxLagMs = lag;
    }

    if (lag > this.thresholdMs) {
      this.log.warn(
        { lagMs: lag, thresholdMs: this.thresholdMs },
        "event-loop lag exceeded threshold",
      );
    }

    return lag;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastTickMs = null;
  }

  forceLag(ms: number) {
    if (ms > this.maxLagMs) {
      this.maxLagMs = ms;
    }
  }

  get maxLag() {
    return this.maxLagMs;
  }
}

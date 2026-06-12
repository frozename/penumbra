import type { Logger } from "@penumbra/core";

export const LAG_SAMPLER_WINDOW_MS = 60_000;

export class LagSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickMs: number | null = null;
  private readonly lagSamples: Array<{ timestampMs: number; lagMs: number }> = [];

  constructor(
    private readonly log: Logger,
    private readonly thresholdMs: number,
    private readonly intervalMs: number = 2000,
    private readonly monotonicNowMs: () => number = () => performance.now(),
    private readonly windowMs: number = LAG_SAMPLER_WINDOW_MS,
  ) {}

  start() {
    if (this.timer) return;
    this.lastTickMs = this.monotonicNowMs();
    this.timer = setInterval(() => {
      this.sample();
    }, this.intervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  sample() {
    const sampleNowMs = this.monotonicNowMs();
    if (this.lastTickMs === null) {
      this.lastTickMs = sampleNowMs;
      return 0;
    }

    const elapsedMs = sampleNowMs - this.lastTickMs;
    this.lastTickMs = sampleNowMs;
    const lag = Math.max(0, elapsedMs - this.intervalMs);

    this.pruneLagSamples(sampleNowMs);
    if (lag > 0) this.lagSamples.push({ timestampMs: sampleNowMs, lagMs: lag });

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
    this.lagSamples.length = 0;
  }

  get maxLagMs() {
    return this.maxLagMsAt(this.monotonicNowMs());
  }

  private maxLagMsAt(nowMs: number) {
    const cutoffMs = nowMs - this.windowMs;
    return this.lagSamples.reduce(
      (maxLagMs, sample) =>
        sample.timestampMs >= cutoffMs ? Math.max(maxLagMs, sample.lagMs) : maxLagMs,
      0,
    );
  }

  private pruneLagSamples(nowMs: number) {
    const cutoffMs = nowMs - this.windowMs;
    while (this.lagSamples.length > 0 && this.lagSamples[0]!.timestampMs < cutoffMs) {
      this.lagSamples.shift();
    }
  }
}

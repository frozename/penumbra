import type { Database } from 'bun:sqlite';
import {
  readSubscriptionPressure,
  type PressureResult,
  type PressureSnapshot,
} from '../readers/subscription-pressure.js';

export interface SubscriptionPressureCacheOptions {
  intervalMs?: number;
  staleAfterSeconds?: number;
  now?: () => Date;
  log?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

export interface SubscriptionPressureCache {
  start(): void;
  stop(): void;
  refresh(): void;
  get(provider: string, windowLabel: string): PressureSnapshot | null;
  forProvider(provider: string): PressureSnapshot[];
  lastUpdatedAt(): Date | null;
}

export function createSubscriptionPressureCache(
  db: Database,
  opts: SubscriptionPressureCacheOptions = {},
): SubscriptionPressureCache {
  const intervalMs = opts.intervalMs ?? 30_000;
  const cached: { result: PressureResult; lastUpdatedAt: Date | null } = {
    result: { snapshots: [], warnings: [] },
    lastUpdatedAt: null,
  };
  let timer: ReturnType<typeof setInterval> | null = null;

  const refresh = () => {
    try {
      cached.result = readSubscriptionPressure(db, {
        stale_after_seconds: opts.staleAfterSeconds,
        now: opts.now,
      });
      cached.lastUpdatedAt = new Date();
    } catch (error) {
      opts.log?.error?.(error);
    }
  };

  refresh();

  return {
    start() {
      if (timer) return;
      timer = setInterval(refresh, intervalMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    refresh,
    get(provider, windowLabel) {
      return cached.result.snapshots.find(snapshot => snapshot.provider === provider && snapshot.window_label === windowLabel) ?? null;
    },
    forProvider(provider) {
      return cached.result.snapshots.filter(snapshot => snapshot.provider === provider);
    },
    lastUpdatedAt() {
      return cached.lastUpdatedAt;
    },
  };
}

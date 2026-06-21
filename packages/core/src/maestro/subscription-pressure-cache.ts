import type { Database } from "bun:sqlite";

import {
  type PressureResult,
  type PressureSnapshot,
  readSubscriptionPressure,
} from "../readers/subscription-pressure.js";

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
  get(provider: string, windowLabel: string, model?: string | null): PressureSnapshot | null;
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

  const refresh = (): void => {
    try {
      cached.result = readSubscriptionPressure(db, {
        stale_after_seconds: opts.staleAfterSeconds,
        now: opts.now,
      });
      cached.lastUpdatedAt = new Date();
    } catch (error) {
      opts.log?.error(error);
    }
  };

  refresh();

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(refresh, intervalMs);
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    refresh,
    get(provider, windowLabel, model): PressureSnapshot | null {
      const expectedModel = model === undefined ? null : model;
      return (
        cached.result.snapshots.find(
          (snapshot) =>
            snapshot.provider === provider &&
            snapshot.window_label === windowLabel &&
            snapshot.model === expectedModel,
        ) ?? null
      );
    },
    forProvider(provider): PressureSnapshot[] {
      return cached.result.snapshots.filter((snapshot) => snapshot.provider === provider);
    },
    lastUpdatedAt(): Date | null {
      return cached.lastUpdatedAt;
    },
  };
}

import type { Database } from "bun:sqlite";
import { readSubscriptionPressure, type PressureResult } from "@penumbra/core";

export function isAnyProviderOverPressure(pressure: PressureResult): boolean {
  // Fail OPEN: stale snapshots must NOT throttle. Only FRESH snapshots count;
  // if every snapshot is stale (or none exist) we report not-throttled.
  const staleKeys = new Set(
    pressure.warnings
      .filter((w) => w.code === "stale_snapshot")
      .map((w) => `${w.provider} ${w.window_label}`),
  );
  return pressure.snapshots.some((snapshot) => {
    if (staleKeys.has(`${snapshot.provider} ${snapshot.window_label}`)) return false;
    return snapshot.used_pct >= 90 || snapshot.source_kind === "cooldown";
  });
}

export function checkDbPressure(db: Database): boolean {
  return isAnyProviderOverPressure(readSubscriptionPressure(db));
}

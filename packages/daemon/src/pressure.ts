import type { Database } from "bun:sqlite";

import { type PressureResult, readSubscriptionPressure } from "@penumbra/core";

export function isAnyProviderOverPressure(pressure: PressureResult): boolean {
  // Fail OPEN: stale snapshots must NOT throttle. Stale-keys include the
  // model dimension so a stale per-model warning cannot mask a fresh global
  // (model=null) over-pressure snapshot and vice versa — the reader's group
  // key is (provider, window_label, model), and this comparison must match
  // it exactly.
  const staleKeys = new Set(
    pressure.warnings.map((w) => `${w.provider} ${w.window_label} ${w.model ?? ""}`),
  );
  return pressure.snapshots.some((snapshot) => {
    if (staleKeys.has(`${snapshot.provider} ${snapshot.window_label} ${snapshot.model ?? ""}`)) {
      return false;
    }
    return snapshot.used_pct >= 90 || snapshot.source_kind === "cooldown";
  });
}

export function checkDbPressure(db: Database): boolean {
  return isAnyProviderOverPressure(readSubscriptionPressure(db));
}

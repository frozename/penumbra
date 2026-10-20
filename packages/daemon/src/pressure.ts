import type { Database } from "bun:sqlite";

import {
  buildPressureExcludedKeys,
  type PressureResult,
  pressureSnapshotKey,
  readSubscriptionPressure,
} from "@penumbra/core";

export function isAnyProviderOverPressure(pressure: PressureResult): boolean {
  const excludedKeys = buildPressureExcludedKeys(pressure);
  return pressure.snapshots.some((snapshot) => {
    if (excludedKeys.has(pressureSnapshotKey(snapshot))) {
      return false;
    }
    return snapshot.used_pct >= 90 || snapshot.source_kind === "cooldown";
  });
}

export function checkDbPressure(db: Database): boolean {
  return isAnyProviderOverPressure(readSubscriptionPressure(db));
}

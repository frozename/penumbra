import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { DaemonClient, type DaemonClientDeps } from "../api/client";
import { useDaemonStore } from "../stores/daemon-store";
import { usageSubscriptionPressure } from "../lib/query-keys";
import { HEARTBEAT_MS } from "../lib/timing";

export interface PressureWindowRow {
  used_pct: number;
  refuse_pct: number;
  warn_pct: number;
  provider: string;
  model: string;
  window_label: string;
}

export interface UsePressureSnapshotResult {
  windows: PressureWindowRow[];
  peakUsedPct: number;
  isLoading: boolean;
}

function makeDefaultClient(): DaemonClient {
  const deps: DaemonClientDeps = {
    getConfig: () => useDaemonStore.getState(),
  };
  return new DaemonClient(deps);
}

// UI thresholds — not part of the daemon wire shape. Kept here so consumers
// don't have to thread them.
const DEFAULT_WARN_PCT = 0.8;
const DEFAULT_REFUSE_PCT = 0.95;

function normalizeRow(x: unknown): PressureWindowRow | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.used_pct !== "number") return null;
  // Daemon emits 0-100; prototype/harness emits 0-1. Normalize to 0-1.
  const used_pct = r.used_pct > 1 ? r.used_pct / 100 : r.used_pct;
  return {
    used_pct,
    warn_pct: typeof r.warn_pct === "number"
      ? (r.warn_pct > 1 ? r.warn_pct / 100 : r.warn_pct)
      : DEFAULT_WARN_PCT,
    refuse_pct: typeof r.refuse_pct === "number"
      ? (r.refuse_pct > 1 ? r.refuse_pct / 100 : r.refuse_pct)
      : DEFAULT_REFUSE_PCT,
    provider: typeof r.provider === "string" ? r.provider : "",
    model: typeof r.model === "string" ? r.model : "",
    window_label: typeof r.window_label === "string" ? r.window_label : "",
  };
}

export function normalizePressureSnapshot(data: unknown): UsePressureSnapshotResult {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  // Accept both `snapshots` (daemon wire shape) and `windows` (legacy/harness shape).
  const raw = Array.isArray(obj.snapshots)
    ? obj.snapshots
    : Array.isArray(obj.windows)
      ? obj.windows
      : [];
  const windows = raw
    .map(normalizeRow)
    .filter((r): r is PressureWindowRow => r !== null);
  const peakUsedPct = windows.reduce((m: number, w: PressureWindowRow) => Math.max(m, w.used_pct), 0);
  return { windows, peakUsedPct, isLoading: false };
}

export function usePressureSnapshot(opts?: { client?: DaemonClient }): UsePressureSnapshotResult {
  const client = useMemo(() => opts?.client ?? makeDefaultClient(), [opts?.client]);
  const query = useQuery({
    queryKey: usageSubscriptionPressure(),
    queryFn: async () => client.getSubscriptionPressure(),
    refetchInterval: HEARTBEAT_MS,
  });
  const normalized = useMemo(() => normalizePressureSnapshot(query.data), [query.data]);
  return { ...normalized, isLoading: query.isLoading };
}

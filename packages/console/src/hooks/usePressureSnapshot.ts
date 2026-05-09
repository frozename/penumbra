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

function isWindowRow(x: unknown): x is PressureWindowRow {
  return !!x && typeof x === "object" && typeof (x as any).used_pct === "number" && typeof (x as any).refuse_pct === "number" && typeof (x as any).warn_pct === "number";
}

export function normalizePressureSnapshot(data: unknown): UsePressureSnapshotResult {
  const raw = data && typeof data === "object" && Array.isArray((data as any).windows) ? (data as any).windows : [];
  const windows = raw.filter(isWindowRow);
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

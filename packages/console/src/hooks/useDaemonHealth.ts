import { useEffect, useMemo } from "react";
import { DaemonClient, type DaemonClientDeps } from "../api/client";
import { useDaemonStore } from "../stores/daemon-store";

export interface UseDaemonHealthOpts {
  client?: DaemonClient;
  intervalMs?: number;
}

function makeDefaultClient(): DaemonClient {
  const deps: DaemonClientDeps = {
    getConfig: () => useDaemonStore.getState(),
  };
  return new DaemonClient(deps);
}

export function useDaemonHealth(
  opts?: UseDaemonHealthOpts,
): "unknown" | "ok" | "down" {
  const client = useMemo(() => opts?.client ?? makeDefaultClient(), [opts?.client]);
  const intervalMs = opts?.intervalMs ?? 5_000;
  const health = useDaemonStore((s) => s.health);

  useEffect(() => {
    let isMounted = true;
    const poll = async () => {
      try {
        await client.health();
        if (!isMounted) return;
        useDaemonStore.getState().setHealth("ok", Date.now());
      } catch {
        if (!isMounted) return;
        useDaemonStore.getState().setHealth("down", Date.now());
      }
    };

    void poll();
    const timer = globalThis.setInterval(() => {
      void poll();
    }, intervalMs);

    return () => {
      isMounted = false;
      globalThis.clearInterval(timer);
    };
  }, [client, intervalMs]);

  return health;
}

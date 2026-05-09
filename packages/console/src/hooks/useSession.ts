import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { DaemonClient, type DaemonClientDeps } from "../api/client";
import { useDaemonStore } from "../stores/daemon-store";
import type { MissionSession } from "@penumbra/api-contract";
import { COOL_POLL_MS } from "../lib/timing";

function makeDefaultClient(): DaemonClient {
  const deps: DaemonClientDeps = {
    getConfig: () => useDaemonStore.getState(),
  };
  return new DaemonClient(deps);
}

export function useSession(opts?: { client?: DaemonClient }): {
  data: MissionSession | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const client = useMemo(() => opts?.client ?? makeDefaultClient(), [opts?.client]);
  const query = useQuery({
    queryKey: ["session", "current"] as const,
    queryFn: async () => client.getSession(),
    staleTime: COOL_POLL_MS,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error : null,
  };
}

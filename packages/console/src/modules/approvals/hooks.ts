import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { DaemonClient } from "@src/api/client";
import { COOL_POLL_MS } from "@src/lib/timing";
import { useDaemonStore } from "@src/stores/daemon-store";

import type { ApprovalItem } from "./queues/types";

import { QUEUES } from "./queues";

export function useApprovalsCount(): number {
  const client = useMemo(
    (): DaemonClient => new DaemonClient({ getConfig: () => useDaemonStore.getState() }),
    [],
  );
  let sum = 0;
  for (const q of QUEUES) {
    const { data } = useQuery({
      queryKey: q.queryKey(),
      queryFn: (): Promise<ApprovalItem[]> => q.fetch(client),
      refetchInterval: COOL_POLL_MS,
    });
    sum += data?.length ?? 0;
  }
  return sum;
}

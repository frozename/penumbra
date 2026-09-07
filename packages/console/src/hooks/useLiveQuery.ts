import {
  type QueryKey,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { ModuleId } from "../modules/manifest.js";

import {
  getStreamState,
  onStreamStateChange,
  type StreamState,
  type StreamTopic,
  subscribe,
} from "../api/streams.js";
import { HEARTBEAT_MS } from "../lib/timing.js";
import { useUIStore } from "../stores/ui-store.js";

export interface UseLiveQueryOpts<T> {
  queryKey: QueryKey;
  queryFn: () => Promise<T>;
  owner: ModuleId;
  topic?: StreamTopic;
  pollMs?: number;
  enabled?: boolean;
}

interface InternalUseLiveQueryOpts {
  /** @internal */
  subscribeImpl?: typeof subscribe;
}

export function useLiveQuery<T>(
  o: UseLiveQueryOpts<T>,
  internal?: InternalUseLiveQueryOpts,
): UseQueryResult<T> & { live: StreamState["state"] } {
  if ("patch" in o) {
    throw new Error("useLiveQuery: patch mode is not supported");
  }

  const activeModule = useUIStore((s) => s.activeModule);
  const active = activeModule === o.owner && o.enabled !== false;
  const queryClient = useQueryClient();
  const subscribeImpl = internal?.subscribeImpl ?? subscribe;

  const queryKeyRef = useRef(o.queryKey);
  queryKeyRef.current = o.queryKey;

  useEffect((): (() => void) | undefined => {
    if (!active || !o.topic) return;
    const topic = o.topic;
    const sub = subscribeImpl(topic, () => {
      void queryClient.invalidateQueries({ queryKey: queryKeyRef.current });
    });
    return (): void => {
      sub.unsubscribe();
    };
  }, [active, o.topic, subscribeImpl, queryClient]);

  const refetchInterval = active ? (o.topic ? false : (o.pollMs ?? HEARTBEAT_MS)) : false;

  const query = useQuery({
    queryKey: o.queryKey,
    queryFn: o.queryFn,
    enabled: active,
    refetchInterval,
  });

  const live = useStreamState().state;
  return { ...query, live };
}

export function useStreamState(): StreamState {
  const [state, setState] = useState<StreamState>(() => getStreamState());

  useEffect((): (() => void) => {
    const unsub = onStreamStateChange((): void => {
      setState(getStreamState());
    });
    setState(getStreamState());
    return unsub;
  }, []);

  return state;
}

import { useEffect, useMemo, useRef, useState } from "react";
import {
  subscribe,
  type StreamMessage,
  type StreamTopic,
  type Subscription,
} from "../api/streams";

export interface UseStreamOpts {
  params?: Record<string, string>;
  enabled?: boolean;
}

export interface UseStreamResult<T> {
  messages: ReadonlyArray<StreamMessage<T>>;
  reconnected: boolean;
}

interface InternalUseStreamOpts {
  /** @internal */
  subscribeImpl?: typeof subscribe;
}

function canonicalParams(params?: Record<string, string>): string {
  return JSON.stringify(Object.entries(params ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

export function useStream<T = unknown>(
  topic: StreamTopic,
  opts?: UseStreamOpts,
  internal?: InternalUseStreamOpts,
): UseStreamResult<T> {
  const enabled = opts?.enabled ?? true;
  const subscribeImpl = internal?.subscribeImpl ?? subscribe;
  const paramsKey = useMemo(() => canonicalParams(opts?.params), [opts?.params]);
  const messagesRef = useRef<StreamMessage<T>[]>([]);
  const subscriptionRef = useRef<Subscription | null>(null);
  const [snapshot, setSnapshot] = useState<ReadonlyArray<StreamMessage<T>>>([]);
  const [reconnected, setReconnected] = useState(false);

  useEffect(() => {
    if (!enabled) {
      subscriptionRef.current?.unsubscribe();
      subscriptionRef.current = null;
      return;
    }

    const sub = subscribeImpl<T>(topic, (msg) => {
      if (msg.event === "__reconnect__") {
        messagesRef.current = [];
        setSnapshot([]);
        setReconnected(true);
        return;
      }

      messagesRef.current.push(msg);
      setSnapshot([...messagesRef.current]);
    }, { params: opts?.params });

    subscriptionRef.current?.unsubscribe();
    subscriptionRef.current = sub;

    return () => {
      sub.unsubscribe();
      if (subscriptionRef.current === sub) {
        subscriptionRef.current = null;
      }
    };
  }, [enabled, paramsKey, subscribeImpl, topic]);

  return { messages: snapshot, reconnected };
}

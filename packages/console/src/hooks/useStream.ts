import { useEffect, useMemo, useRef, useState } from "react";
import {
  paramsKey,
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
  reconnectCount: number;
}

interface InternalUseStreamOpts {
  /** @internal */
  subscribeImpl?: typeof subscribe;
}

export function useStream<T = unknown>(
  topic: StreamTopic,
  opts?: UseStreamOpts,
  internal?: InternalUseStreamOpts,
): UseStreamResult<T> {
  const enabled = opts?.enabled ?? true;
  const subscribeImpl = internal?.subscribeImpl ?? subscribe;
  const pkey = useMemo(() => paramsKey(opts?.params), [opts?.params]);
  const messagesRef = useRef<StreamMessage<T>[]>([]);
  const subscriptionRef = useRef<Subscription | null>(null);
  const [snapshot, setSnapshot] = useState<ReadonlyArray<StreamMessage<T>>>([]);
  const [reconnectCount, setReconnectCount] = useState(0);

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
        setReconnectCount((n) => n + 1);
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
  }, [enabled, pkey, subscribeImpl, topic]);

  return { messages: snapshot, reconnectCount };
}

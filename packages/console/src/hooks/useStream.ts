import { useEffect, useMemo, useRef, useState } from "react";

import {
  paramsKey,
  type StreamMessage,
  type StreamTopic,
  subscribe,
  type Subscription,
} from "../api/streams.js";

const DEFAULT_BUFFER_SIZE = 200;

export interface UseStreamOpts {
  params?: Record<string, string>;
  enabled?: boolean;
  /**
   * Maximum number of messages to retain. When exceeded, the oldest entry is
   * dropped on each push so memory stays bounded for long-running, high-traffic
   * streams. Default `200` (matches the broker's ring cap).
   */
  bufferSize?: number;
}

export interface UseStreamResult<T> {
  messages: readonly StreamMessage<T>[];
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
  const bufferSize = opts?.bufferSize ?? DEFAULT_BUFFER_SIZE;
  const subscribeImpl = internal?.subscribeImpl ?? subscribe;
  const pkey = useMemo(() => paramsKey(opts?.params), [opts?.params]);
  const subscriptionRef = useRef<Subscription | null>(null);
  const [snapshot, setSnapshot] = useState<readonly StreamMessage<T>[]>([]);
  const [reconnectCount, setReconnectCount] = useState(0);

  useEffect(() => {
    setSnapshot((prev) => {
      if (bufferSize === 0) {
        return [];
      }

      if (prev.length > bufferSize) {
        return prev.slice(prev.length - bufferSize);
      }

      return prev;
    });
  }, [bufferSize]);

  useEffect(() => {
    if (!enabled) {
      subscriptionRef.current?.unsubscribe();
      subscriptionRef.current = null;
      return;
    }

    const sub = subscribeImpl<T>(
      topic,
      (msg) => {
        if (msg.event === "__reconnect__") {
          setSnapshot([]);
          setReconnectCount((n) => n + 1);
          return;
        }

        setSnapshot((prev) =>
          bufferSize === 0
            ? []
            : prev.length >= bufferSize
              ? [...prev.slice(prev.length - bufferSize + 1), msg]
              : [...prev, msg],
        );
      },
      { params: opts?.params },
    );

    const buffered = sub.tail() as readonly StreamMessage<T>[];
    if (buffered.length) {
      setSnapshot((prev) => {
        const merged = prev.length ? prev : buffered;
        return bufferSize === 0 ? [] : merged.slice(-bufferSize);
      });
    }

    subscriptionRef.current?.unsubscribe();
    subscriptionRef.current = sub;

    return (): void => {
      sub.unsubscribe();
      if (subscriptionRef.current === sub) {
        subscriptionRef.current = null;
      }
    };
  }, [enabled, pkey, subscribeImpl, topic, bufferSize]);

  return { messages: snapshot, reconnectCount };
}

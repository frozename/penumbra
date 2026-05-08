import { useDaemonStore } from "../stores/daemon-store";
import {
  createSseSource,
  type EventSourceLike,
  type ShimOpts,
} from "./event-source-shim";

const TOPIC_PATHS = {
  "dispatch-events": "/dispatch-events/stream",
} as const;

export type StreamTopic = keyof typeof TOPIC_PATHS;

export interface StreamMessage<T> {
  event: string;
  data: T;
  raw: MessageEvent | { reconnect: true };
}

export interface SubscribeOpts {
  params?: Record<string, string>;
}

export interface Subscription {
  unsubscribe: () => void;
  tail: () => readonly StreamMessage<unknown>[];
}

export interface StreamBrokerDeps {
  getConfig: () => { baseUrl: string; token: string };
  sourceFactory?: (opts: ShimOpts) => EventSourceLike;
  scheduler?: {
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
  };
  clock?: () => number;
}

export interface StreamBroker {
  subscribe<T>(
    topic: StreamTopic,
    onMessage: (msg: StreamMessage<T>) => void,
    opts?: SubscribeOpts,
  ): Subscription;
  /** Test helper: drop all entries + close all sources. */
  reset(): void;
}

const RING_CAP = 200;
const LINGER_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

interface BrokerEntry {
  key: string;
  topic: StreamTopic;
  baseUrl: string;
  params?: Record<string, string>;
  source: EventSourceLike | null;
  refcount: number;
  lingerHandle: unknown;
  reconnectHandle: unknown;
  reconnectAttempt: number;
  awaitingReconnectAck: boolean;
  ring: StreamMessage<unknown>[];
  subscribers: Set<(msg: StreamMessage<unknown>) => void>;
}

type SetTimeoutLike = (fn: () => void, ms: number) => unknown;
type ClearTimeoutLike = (handle: unknown) => void;

export function paramsKey(params?: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(params ?? {}).sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function topicPath(topic: StreamTopic): string {
  const path = TOPIC_PATHS[topic];
  if (!path) throw new Error(`unknown stream topic: ${String(topic)}`);
  return path;
}

function buildUrl(
  baseUrl: string,
  topic: StreamTopic,
  params?: Record<string, string>,
): string {
  const path = topicPath(topic);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) q.set(k, v);
  const qs = q.toString();
  return new URL(path + (qs ? `?${qs}` : ""), baseUrl).toString();
}

export function createStreamBroker(deps: StreamBrokerDeps): StreamBroker {
  const setTimeoutImpl: SetTimeoutLike = deps.scheduler
    ? (fn, ms) => deps.scheduler!.setTimeout(fn, ms)
    : (fn, ms) => globalThis.setTimeout(fn, ms);
  const clearTimeoutImpl: ClearTimeoutLike = deps.scheduler
    ? (h) => deps.scheduler!.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>)
    : (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>);
  const factory = deps.sourceFactory ?? createSseSource;
  const entries = new Map<string, BrokerEntry>();

  function pushToRing(
    entry: BrokerEntry,
    msg: StreamMessage<unknown>,
  ): void {
    entry.ring.push(msg);
    if (entry.ring.length > RING_CAP) {
      entry.ring.splice(0, entry.ring.length - RING_CAP);
    }
  }

  function dispatchToSubscribers(
    entry: BrokerEntry,
    msg: StreamMessage<unknown>,
  ): void {
    for (const sub of entry.subscribers) {
      try {
        sub(msg);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[stream:${entry.topic}] subscriber threw`, err);
      }
    }
  }

  function openSource(entry: BrokerEntry): void {
    const { token } = deps.getConfig();
    const url = buildUrl(entry.baseUrl, entry.topic, entry.params);
    const source = factory({
      url,
      headers: { Authorization: `Bearer ${token}` },
      onTransportError: (err) => handleTransportError(entry, err),
    });
    entry.source = source;

    source.addEventListener("message", (raw) => {
      // First real (non-synthetic) message after a reconnect: tell subscribers
      // their snapshot may be stale, drop the ring, reset backoff. Then deliver
      // the new message so it lands in the now-empty ring.
      if (entry.awaitingReconnectAck) {
        entry.awaitingReconnectAck = false;
        entry.reconnectAttempt = 0;
        entry.ring = [];
        const reconnectMsg: StreamMessage<unknown> = {
          event: "__reconnect__",
          data: { reconnect: true } as unknown,
          raw: { reconnect: true },
        };
        dispatchToSubscribers(entry, reconnectMsg);
      }

      let data: unknown;
      try {
        data = JSON.parse(raw.data);
      } catch {
        data = raw.data;
      }
      const msg: StreamMessage<unknown> = {
        event: raw.type,
        data,
        raw: raw as unknown as MessageEvent,
      };
      pushToRing(entry, msg);
      dispatchToSubscribers(entry, msg);
    });
  }

  function handleTransportError(entry: BrokerEntry, err: unknown): void {
    // eslint-disable-next-line no-console
    console.warn(`[stream:${entry.topic}] transport error`, err);
    if (entry.source) {
      try {
        entry.source.close();
      } catch {
        /* ignore */
      }
      entry.source = null;
    }
    entry.awaitingReconnectAck = true;
    scheduleReconnect(entry);
  }

  function scheduleReconnect(entry: BrokerEntry): void {
    if (entry.reconnectHandle != null) return;
    const idx = Math.min(entry.reconnectAttempt, BACKOFF_MS.length - 1);
    const delay = BACKOFF_MS[idx]!;
    entry.reconnectHandle = setTimeoutImpl(() => {
      entry.reconnectHandle = null;
      entry.reconnectAttempt += 1;
      if (entry.refcount === 0) return;
      openSource(entry);
    }, delay);
  }

  function subscribe<T>(
    topic: StreamTopic,
    onMessage: (msg: StreamMessage<T>) => void,
    opts?: SubscribeOpts,
  ): Subscription {
    if (!(topic in TOPIC_PATHS)) {
      throw new Error(`unknown stream topic: ${String(topic)}`);
    }
    const { baseUrl } = deps.getConfig();
    const pkey = paramsKey(opts?.params);
    const key = `${baseUrl}|${topic}|${pkey}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key,
        topic,
        baseUrl,
        params: opts?.params ? { ...opts.params } : undefined,
        source: null,
        refcount: 0,
        lingerHandle: null,
        reconnectHandle: null,
        reconnectAttempt: 0,
        awaitingReconnectAck: false,
        ring: [],
        subscribers: new Set(),
      };
      entries.set(key, entry);
    }

    if (entry.lingerHandle != null) {
      clearTimeoutImpl(entry.lingerHandle);
      entry.lingerHandle = null;
    }

    const subscriber = onMessage as (msg: StreamMessage<unknown>) => void;
    entry.subscribers.add(subscriber);
    entry.refcount += 1;

    if (entry.source == null && entry.reconnectHandle == null) {
      entry.reconnectAttempt = 0;
      entry.awaitingReconnectAck = false;
      openSource(entry);
    }

    const captured = entry;
    let unsubscribed = false;

    return {
      tail: () => captured.ring.slice() as readonly StreamMessage<unknown>[],
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        if (!captured.subscribers.has(subscriber)) return;
        captured.subscribers.delete(subscriber);
        captured.refcount -= 1;
        if (captured.refcount > 0) return;
        captured.lingerHandle = setTimeoutImpl(() => {
          captured.lingerHandle = null;
          if (captured.refcount > 0) return;
          if (captured.source) {
            try {
              captured.source.close();
            } catch {
              /* ignore */
            }
            captured.source = null;
          }
          if (captured.reconnectHandle != null) {
            clearTimeoutImpl(captured.reconnectHandle);
            captured.reconnectHandle = null;
          }
          entries.delete(captured.key);
        }, LINGER_MS);
      },
    };
  }

  function reset(): void {
    for (const e of entries.values()) {
      if (e.lingerHandle != null) clearTimeoutImpl(e.lingerHandle);
      if (e.reconnectHandle != null) clearTimeoutImpl(e.reconnectHandle);
      e.source?.close();
    }
    entries.clear();
  }

  return { subscribe, reset };
}

// ---- default broker (module-scope) ----------------------------------------
//
// `__setSchedulers` and `__setSourceFactory` mutate these holders so the
// existing test suite can swap in a fake clock + fake fetch without
// reconstructing the broker.

let mutableScheduler: {
  setTimeout: SetTimeoutLike;
  clearTimeout: ClearTimeoutLike;
} = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) =>
    globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};
let mutableSourceFactory: (opts: ShimOpts) => EventSourceLike = createSseSource;

const defaultBroker = createStreamBroker({
  getConfig: () => {
    const s = useDaemonStore.getState();
    return { baseUrl: s.baseUrl, token: s.token };
  },
  scheduler: {
    setTimeout: ((fn: () => void, ms: number) =>
      mutableScheduler.setTimeout(fn, ms)) as unknown as typeof globalThis.setTimeout,
    clearTimeout: ((h: unknown) =>
      mutableScheduler.clearTimeout(h)) as unknown as typeof globalThis.clearTimeout,
  },
  sourceFactory: (opts) => mutableSourceFactory(opts),
});

export const subscribe = defaultBroker.subscribe;

export function __setSchedulers(
  s: typeof globalThis.setTimeout,
  c: typeof globalThis.clearTimeout,
): void {
  mutableScheduler = {
    setTimeout: s as unknown as SetTimeoutLike,
    clearTimeout: c as unknown as ClearTimeoutLike,
  };
}

export function __setSourceFactory(
  factoryOrNull: ((opts: ShimOpts) => EventSourceLike) | null,
): void {
  mutableSourceFactory = factoryOrNull ?? createSseSource;
}

export function __resetBrokerForTests(): void {
  defaultBroker.reset();
  mutableScheduler = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) =>
      globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
  };
  mutableSourceFactory = createSseSource;
}

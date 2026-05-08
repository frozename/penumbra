import { useDaemonStore } from "../stores/daemon-store";
import {
  createSseSource,
  type EventSourceLike,
  type ShimOpts,
} from "./event-source-shim";

export type StreamTopic =
  | "handoffs-events"
  | "tasks-events"
  | "dispatch-events-stream";

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

const RING_CAP = 200;
const LINGER_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

interface BrokerEntry {
  key: string;
  topic: StreamTopic;
  params?: Record<string, string>;
  source: EventSourceLike | null;
  refcount: number;
  lingerHandle: unknown;
  reconnectHandle: unknown;
  reconnectAttempt: number;
  ring: StreamMessage<unknown>[];
  subscribers: Set<(msg: StreamMessage<unknown>) => void>;
}

type SetTimeoutLike = (fn: () => void, ms: number) => unknown;
type ClearTimeoutLike = (handle: unknown) => void;

const entries = new Map<string, BrokerEntry>();
let setTimeoutImpl: SetTimeoutLike = (fn, ms) => globalThis.setTimeout(fn, ms);
let clearTimeoutImpl: ClearTimeoutLike = (h) =>
  globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>);
let sourceFactory: (opts: ShimOpts) => EventSourceLike = createSseSource;

export function __setSchedulers(
  s: typeof globalThis.setTimeout,
  c: typeof globalThis.clearTimeout,
): void {
  setTimeoutImpl = s as unknown as SetTimeoutLike;
  clearTimeoutImpl = c as unknown as ClearTimeoutLike;
}

export function __setSourceFactory(
  factory: ((opts: ShimOpts) => EventSourceLike) | null,
): void {
  sourceFactory = factory ?? createSseSource;
}

export function __resetBrokerForTests(): void {
  for (const e of entries.values()) {
    if (e.lingerHandle != null) clearTimeoutImpl(e.lingerHandle);
    if (e.reconnectHandle != null) clearTimeoutImpl(e.reconnectHandle);
    e.source?.close();
  }
  entries.clear();
  setTimeoutImpl = (fn, ms) => globalThis.setTimeout(fn, ms);
  clearTimeoutImpl = (h) =>
    globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>);
  sourceFactory = createSseSource;
}

function paramsKey(params?: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(params ?? {}).sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function topicPath(topic: StreamTopic): string {
  if (topic === "dispatch-events-stream") return "/dispatch-events/stream";
  return `/${topic.replace(/-events/, "/events")}`;
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
      console.error("stream subscriber threw", err);
    }
  }
}

function openSource(entry: BrokerEntry): void {
  const { baseUrl, token } = useDaemonStore.getState();
  const url = buildUrl(baseUrl, entry.topic, entry.params);
  const source = sourceFactory({
    url,
    headers: { Authorization: `Bearer ${token}` },
    onTransportError: (err) => handleTransportError(entry, err),
  });
  entry.source = source;

  source.addEventListener("message", (raw) => {
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

function handleTransportError(entry: BrokerEntry, _err: unknown): void {
  if (entry.source) {
    try {
      entry.source.close();
    } catch {
      /* ignore */
    }
    entry.source = null;
  }
  entry.ring = [];
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
    const reconnectMsg: StreamMessage<unknown> = {
      event: "__reconnect__",
      data: { reconnect: true } as unknown,
      raw: { reconnect: true },
    };
    dispatchToSubscribers(entry, reconnectMsg);
  }, delay);
}

export function subscribe<T>(
  topic: StreamTopic,
  onMessage: (msg: StreamMessage<T>) => void,
  opts?: SubscribeOpts,
): Subscription {
  const pkey = paramsKey(opts?.params);
  const key = `${topic}::${pkey}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      key,
      topic,
      params: opts?.params ? { ...opts.params } : undefined,
      source: null,
      refcount: 0,
      lingerHandle: null,
      reconnectHandle: null,
      reconnectAttempt: 0,
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

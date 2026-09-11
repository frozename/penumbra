import { buildRequestUrl } from "../lib/url.js";
import { useDaemonStore } from "../stores/daemon-store.js";
import {
  createSseSource,
  type EventSourceLike,
  type ShimOpts,
  SseConnectError,
} from "./event-source-shim.js";

export type TopicSpec =
  | string
  | {
      path: (p: Record<string, string>) => string;
      consumes: readonly string[];
      sample: Record<string, string>;
    };

export const TOPIC_PATHS = {
  "dispatch-events": "/dispatch/events/stream",
  "permission-events": "/permissions/events",
  "handoff-events": "/handoffs/events",
  "task-events": "/tasks/events",
  conversation: {
    path: (p: Record<string, string>): string =>
      `/conversations/${encodeURIComponent(p.id ?? "")}/stream`,
    consumes: ["id"],
    sample: { id: "c1" },
  },
} as const satisfies Record<string, TopicSpec>;

export type StreamTopic = keyof typeof TOPIC_PATHS;

export type RawStreamEvent = { data: string; type: string } | { reconnect: true };

export interface StreamMessage<T> {
  event: string;
  data: T;
  raw: RawStreamEvent;
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

export type StreamState = { state: "connected" | "reconnecting" | "off"; ringSize: number };

export interface StreamBroker {
  subscribe<T>(
    topic: StreamTopic,
    onMessage: (msg: StreamMessage<T>) => void,
    opts?: SubscribeOpts,
  ): Subscription;
  getStreamState(): StreamState;
  onStreamStateChange(cb: () => void): () => void;
  /** Test helper: drop all entries + close all sources. */
  reset(): void;
}

const RING_CAP = 200;
const LINGER_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
// Time a fresh connection must stay open before we treat it as "healthy" and
// clear the reconnect backoff counter. onConnected fires on HTTP headers-OK
// (response.ok in the shim) before any byte is read; an accept-then-die loop
// (e.g. daemon mid-restart) would otherwise repeat BACKOFF_MS[0]=1s forever.
const HEALTH_CONFIRM_MS = 2_000;

interface BrokerEntry {
  key: string;
  topic: StreamTopic;
  baseUrl: string;
  params?: Record<string, string>;
  source: EventSourceLike | null;
  refcount: number;
  lingerHandle: unknown;
  reconnectHandle: unknown;
  healthConfirmHandle: unknown;
  reconnectAttempt: number;
  awaitingReconnectAck: boolean;
  terminal: boolean;
  ring: StreamMessage<unknown>[];
  subscribers: Set<(msg: StreamMessage<unknown>) => void>;
}

type SetTimeoutLike = (fn: () => void, ms: number) => unknown;
type ClearTimeoutLike = (handle: unknown) => void;

interface BrokerCtx {
  entries: Map<string, BrokerEntry>;
  factory: (opts: ShimOpts) => EventSourceLike;
  setTimeoutImpl: SetTimeoutLike;
  clearTimeoutImpl: ClearTimeoutLike;
  getConfig: () => { baseUrl: string; token: string };
  stateListeners: Set<() => void>;
  lastStateValue: "connected" | "reconnecting" | "off";
}

export function paramsKey(params?: Record<string, string>): string {
  return JSON.stringify(Object.entries(params ?? {}).sort((a, b) => a[0].localeCompare(b[0])));
}

function computeBrokerState(entries: Map<string, BrokerEntry>): StreamState {
  if (entries.size === 0) return { state: "off", ringSize: 0 };
  let reconnecting = false;
  let ringSize = 0;
  let hasLive = false;
  for (const e of entries.values()) {
    if (e.terminal) continue;
    hasLive = true;
    if (e.awaitingReconnectAck || e.reconnectHandle !== null) {
      reconnecting = true;
    }
    if (e.ring.length > ringSize) {
      ringSize = e.ring.length;
    }
  }
  if (!hasLive) return { state: "off", ringSize };
  return { state: reconnecting ? "reconnecting" : "connected", ringSize };
}

function notifyStateChange(ctx: BrokerCtx): void {
  const { state } = computeBrokerState(ctx.entries);
  if (state === ctx.lastStateValue) return;
  ctx.lastStateValue = state;
  for (const cb of ctx.stateListeners) {
    try {
      cb();
    } catch (err) {
      console.error("[stream] state listener threw", err);
    }
  }
}

function resolveTopicUrl(
  baseUrl: string,
  topic: StreamTopic,
  params?: Record<string, string>,
): string {
  const spec = TOPIC_PATHS[topic];
  if (typeof spec === "string") {
    return buildRequestUrl(baseUrl, spec, params);
  }
  const consumed: Record<string, string> = {};
  for (const key of spec.consumes) {
    consumed[key] = params?.[key] ?? "";
  }
  const path = spec.path(consumed);
  const remaining: Record<string, string> = {};
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (!spec.consumes.some((c) => c === k)) {
        remaining[k] = v;
      }
    }
  }
  return buildRequestUrl(baseUrl, path, Object.keys(remaining).length > 0 ? remaining : undefined);
}

function validateConsumedParams(topic: StreamTopic, params?: Record<string, string>): void {
  const spec = TOPIC_PATHS[topic];
  if (typeof spec === "string") return;
  for (const key of spec.consumes) {
    const val = params?.[key];
    if (typeof val !== "string" || val === "") {
      throw new Error(`stream topic "${topic as string}" requires param "${key}"`);
    }
  }
}

function pushToRing(entry: BrokerEntry, msg: StreamMessage<unknown>): void {
  entry.ring.push(msg);
  if (entry.ring.length > RING_CAP) {
    entry.ring.splice(0, entry.ring.length - RING_CAP);
  }
}

function dispatchToSubscribers(entry: BrokerEntry, msg: StreamMessage<unknown>): void {
  for (const sub of entry.subscribers) {
    try {
      sub(msg);
    } catch (err) {
      console.error(`[stream:${entry.topic}] subscriber threw`, err);
    }
  }
}

function dispatchReconnectSynthetic(ctx: BrokerCtx, entry: BrokerEntry): void {
  entry.awaitingReconnectAck = false;
  // reconnectAttempt is reset by the health-confirm timer, NOT here — this
  // fires on HTTP headers-OK before any byte is read, so an accept-then-die
  // loop would otherwise never escape BACKOFF_MS[0].
  entry.ring = [];
  const reconnectMsg: StreamMessage<unknown> = {
    event: "__reconnect__",
    data: { reconnect: true },
    raw: { reconnect: true },
  };
  dispatchToSubscribers(entry, reconnectMsg);
  notifyStateChange(ctx);
}

function handleMessage(
  ctx: BrokerCtx,
  entry: BrokerEntry,
  raw: { data: string; type: string },
): void {
  if (entry.awaitingReconnectAck) {
    dispatchReconnectSynthetic(ctx, entry);
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
    raw,
  };
  pushToRing(entry, msg);
  dispatchToSubscribers(entry, msg);
}

function openSource(ctx: BrokerCtx, entry: BrokerEntry): void {
  const { token } = ctx.getConfig();
  const url = resolveTopicUrl(entry.baseUrl, entry.topic, entry.params);
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const source = ctx.factory({
    url,
    headers,
    onConnected: (): void => {
      if (entry.awaitingReconnectAck) {
        dispatchReconnectSynthetic(ctx, entry);
      }
      if (entry.healthConfirmHandle !== null) {
        ctx.clearTimeoutImpl(entry.healthConfirmHandle);
      }
      entry.healthConfirmHandle = ctx.setTimeoutImpl((): void => {
        entry.healthConfirmHandle = null;
        entry.reconnectAttempt = 0;
      }, HEALTH_CONFIRM_MS);
    },
    onTransportError: (err): void => {
      handleTransportError(ctx, entry, err);
    },
  });
  entry.source = source;
  source.addEventListener("message", (raw) => {
    handleMessage(ctx, entry, raw);
  });
}

function handleTransportError(ctx: BrokerCtx, entry: BrokerEntry, err: unknown): void {
  console.warn(`[stream:${entry.topic}] transport error`, err);
  if (entry.healthConfirmHandle !== null) {
    ctx.clearTimeoutImpl(entry.healthConfirmHandle);
    entry.healthConfirmHandle = null;
  }
  if (entry.source) {
    try {
      entry.source.close();
    } catch {
      /* ignore */
    }
    entry.source = null;
  }
  if (err instanceof SseConnectError && err.status === 401) {
    entry.terminal = true;
    entry.awaitingReconnectAck = false;
    if (entry.reconnectHandle !== null) {
      ctx.clearTimeoutImpl(entry.reconnectHandle);
      entry.reconnectHandle = null;
    }
    useDaemonStore.getState().setSessionInvalid(true);
    notifyStateChange(ctx);
    return;
  }
  entry.awaitingReconnectAck = true;
  scheduleReconnect(ctx, entry);
  notifyStateChange(ctx);
}

function scheduleReconnect(ctx: BrokerCtx, entry: BrokerEntry): void {
  if (entry.reconnectHandle !== null) return;
  const idx = Math.min(entry.reconnectAttempt, BACKOFF_MS.length - 1);
  const delay = BACKOFF_MS[idx] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 1_000;
  entry.reconnectHandle = ctx.setTimeoutImpl(() => {
    entry.reconnectHandle = null;
    notifyStateChange(ctx);
    entry.reconnectAttempt += 1;
    if (entry.refcount === 0) return;
    openSource(ctx, entry);
  }, delay);
  notifyStateChange(ctx);
}

function ensureEntry(
  ctx: BrokerCtx,
  topic: StreamTopic,
  baseUrl: string,
  key: string,
  params?: Record<string, string>,
): BrokerEntry {
  let entry = ctx.entries.get(key);
  if (!entry) {
    entry = {
      key,
      topic,
      baseUrl,
      params: params ? { ...params } : undefined,
      source: null,
      refcount: 0,
      lingerHandle: null,
      reconnectHandle: null,
      healthConfirmHandle: null,
      reconnectAttempt: 0,
      awaitingReconnectAck: false,
      terminal: false,
      ring: [],
      subscribers: new Set(),
    };
    ctx.entries.set(key, entry);
  }
  return entry;
}

function lingerTeardown(ctx: BrokerCtx, captured: BrokerEntry): void {
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
  if (captured.reconnectHandle !== null) {
    ctx.clearTimeoutImpl(captured.reconnectHandle);
    captured.reconnectHandle = null;
  }
  if (captured.healthConfirmHandle !== null) {
    ctx.clearTimeoutImpl(captured.healthConfirmHandle);
    captured.healthConfirmHandle = null;
  }
  ctx.entries.delete(captured.key);
  notifyStateChange(ctx);
}

function makeUnsubscribe(
  ctx: BrokerCtx,
  captured: BrokerEntry,
  subscriber: (msg: StreamMessage<unknown>) => void,
): () => void {
  let unsubscribed = false;
  return (): void => {
    if (unsubscribed) return;
    unsubscribed = true;
    if (!captured.subscribers.has(subscriber)) return;
    captured.subscribers.delete(subscriber);
    captured.refcount -= 1;
    if (captured.refcount > 0) return;
    captured.lingerHandle = ctx.setTimeoutImpl((): void => {
      lingerTeardown(ctx, captured);
    }, LINGER_MS);
  };
}

function subscribeOn<T>(
  ctx: BrokerCtx,
  topic: StreamTopic,
  onMessage: (msg: StreamMessage<T>) => void,
  opts?: SubscribeOpts,
): Subscription {
  if (!(topic in TOPIC_PATHS)) {
    throw new Error(`unknown stream topic: ${topic as string}`);
  }
  validateConsumedParams(topic, opts?.params);
  const { baseUrl } = ctx.getConfig();
  const pkey = paramsKey(opts?.params);
  const key = `${baseUrl}|${topic}|${pkey}`;
  const entry = ensureEntry(ctx, topic, baseUrl, key, opts?.params);

  if (entry.lingerHandle !== null) {
    ctx.clearTimeoutImpl(entry.lingerHandle);
    entry.lingerHandle = null;
  }

  const subscriber = onMessage as (msg: StreamMessage<unknown>) => void;
  entry.subscribers.add(subscriber);
  entry.refcount += 1;

  if (entry.source === null && entry.reconnectHandle === null) {
    entry.reconnectAttempt = 0;
    entry.awaitingReconnectAck = false;
    openSource(ctx, entry);
  }
  notifyStateChange(ctx);

  return {
    tail: (): readonly StreamMessage<unknown>[] => entry.ring.slice(),
    unsubscribe: makeUnsubscribe(ctx, entry, subscriber),
  };
}

function resetCtx(ctx: BrokerCtx): void {
  for (const e of ctx.entries.values()) {
    if (e.lingerHandle !== null) ctx.clearTimeoutImpl(e.lingerHandle);
    if (e.reconnectHandle !== null) ctx.clearTimeoutImpl(e.reconnectHandle);
    if (e.healthConfirmHandle !== null) ctx.clearTimeoutImpl(e.healthConfirmHandle);
    e.source?.close();
  }
  ctx.entries.clear();
  notifyStateChange(ctx);
}

function makeSetTimeoutImpl(deps: StreamBrokerDeps): SetTimeoutLike {
  const scheduler = deps.scheduler;
  if (scheduler) {
    return (fn, ms): unknown => scheduler.setTimeout(fn, ms);
  }
  return (fn, ms): unknown => globalThis.setTimeout(fn, ms);
}

function makeClearTimeoutImpl(deps: StreamBrokerDeps): ClearTimeoutLike {
  const scheduler = deps.scheduler;
  if (scheduler) {
    return (h): void => {
      scheduler.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>);
    };
  }
  return (h): void => {
    globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>);
  };
}

function createDefaultSseSource(opts: ShimOpts): EventSourceLike {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return createSseSource({ ...opts, fetchImpl });
}

export function createStreamBroker(deps: StreamBrokerDeps): StreamBroker {
  const ctx: BrokerCtx = {
    entries: new Map(),
    factory: deps.sourceFactory ?? createDefaultSseSource,
    setTimeoutImpl: makeSetTimeoutImpl(deps),
    clearTimeoutImpl: makeClearTimeoutImpl(deps),
    getConfig: deps.getConfig,
    stateListeners: new Set(),
    lastStateValue: "off",
  };
  return {
    subscribe<T>(
      topic: StreamTopic,
      onMessage: (msg: StreamMessage<T>) => void,
      opts?: SubscribeOpts,
    ): Subscription {
      return subscribeOn(ctx, topic, onMessage, opts);
    },
    getStreamState(): StreamState {
      return computeBrokerState(ctx.entries);
    },
    onStreamStateChange(cb: () => void): () => void {
      ctx.stateListeners.add(cb);
      return (): void => {
        ctx.stateListeners.delete(cb);
      };
    },
    reset(): void {
      resetCtx(ctx);
    },
  };
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
  setTimeout: (fn, ms): unknown => globalThis.setTimeout(fn, ms),
  clearTimeout: (h): void => {
    globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>);
  },
};
let mutableSourceFactory: (opts: ShimOpts) => EventSourceLike = createDefaultSseSource;

const defaultBroker = createStreamBroker({
  getConfig: (): { baseUrl: string; token: string } => {
    const s = useDaemonStore.getState();
    return { baseUrl: s.baseUrl, token: s.token };
  },
  scheduler: {
    setTimeout: ((fn: () => void, ms: number) =>
      mutableScheduler.setTimeout(fn, ms)) as unknown as typeof globalThis.setTimeout,
    clearTimeout: (h: unknown): void => {
      mutableScheduler.clearTimeout(h);
    },
  },
  sourceFactory: (opts): EventSourceLike => mutableSourceFactory(opts),
});

export const subscribe = defaultBroker.subscribe.bind(defaultBroker);

export function getStreamState(): StreamState {
  return defaultBroker.getStreamState();
}

export function onStreamStateChange(cb: () => void): () => void {
  return defaultBroker.onStreamStateChange(cb);
}

export function __setSchedulers(
  s: typeof globalThis.setTimeout,
  c: typeof globalThis.clearTimeout,
): void {
  mutableScheduler = {
    setTimeout: s,
    clearTimeout: (h: unknown): void => {
      c(h as ReturnType<typeof globalThis.setTimeout>);
    },
  };
}

export function __setSourceFactory(
  factoryOrNull: ((opts: ShimOpts) => EventSourceLike) | null,
): void {
  mutableSourceFactory = factoryOrNull ?? createDefaultSseSource;
}

export function __resetBrokerForTests(): void {
  defaultBroker.reset();
  mutableScheduler = {
    setTimeout: (fn, ms): unknown => globalThis.setTimeout(fn, ms),
    clearTimeout: (h): void => {
      globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>);
    },
  };
  mutableSourceFactory = createDefaultSseSource;
}

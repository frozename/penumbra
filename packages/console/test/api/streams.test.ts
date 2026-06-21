import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { EventSourceLike, ShimOpts } from "../../src/api/event-source-shim.js";

import {
  __resetBrokerForTests,
  __setSchedulers,
  createStreamBroker,
  paramsKey,
  type StreamBrokerDeps,
  type StreamMessage,
  subscribe,
} from "../../src/api/streams.js";
import { useDaemonStore } from "../../src/stores/daemon-store.js";

interface SseFakeController {
  send(event: string, data: string): void;
  sendRaw(text: string): void;
  error(err: unknown): void;
  close(): void;
}

interface MockSseSession {
  url: string;
  init: RequestInit | undefined;
  controller: SseFakeController;
}

// Each subscriber callback must have a distinct function identity because
// stream broker entries dedupe subscribers via `Set.add`. A shared `noop`
// would cause the second subscribe() call to no-op the dedupe, so refcount
// and the unsubscribe handshake desync. Produce a fresh callback per call.
function noop(): () => void {
  return () => {
    /* intentional no-op */
  };
}

function createMockSseResponse(): { response: Response; controller: SseFakeController } {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c): void {
      ctrl = c;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const enc = new TextEncoder();
  const controller: SseFakeController = {
    send(event, data): void {
      const evtPart = event === "message" ? "" : `event: ${event}\n`;
      const dataPart = data
        .split("\n")
        .map((l) => `data: ${l}`)
        .join("\n");
      ctrl.enqueue(enc.encode(`${evtPart}${dataPart}\n\n`));
    },
    sendRaw(text): void {
      ctrl.enqueue(enc.encode(text));
    },
    error(err): void {
      ctrl.error(err);
    },
    close(): void {
      ctrl.close();
    },
  };
  return { response, controller };
}

class FakeClock {
  now = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;
  setTimeout = ((fn: (...a: unknown[]) => void, delay: number) => {
    const id = this.nextId++;
    this.timers.push({
      id,
      at: this.now + delay,
      fn: (): void => {
        fn();
      },
    });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as unknown as typeof globalThis.setTimeout;
  clearTimeout = ((handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== (handle as number));
  }) as unknown as typeof globalThis.clearTimeout;
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t.id !== next.id);
      this.now = next.at;
      next.fn();
    }
    this.now = target;
  }
}

const sessions: MockSseSession[] = [];
const originalFetch = globalThis.fetch;

let pendingResponses: { response: Response; controller: SseFakeController }[];

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

beforeEach(() => {
  __resetBrokerForTests();
  sessions.length = 0;
  pendingResponses = [];
  useDaemonStore.setState({
    baseUrl: "http://127.0.0.1:51257",
    token: "tok-test",
    health: "unknown",
    lastHealthAt: null,
  });
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    const entry = pendingResponses.shift() ?? createMockSseResponse();
    sessions.push({ url, init, controller: entry.controller });
    return Promise.resolve(entry.response);
  }) as typeof fetch;
});

afterEach(() => {
  __resetBrokerForTests();
  globalThis.fetch = originalFetch;
});

describe("streams broker", () => {
  test("two subscribers to same topic+params share one fetch", async () => {
    const sub1 = subscribe("dispatch-events", noop());
    const sub2 = subscribe("dispatch-events", noop());
    await flushMicrotasks();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.init?.credentials).toBe("include");
    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("refcount linger: 30s closes; 29s does not", async () => {
    const clock = new FakeClock();
    __setSchedulers(clock.setTimeout, clock.clearTimeout);

    const sub1 = subscribe("dispatch-events", noop());
    await flushMicrotasks();
    expect(sessions).toHaveLength(1);
    const initialSignal = sessions[0]!.init?.signal;
    expect(initialSignal).toBeDefined();

    sub1.unsubscribe();
    clock.advance(29_000);
    expect(initialSignal?.aborted).toBe(false);
    clock.advance(1_000);
    expect(initialSignal?.aborted).toBe(true);
  });

  test("linger is canceled when a new subscriber arrives", async () => {
    const clock = new FakeClock();
    __setSchedulers(clock.setTimeout, clock.clearTimeout);

    const sub1 = subscribe("dispatch-events", noop());
    await flushMicrotasks();
    const initialSignal = sessions[0]!.init?.signal;
    expect(initialSignal).toBeDefined();

    sub1.unsubscribe();
    clock.advance(20_000);
    const sub2 = subscribe("dispatch-events", noop());
    clock.advance(60_000);

    expect(initialSignal?.aborted).toBe(false);
    expect(sessions).toHaveLength(1); // still one — refcount kept it alive
    sub2.unsubscribe();
  });

  test("different paramsKey isolates connections", async () => {
    const subA = subscribe("dispatch-events", noop(), {
      params: { kind: "a" },
    });
    const subB = subscribe("dispatch-events", noop(), {
      params: { kind: "b" },
    });
    await flushMicrotasks();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.url).toContain("kind=a");
    expect(sessions[1]!.url).toContain("kind=b");
    subA.unsubscribe();
    subB.unsubscribe();
  });

  test("paramsKey canonicalizes key order", async () => {
    const sub1 = subscribe("dispatch-events", noop(), {
      params: { a: "1", b: "2" },
    });
    const sub2 = subscribe("dispatch-events", noop(), {
      params: { b: "2", a: "1" },
    });
    await flushMicrotasks();

    expect(sessions).toHaveLength(1);
    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("ring buffer caps at 200 and tail() returns last 200", async () => {
    const sub = subscribe("dispatch-events", noop());
    await flushMicrotasks();
    const ctrl = sessions[0]!.controller;
    let bigChunk = "";
    for (let i = 0; i < 250; i++) {
      bigChunk += `data: ${JSON.stringify({ i })}\n\n`;
    }
    ctrl.sendRaw(bigChunk);
    await flushMicrotasks();

    const tail = sub.tail();
    expect(tail).toHaveLength(200);
    expect((tail[0]!.data as { i: number }).i).toBe(50);
    expect((tail[199]!.data as { i: number }).i).toBe(249);
    sub.unsubscribe();
  });

  test("new subscriber sees buffered tail()", async () => {
    const sub1 = subscribe("dispatch-events", noop());
    await flushMicrotasks();
    const ctrl = sessions[0]!.controller;
    for (let i = 0; i < 5; i++) ctrl.send("message", JSON.stringify({ i }));
    await flushMicrotasks();

    const sub2 = subscribe("dispatch-events", noop());
    expect(sub2.tail()).toHaveLength(5);
    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("__reconnect__ does NOT fire on transport error; fires on new-conn establishment", async () => {
    const clock = new FakeClock();
    __setSchedulers(clock.setTimeout, clock.clearTimeout);

    pendingResponses = [createMockSseResponse(), createMockSseResponse()];
    const got: StreamMessage<unknown>[] = [];
    const sub = subscribe<unknown>("dispatch-events", (m) => got.push(m));
    await flushMicrotasks();
    expect(sessions).toHaveLength(1);

    sessions[0]!.controller.send("message", JSON.stringify({ k: 1 }));
    await flushMicrotasks();
    expect(sub.tail()).toHaveLength(1);

    sessions[0]!.controller.error(new Error("boom"));
    await flushMicrotasks();

    // Critical: __reconnect__ MUST NOT have been emitted yet — the connection
    // is down and no new connection has been established.
    expect(got.filter((m) => m.event === "__reconnect__")).toHaveLength(0);
    // Ring still holds the pre-outage message until the new connection drops it.
    expect(sub.tail()).toHaveLength(1);

    clock.advance(1_000);
    await flushMicrotasks();
    expect(sessions).toHaveLength(2);

    // The synthetic fires as soon as the new connection establishes (so the UI
    // can show the "reconnected" banner immediately, before the next message
    // — which may be only a keepalive comment).
    const reconnectMsgs = got.filter((m) => m.event === "__reconnect__");
    expect(reconnectMsgs).toHaveLength(1);
    expect(reconnectMsgs[0]!.data).toEqual({ reconnect: true });
    // Ring was reset on the reconnect ack.
    expect(sub.tail()).toHaveLength(0);

    sessions[1]!.controller.send("message", JSON.stringify({ k: 2 }));
    await flushMicrotasks();

    // Still exactly one __reconnect__ — subsequent messages don't re-fire it.
    expect(got.filter((m) => m.event === "__reconnect__")).toHaveLength(1);
    const tail = sub.tail();
    expect(tail).toHaveLength(1);
    expect((tail[0]!.data as { k: number }).k).toBe(2);

    sub.unsubscribe();
  });

  test("backoff resets after a healthy reconnect (next outage delays 1s, not 2s)", async () => {
    const clock = new FakeClock();
    __setSchedulers(clock.setTimeout, clock.clearTimeout);

    pendingResponses = [createMockSseResponse(), createMockSseResponse(), createMockSseResponse()];
    const sub = subscribe("dispatch-events", noop());
    await flushMicrotasks();
    expect(sessions).toHaveLength(1);

    // First outage → 1s backoff.
    sessions[0]!.controller.error(new Error("boom1"));
    await flushMicrotasks();
    clock.advance(1_000);
    await flushMicrotasks();
    expect(sessions).toHaveLength(2);

    // Healthy message on new conn — must reset the backoff counter.
    sessions[1]!.controller.send("message", JSON.stringify({ ok: true }));
    await flushMicrotasks();

    // Second outage. Without a reset, attempt would be 1 → next delay 2s.
    sessions[1]!.controller.error(new Error("boom2"));
    await flushMicrotasks();

    // Advancing 999ms must NOT open a new connection.
    clock.advance(999);
    await flushMicrotasks();
    expect(sessions).toHaveLength(2);

    // 1ms more (total 1s since outage) must open it.
    clock.advance(1);
    await flushMicrotasks();
    expect(sessions).toHaveLength(3);

    sub.unsubscribe();
  });

  test("subscriber error isolation — one throws, others still receive", async () => {
    const errorSpy = mock((..._args: unknown[]): void => {
      /* spy */
    });
    const origError = console.error;
    console.error = errorSpy;

    const aReceived: StreamMessage<unknown>[] = [];
    const bReceived: StreamMessage<unknown>[] = [];
    const subA = subscribe("dispatch-events", () => {
      aReceived.push({} as StreamMessage<unknown>);
      throw new Error("nope");
    });
    const subB = subscribe("dispatch-events", (m) => {
      bReceived.push(m);
    });
    await flushMicrotasks();

    sessions[0]!.controller.send("message", JSON.stringify({ k: 1 }));
    sessions[0]!.controller.send("message", JSON.stringify({ k: 2 }));
    await flushMicrotasks();

    expect(bReceived).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalled();

    console.error = origError;
    subA.unsubscribe();
    subB.unsubscribe();
  });

  test("auth header: passes Bearer token from daemon-store when token is set", async () => {
    const sub = subscribe("dispatch-events", noop());
    await flushMicrotasks();

    expect(sessions[0]!.url).toBe("http://127.0.0.1:51257/dispatch-events/stream");
    expect(sessions[0]!.init?.credentials).toBe("include");
    const headers = (sessions[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-test");
    sub.unsubscribe();
  });

  test("auth header: omits Bearer token when token is empty", async () => {
    useDaemonStore.setState({
      baseUrl: "http://127.0.0.1:51257",
      token: "",
      health: "unknown",
      lastHealthAt: null,
    });
    const sub = subscribe("dispatch-events", noop());
    await flushMicrotasks();

    expect(sessions[0]!.init?.credentials).toBe("include");
    const headers = (sessions[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    sub.unsubscribe();
  });

  test("relative trailing-slash baseUrl avoids double slash in SSE URL", async () => {
    useDaemonStore.setState({
      baseUrl: "/api/",
      token: "",
      health: "unknown",
      lastHealthAt: null,
    });
    const sub = subscribe("dispatch-events", noop());
    await flushMicrotasks();

    expect(sessions[0]!.url).toBe("/api/dispatch-events/stream");
    sub.unsubscribe();
  });

  test("unknown topic throws (runtime guard against stringly-typed callers)", () => {
    // Intentional unsafe cast: this test asserts the runtime guard rejects
    // stringly-typed callers that bypass the StreamTopic union at the type level.
    expect(() => subscribe("not-a-topic" as "dispatch-events", noop())).toThrow(
      /unknown stream topic/,
    );
  });
});

describe("paramsKey", () => {
  test("canonicalizes key order so {a,b} === {b,a}", () => {
    expect(paramsKey({ a: "1", b: "2" })).toBe(paramsKey({ b: "2", a: "1" }));
  });

  test("undefined and {} produce the same key", () => {
    expect(paramsKey(undefined)).toBe(paramsKey({}));
  });
});

// ---- Per-broker harness for direct broker-instance tests --------------------
//
// The test cases above drive the default broker singleton through the global
// `__setSchedulers` mutator. The cases below construct broker instances with
// their own injected scheduler + sourceFactory so we can verify that
// `createStreamBroker(deps)` correctly routes the dep wiring (rather than
// silently falling back to the module-scope holders) and that state machines
// like backoff and refcount are scoped per-instance.

interface FakeSseHandle {
  url: string;
  emit: (event: string, data: string) => void;
  isClosed: () => boolean;
  triggerError: (err: unknown) => void;
}

function createFakeSseFactory(): {
  factory: (opts: ShimOpts) => EventSourceLike;
  sources: FakeSseHandle[];
} {
  const sources: FakeSseHandle[] = [];
  const factory = (opts: ShimOpts): EventSourceLike => {
    const listeners = new Map<string, ((msg: { data: string; type: string }) => void)[]>();
    let closed = false;
    sources.push({
      url: opts.url,
      isClosed: (): boolean => closed,
      emit(event, data): void {
        if (closed) return;
        const arr = listeners.get(event);
        if (arr) for (const l of arr) l({ data, type: event });
      },
      triggerError(err): void {
        opts.onTransportError?.(err);
      },
    });
    return {
      addEventListener(
        event: string,
        listener: (msg: { data: string; type: string }) => void,
      ): void {
        let arr = listeners.get(event);
        if (!arr) {
          arr = [];
          listeners.set(event, arr);
        }
        arr.push(listener);
      },
      close(): void {
        closed = true;
      },
    };
  };
  return { factory, sources };
}

describe("createStreamBroker", () => {
  test("two brokers with different baseUrl open SEPARATE fetches for the same topic", async () => {
    const fetchedUrls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = urlOf(input);
      fetchedUrls.push(url);
      const { response } = createMockSseResponse();
      return Promise.resolve(response);
    }) as typeof fetch;

    const deps = (baseUrl: string): StreamBrokerDeps => ({
      getConfig: (): { baseUrl: string; token: string } => ({ baseUrl, token: "t" }),
    });
    const a = createStreamBroker(deps("http://a.local:1111"));
    const b = createStreamBroker(deps("http://b.local:2222"));

    const subA = a.subscribe("dispatch-events", noop());
    const subB = b.subscribe("dispatch-events", noop());
    await flushMicrotasks();

    expect(fetchedUrls).toHaveLength(2);
    expect(fetchedUrls.some((u) => u.startsWith("http://a.local:1111/"))).toBe(true);
    expect(fetchedUrls.some((u) => u.startsWith("http://b.local:2222/"))).toBe(true);

    subA.unsubscribe();
    subB.unsubscribe();
    a.reset();
    b.reset();
    globalThis.fetch = origFetch;
  });

  test("same broker: cache key includes baseUrl — config change opens a fresh fetch", async () => {
    const fetchedUrls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = urlOf(input);
      fetchedUrls.push(url);
      const { response } = createMockSseResponse();
      return Promise.resolve(response);
    }) as typeof fetch;

    let baseUrl = "http://first.local:1000";
    const broker = createStreamBroker({
      getConfig: (): { baseUrl: string; token: string } => ({ baseUrl, token: "t" }),
    });

    const sub1 = broker.subscribe("dispatch-events", noop());
    await flushMicrotasks();
    baseUrl = "http://second.local:2000";
    const sub2 = broker.subscribe("dispatch-events", noop());
    await flushMicrotasks();

    expect(fetchedUrls).toHaveLength(2);
    sub1.unsubscribe();
    sub2.unsubscribe();
    broker.reset();
    globalThis.fetch = origFetch;
  });

  test("F4-1: two brokers with independent fake schedulers; reconnect ack only fires on first new-conn message", async () => {
    const clockA = new FakeClock();
    const clockB = new FakeClock();
    const fakeA = createFakeSseFactory();
    const fakeB = createFakeSseFactory();

    const a = createStreamBroker({
      getConfig: (): { baseUrl: string; token: string } => ({
        baseUrl: "http://a.local:1111",
        token: "ta",
      }),
      scheduler: {
        setTimeout: clockA.setTimeout,
        clearTimeout: clockA.clearTimeout,
      },
      sourceFactory: fakeA.factory,
    });
    const b = createStreamBroker({
      getConfig: (): { baseUrl: string; token: string } => ({
        baseUrl: "http://b.local:2222",
        token: "tb",
      }),
      scheduler: {
        setTimeout: clockB.setTimeout,
        clearTimeout: clockB.clearTimeout,
      },
      sourceFactory: fakeB.factory,
    });

    const gotA: StreamMessage<unknown>[] = [];
    const gotB: StreamMessage<unknown>[] = [];
    const subA = a.subscribe<unknown>("dispatch-events", (m) => gotA.push(m));
    const subB = b.subscribe<unknown>("dispatch-events", (m) => gotB.push(m));
    await flushMicrotasks();

    expect(fakeA.sources).toHaveLength(1);
    expect(fakeB.sources).toHaveLength(1);

    // Drive transport error on broker A only.
    fakeA.sources[0]!.triggerError(new Error("boom-a"));
    await flushMicrotasks();
    // Reconnect ack must NOT fire on the error itself.
    expect(gotA.filter((m) => m.event === "__reconnect__")).toHaveLength(0);
    // Broker B stays untouched.
    expect(gotB.filter((m) => m.event === "__reconnect__")).toHaveLength(0);

    // Advance ONLY clockA — clockB must not open any new conn.
    clockA.advance(1_000);
    await flushMicrotasks();
    expect(fakeA.sources).toHaveLength(2);
    expect(fakeB.sources).toHaveLength(1);
    expect(gotA.filter((m) => m.event === "__reconnect__")).toHaveLength(0);

    // First real message on the new A connection delivers __reconnect__ + the message.
    fakeA.sources[1]!.emit("message", JSON.stringify({ k: "a-new" }));
    await flushMicrotasks();
    const reconA = gotA.filter((m) => m.event === "__reconnect__");
    expect(reconA).toHaveLength(1);
    expect(reconA[0]!.data).toEqual({ reconnect: true });
    expect(gotB.filter((m) => m.event === "__reconnect__")).toHaveLength(0);

    subA.unsubscribe();
    subB.unsubscribe();
    a.reset();
    b.reset();
  });

  test("F4-2: backoff resets after a healthy reconnect (next outage delays 1s, not 2s)", async () => {
    const clock = new FakeClock();
    const fake = createFakeSseFactory();
    const broker = createStreamBroker({
      getConfig: (): { baseUrl: string; token: string } => ({
        baseUrl: "http://x.local:3333",
        token: "t",
      }),
      scheduler: {
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      },
      sourceFactory: fake.factory,
    });

    const sub = broker.subscribe("dispatch-events", noop());
    await flushMicrotasks();
    expect(fake.sources).toHaveLength(1);

    // First outage → 1s backoff.
    fake.sources[0]!.triggerError(new Error("boom1"));
    await flushMicrotasks();
    clock.advance(1_000);
    await flushMicrotasks();
    expect(fake.sources).toHaveLength(2);

    // Healthy message on new connection — must reset the backoff counter.
    fake.sources[1]!.emit("message", JSON.stringify({ ok: true }));
    await flushMicrotasks();

    // Second outage. Without reset, next backoff would be 2s.
    fake.sources[1]!.triggerError(new Error("boom2"));
    await flushMicrotasks();

    clock.advance(999);
    await flushMicrotasks();
    expect(fake.sources).toHaveLength(2); // not yet

    clock.advance(1);
    await flushMicrotasks();
    expect(fake.sources).toHaveLength(3); // opened at 1s, confirming reset

    sub.unsubscribe();
    broker.reset();
  });

  test("F4-3: ring buffer is reset on the __reconnect__ ack", async () => {
    const clock = new FakeClock();
    const fake = createFakeSseFactory();
    const broker = createStreamBroker({
      getConfig: (): { baseUrl: string; token: string } => ({
        baseUrl: "http://r.local:4444",
        token: "t",
      }),
      scheduler: {
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      },
      sourceFactory: fake.factory,
    });

    const sub = broker.subscribe("dispatch-events", noop());
    await flushMicrotasks();

    for (let i = 0; i < 5; i++) {
      fake.sources[0]!.emit("message", JSON.stringify({ pre: i }));
    }
    await flushMicrotasks();
    expect(sub.tail()).toHaveLength(5);

    fake.sources[0]!.triggerError(new Error("blip"));
    await flushMicrotasks();
    // Ring still holds the 5 pre-outage messages until the new conn delivers.
    expect(sub.tail()).toHaveLength(5);

    clock.advance(1_000);
    await flushMicrotasks();
    expect(fake.sources).toHaveLength(2);

    fake.sources[1]!.emit("message", JSON.stringify({ post: 1 }));
    await flushMicrotasks();

    const tail = sub.tail();
    expect(tail).toHaveLength(1);
    expect((tail[0]!.data as { post: number }).post).toBe(1);

    sub.unsubscribe();
    broker.reset();
  });

  // F4-4 (two brokers with different baseUrl open SEPARATE fetches) is covered
  // by the existing "two brokers with different baseUrl open SEPARATE fetches"
  // test above.

  test("F4-5: refcount + linger is scoped per broker instance", async () => {
    const clockA = new FakeClock();
    const clockB = new FakeClock();
    const fakeA = createFakeSseFactory();
    const fakeB = createFakeSseFactory();

    const a = createStreamBroker({
      getConfig: (): { baseUrl: string; token: string } => ({
        baseUrl: "http://a.local:5555",
        token: "ta",
      }),
      scheduler: {
        setTimeout: clockA.setTimeout,
        clearTimeout: clockA.clearTimeout,
      },
      sourceFactory: fakeA.factory,
    });
    const b = createStreamBroker({
      getConfig: (): { baseUrl: string; token: string } => ({
        baseUrl: "http://b.local:6666",
        token: "tb",
      }),
      scheduler: {
        setTimeout: clockB.setTimeout,
        clearTimeout: clockB.clearTimeout,
      },
      sourceFactory: fakeB.factory,
    });

    const a1 = a.subscribe("dispatch-events", noop());
    const a2 = a.subscribe("dispatch-events", noop());
    const b1 = b.subscribe("dispatch-events", noop());
    await flushMicrotasks();

    expect(fakeA.sources).toHaveLength(1);
    expect(fakeB.sources).toHaveLength(1);

    // Close both A subscribers — A enters linger.
    a1.unsubscribe();
    a2.unsubscribe();

    // Before linger expires, A's source is still open and B's untouched.
    clockA.advance(29_000);
    expect(fakeA.sources[0]!.isClosed()).toBe(false);
    expect(fakeB.sources[0]!.isClosed()).toBe(false);

    clockA.advance(1_001);
    expect(fakeA.sources[0]!.isClosed()).toBe(true);
    // B has its own clock and refcount; advancing A's clock had zero effect on B.
    expect(fakeB.sources[0]!.isClosed()).toBe(false);

    b1.unsubscribe();
    // B not yet expired (B's clock has not advanced).
    expect(fakeB.sources[0]!.isClosed()).toBe(false);
    clockB.advance(30_001);
    expect(fakeB.sources[0]!.isClosed()).toBe(true);

    a.reset();
    b.reset();
  });
});

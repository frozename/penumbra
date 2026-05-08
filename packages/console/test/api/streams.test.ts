import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __resetBrokerForTests,
  __setSchedulers,
  createStreamBroker,
  paramsKey,
  subscribe,
  type StreamBrokerDeps,
  type StreamMessage,
} from "../../src/api/streams";
import { useDaemonStore } from "../../src/stores/daemon-store";

interface SseFakeController {
  send(event: string, data: string): void;
  sendRaw(text: string): void;
  error(err: unknown): void;
  close(): void;
}

interface MockSseSession {
  url: string;
  init?: RequestInit;
  controller: SseFakeController;
}

function createMockSseResponse(): { response: Response; controller: SseFakeController } {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const enc = new TextEncoder();
  const controller: SseFakeController = {
    send(event, data) {
      const evtPart = event === "message" ? "" : `event: ${event}\n`;
      const dataPart = data
        .split("\n")
        .map((l) => `data: ${l}`)
        .join("\n");
      ctrl.enqueue(enc.encode(`${evtPart}${dataPart}\n\n`));
    },
    sendRaw(text) {
      ctrl.enqueue(enc.encode(text));
    },
    error(err) {
      ctrl.error(err);
    },
    close() {
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
    this.timers.push({ id, at: this.now + delay, fn: () => fn() });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as unknown as typeof globalThis.setTimeout;
  clearTimeout = ((handle: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== (handle as number));
  }) as unknown as typeof globalThis.clearTimeout;
  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
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

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
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
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    let entry = pendingResponses.shift();
    if (!entry) entry = createMockSseResponse();
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
    const sub1 = subscribe("dispatch-events", () => {});
    const sub2 = subscribe("dispatch-events", () => {});
    await flushMicrotasks();

    expect(sessions).toHaveLength(1);
    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("refcount linger: 30s closes; 29s does not", async () => {
    const clock = new FakeClock();
    __setSchedulers(clock.setTimeout, clock.clearTimeout);

    const sub1 = subscribe("dispatch-events", () => {});
    await flushMicrotasks();
    expect(sessions).toHaveLength(1);
    const initialSignal = sessions[0]!.init?.signal as AbortSignal;

    sub1.unsubscribe();
    clock.advance(29_000);
    expect(initialSignal.aborted).toBe(false);
    clock.advance(1_000);
    expect(initialSignal.aborted).toBe(true);
  });

  test("linger is canceled when a new subscriber arrives", async () => {
    const clock = new FakeClock();
    __setSchedulers(clock.setTimeout, clock.clearTimeout);

    const sub1 = subscribe("dispatch-events", () => {});
    await flushMicrotasks();
    const initialSignal = sessions[0]!.init?.signal as AbortSignal;

    sub1.unsubscribe();
    clock.advance(20_000);
    const sub2 = subscribe("dispatch-events", () => {});
    clock.advance(60_000);

    expect(initialSignal.aborted).toBe(false);
    expect(sessions).toHaveLength(1); // still one — refcount kept it alive
    sub2.unsubscribe();
  });

  test("different paramsKey isolates connections", async () => {
    const subA = subscribe("dispatch-events", () => {}, {
      params: { kind: "a" },
    });
    const subB = subscribe("dispatch-events", () => {}, {
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
    const sub1 = subscribe("dispatch-events", () => {}, {
      params: { a: "1", b: "2" },
    });
    const sub2 = subscribe("dispatch-events", () => {}, {
      params: { b: "2", a: "1" },
    });
    await flushMicrotasks();

    expect(sessions).toHaveLength(1);
    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("ring buffer caps at 200 and tail() returns last 200", async () => {
    const sub = subscribe("dispatch-events", () => {});
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
    const sub1 = subscribe("dispatch-events", () => {});
    await flushMicrotasks();
    const ctrl = sessions[0]!.controller;
    for (let i = 0; i < 5; i++) ctrl.send("message", JSON.stringify({ i }));
    await flushMicrotasks();

    const sub2 = subscribe("dispatch-events", () => {});
    expect(sub2.tail()).toHaveLength(5);
    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("__reconnect__ does NOT fire on transport error; fires on first new-conn message", async () => {
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

    // Critical: __reconnect__ MUST NOT have been emitted yet.
    expect(got.filter((m) => m.event === "__reconnect__")).toHaveLength(0);
    // Ring still holds the pre-outage message until the new connection delivers.
    expect(sub.tail()).toHaveLength(1);

    clock.advance(1_000);
    await flushMicrotasks();
    expect(sessions).toHaveLength(2);
    // Still no __reconnect__ — the new connection hasn't delivered anything yet.
    expect(got.filter((m) => m.event === "__reconnect__")).toHaveLength(0);

    sessions[1]!.controller.send("message", JSON.stringify({ k: 2 }));
    await flushMicrotasks();

    const reconnectMsgs = got.filter((m) => m.event === "__reconnect__");
    expect(reconnectMsgs).toHaveLength(1);
    expect(reconnectMsgs[0]!.data).toEqual({ reconnect: true });

    // Ring was reset on the reconnect ack, then the new message landed.
    const tail = sub.tail();
    expect(tail).toHaveLength(1);
    expect((tail[0]!.data as { k: number }).k).toBe(2);

    sub.unsubscribe();
  });

  test("backoff resets after a healthy reconnect (next outage delays 1s, not 2s)", async () => {
    const clock = new FakeClock();
    __setSchedulers(clock.setTimeout, clock.clearTimeout);

    pendingResponses = [
      createMockSseResponse(),
      createMockSseResponse(),
      createMockSseResponse(),
    ];
    const sub = subscribe("dispatch-events", () => {});
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
    const errorSpy = mock((..._args: unknown[]) => {});
    const origError = console.error;
    console.error = errorSpy as unknown as typeof console.error;

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

  test("auth header + URL: passes Bearer token from daemon-store", async () => {
    const sub = subscribe("dispatch-events", () => {});
    await flushMicrotasks();

    expect(sessions[0]!.url).toBe(
      "http://127.0.0.1:51257/dispatch-events/stream",
    );
    const headers = (sessions[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-test");
    sub.unsubscribe();
  });

  test("unknown topic throws (runtime guard against stringly-typed callers)", () => {
    expect(() =>
      subscribe("not-a-topic" as never, () => {}),
    ).toThrow(/unknown stream topic/);
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

describe("createStreamBroker", () => {
  test("two brokers with different baseUrl open SEPARATE fetches for the same topic", async () => {
    const fetchedUrls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      fetchedUrls.push(url);
      const { response } = createMockSseResponse();
      return Promise.resolve(response);
    }) as typeof fetch;

    const deps = (baseUrl: string): StreamBrokerDeps => ({
      getConfig: () => ({ baseUrl, token: "t" }),
    });
    const a = createStreamBroker(deps("http://a.local:1111"));
    const b = createStreamBroker(deps("http://b.local:2222"));

    const subA = a.subscribe("dispatch-events", () => {});
    const subB = b.subscribe("dispatch-events", () => {});
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
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      fetchedUrls.push(url);
      const { response } = createMockSseResponse();
      return Promise.resolve(response);
    }) as typeof fetch;

    let baseUrl = "http://first.local:1000";
    const broker = createStreamBroker({
      getConfig: () => ({ baseUrl, token: "t" }),
    });

    const sub1 = broker.subscribe("dispatch-events", () => {});
    await flushMicrotasks();
    baseUrl = "http://second.local:2000";
    const sub2 = broker.subscribe("dispatch-events", () => {});
    await flushMicrotasks();

    expect(fetchedUrls).toHaveLength(2);
    sub1.unsubscribe();
    sub2.unsubscribe();
    broker.reset();
    globalThis.fetch = origFetch;
  });
});

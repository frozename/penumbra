import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __resetBrokerForTests,
  __setSchedulers,
  subscribe,
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
    const sub1 = subscribe("dispatch-events-stream", () => {});
    const sub2 = subscribe("dispatch-events-stream", () => {});
    await flushMicrotasks();

    expect(sessions).toHaveLength(1);
    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("refcount linger: 30s closes; 29s does not", async () => {
    const clock = new FakeClock();
    __setSchedulers(clock.setTimeout, clock.clearTimeout);

    const sub1 = subscribe("dispatch-events-stream", () => {});
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

    const sub1 = subscribe("dispatch-events-stream", () => {});
    await flushMicrotasks();
    const initialSignal = sessions[0]!.init?.signal as AbortSignal;

    sub1.unsubscribe();
    clock.advance(20_000);
    const sub2 = subscribe("dispatch-events-stream", () => {});
    clock.advance(60_000);

    expect(initialSignal.aborted).toBe(false);
    expect(sessions).toHaveLength(1); // still one — refcount kept it alive
    sub2.unsubscribe();
  });

  test("different paramsKey isolates connections", async () => {
    const subA = subscribe("dispatch-events-stream", () => {}, {
      params: { kind: "a" },
    });
    const subB = subscribe("dispatch-events-stream", () => {}, {
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
    const sub1 = subscribe("dispatch-events-stream", () => {}, {
      params: { a: "1", b: "2" },
    });
    const sub2 = subscribe("dispatch-events-stream", () => {}, {
      params: { b: "2", a: "1" },
    });
    await flushMicrotasks();

    expect(sessions).toHaveLength(1);
    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("ring buffer caps at 200 and tail() returns last 200", async () => {
    const sub = subscribe("dispatch-events-stream", () => {});
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
    const sub1 = subscribe("dispatch-events-stream", () => {});
    await flushMicrotasks();
    const ctrl = sessions[0]!.controller;
    for (let i = 0; i < 5; i++) ctrl.send("message", JSON.stringify({ i }));
    await flushMicrotasks();

    const sub2 = subscribe("dispatch-events-stream", () => {});
    expect(sub2.tail()).toHaveLength(5);
    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("transport error → reconnect after 1s, ring reset, __reconnect__ fired", async () => {
    const clock = new FakeClock();
    __setSchedulers(clock.setTimeout, clock.clearTimeout);

    pendingResponses = [createMockSseResponse(), createMockSseResponse()];
    // first fetch will get pendingResponses[0], second will get pendingResponses[1]
    const got: StreamMessage<unknown>[] = [];
    const sub = subscribe<unknown>("dispatch-events-stream", (m) => got.push(m));
    await flushMicrotasks();
    expect(sessions).toHaveLength(1);

    sessions[0]!.controller.send("message", JSON.stringify({ k: 1 }));
    await flushMicrotasks();
    expect(sub.tail()).toHaveLength(1);

    sessions[0]!.controller.error(new Error("boom"));
    await flushMicrotasks();
    expect(sub.tail()).toHaveLength(0); // ring reset

    clock.advance(1_000);
    await flushMicrotasks();
    expect(sessions).toHaveLength(2);

    const reconnectMsgs = got.filter((m) => m.event === "__reconnect__");
    expect(reconnectMsgs).toHaveLength(1);
    expect(reconnectMsgs[0]!.data).toEqual({ reconnect: true });

    sub.unsubscribe();
  });

  test("subscriber error isolation — one throws, others still receive", async () => {
    const errorSpy = mock((..._args: unknown[]) => {});
    const origError = console.error;
    console.error = errorSpy as unknown as typeof console.error;

    const aReceived: StreamMessage<unknown>[] = [];
    const bReceived: StreamMessage<unknown>[] = [];
    const subA = subscribe("dispatch-events-stream", () => {
      aReceived.push({} as StreamMessage<unknown>);
      throw new Error("nope");
    });
    const subB = subscribe("dispatch-events-stream", (m) => {
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
    const sub = subscribe("dispatch-events-stream", () => {});
    await flushMicrotasks();

    expect(sessions[0]!.url).toBe(
      "http://127.0.0.1:51257/dispatch-events/stream",
    );
    const headers = (sessions[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-test");
    sub.unsubscribe();
  });

  test("topic path mapping: handoffs-events → /handoffs/events", async () => {
    const sub = subscribe("handoffs-events", () => {});
    await flushMicrotasks();
    expect(sessions[0]!.url).toBe("http://127.0.0.1:51257/handoffs/events");
    sub.unsubscribe();
  });

  test("topic path mapping: tasks-events → /tasks/events", async () => {
    const sub = subscribe("tasks-events", () => {});
    await flushMicrotasks();
    expect(sessions[0]!.url).toBe("http://127.0.0.1:51257/tasks/events");
    sub.unsubscribe();
  });
});

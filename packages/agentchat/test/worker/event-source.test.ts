import { expect, test, mock } from "bun:test";
import { startEventSource, type EventSourceClient } from "../../src/worker/event-source.js";

function makeClient(overrides: Partial<EventSourceClient> = {}): EventSourceClient {
  return {
    listHandoffs: mock().mockResolvedValue({ handoffs: [] }),
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      // never yields; pretend SSE is alive but quiet
      await new Promise<void>(() => {});
      // unreachable
    }),
    ...overrides,
  };
}

test("drains backlog from listHandoffs(status=approved,redirected) on startup", async () => {
  const handler = mock();
  const client = makeClient({
    listHandoffs: mock().mockResolvedValue({
      handoffs: [
        { handoff_id: "a", status: "approved" },
        { handoff_id: "b", status: "redirected" },
      ],
    }),
  });
  const { stop } = startEventSource({
    client,
    statuses: ["approved", "redirected"],
    onEvent: handler,
    pollIntervalMs: 50,
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(handler).toHaveBeenCalledTimes(2);
  expect(handler.mock.calls.map((c) => c[0].handoff_id).sort()).toEqual(["a", "b"]);
  await stop();
});

test("hard isolation polls only project-scoped queue", async () => {
  const handler = mock();
  const listHandoffs = mock().mockResolvedValue({
    handoffs: [{ handoff_id: "filtered", status: "approved" }],
  });
  const { stop } = startEventSource({
    client: {
      listHandoffs,
      subscribeHandoffEvents: mock().mockImplementation(async function* () {
        throw new Error("sse-down");
      }),
    },
    statuses: ["approved"],
    project_id: "alpha",
    isolation: "hard",
    pollIntervalMs: 1000,
    onEvent: handler,
  });
  await new Promise((r) => setTimeout(r, 25));
  expect(listHandoffs).toHaveBeenCalled();
  expect(handler).toHaveBeenCalledTimes(1);
  expect(listHandoffs).toHaveBeenCalledWith({ statuses: ["approved"], project_id: "alpha" });
  for (const [opts] of listHandoffs.mock.calls as any) {
    expect(opts.project_id).toBe("alpha");
  }
  await stop();
});

test("sticky isolation falls back to shared queue when project queue is empty", async () => {
  const handler = mock();
  const calls: Array<{ statuses: string[]; project_id?: string | null }> = [];
  const listHandoffs = mock().mockImplementation(
    async (opts: { statuses: string[]; project_id?: string | null }) => {
      calls.push(opts);
      if (opts.project_id) {
        return { handoffs: [] };
      }
      return { handoffs: [{ handoff_id: "shared", status: "approved" }] };
    },
  );

  const { stop } = startEventSource({
    client: {
      listHandoffs,
      subscribeHandoffEvents: mock().mockImplementation(async function* () {
        throw new Error("sse-down");
      }),
    },
    statuses: ["approved"],
    project_id: "alpha",
    isolation: "sticky",
    pollIntervalMs: 1000,
    onEvent: handler,
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(calls.some((call) => call.project_id === "alpha")).toBe(true);
  expect(calls.some((call) => call.project_id === undefined)).toBe(true);
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({ handoff_id: "shared" }));
  await stop();
});

test("shared isolation ignores project_id for listHandoffs polling", async () => {
  const handler = mock();
  const listHandoffs = mock().mockImplementation(async () => ({
    handoffs: [{ handoff_id: "shared-only", status: "approved" }],
  }));
  const { stop } = startEventSource({
    client: {
      listHandoffs,
      subscribeHandoffEvents: mock().mockImplementation(async function* () {
        throw new Error("sse-down");
      }),
    },
    statuses: ["approved"],
    project_id: "alpha",
    isolation: "shared",
    pollIntervalMs: 1000,
    onEvent: handler,
  });
  await new Promise((r) => setTimeout(r, 25));
  expect(listHandoffs).toHaveBeenCalled();
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({ handoff_id: "shared-only" }));
  for (const [opts] of listHandoffs.mock.calls as any) {
    expect((opts as any).project_id).toBeUndefined();
  }
  await stop();
});

test("SSE events are delivered to handler", async () => {
  const handler = mock();
  const client = makeClient({
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      yield { handoff_id: "sse-1", status: "approved" };
      yield { handoff_id: "sse-2", status: "approved" };
      // hold open
      await new Promise<void>(() => {});
    }),
  });
  const { stop } = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: handler,
    pollIntervalMs: 1000,
  });
  await new Promise((r) => setTimeout(r, 60));
  expect(handler).toHaveBeenCalledTimes(2);
  await stop();
});

test("hard isolation drops SSE handoff events from other projects", async () => {
  const handler = mock();
  const client = makeClient({
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      yield { handoff_id: "sse-matched", status: "approved", project_id: "proj-a" };
      yield { handoff_id: "sse-other", status: "approved", project_id: "proj-b" };
      await new Promise<void>(() => {});
    }),
  });
  const { stop } = startEventSource({
    client,
    statuses: ["approved"],
    project_id: "proj-a",
    isolation: "hard",
    onEvent: handler,
    pollIntervalMs: 1000,
  });

  await new Promise((r) => setTimeout(r, 60));
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({ handoff_id: "sse-matched" }));
  expect(handler.mock.calls.some((call) => call[0].handoff_id === "sse-other")).toBe(false);
  await stop();
});

test("dedupes by handoff_id across SSE + poll", async () => {
  const handler = mock();
  let pollCount = 0;
  const client = makeClient({
    listHandoffs: mock().mockImplementation(async () => {
      pollCount++;
      return { handoffs: [{ handoff_id: "x", status: "approved" }] };
    }),
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      yield { handoff_id: "x", status: "approved" };
      await new Promise<void>(() => {});
    }),
  });
  const { stop } = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: handler,
    pollIntervalMs: 30,
  });
  await new Promise((r) => setTimeout(r, 100));
  // Even though SSE emits 'x' AND polling sees 'x' multiple times, handler runs once.
  expect(handler).toHaveBeenCalledTimes(1);
  await stop();
});

test("SSE error switches to polling and resumes when SSE recovers", async () => {
  const handler = mock();
  let sseAttempt = 0;
  const client = makeClient({
    listHandoffs: mock().mockResolvedValue({ handoffs: [{ handoff_id: "p", status: "approved" }] }),
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      sseAttempt++;
      if (sseAttempt === 1) throw new Error("boom");
      yield { handoff_id: "sse-after-recover", status: "approved" };
      await new Promise<void>(() => {});
    }),
  });
  const { stop } = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: handler,
    pollIntervalMs: 30,
    sseBackoffStartMs: 5,
  });
  await new Promise((r) => setTimeout(r, 200));
  expect(sseAttempt).toBeGreaterThanOrEqual(2);
  const ids = handler.mock.calls.map((c) => c[0].handoff_id);
  expect(ids).toContain("p");
  expect(ids).toContain("sse-after-recover");
  await stop();
});

test("stop() cancels SSE iterator and stops polling", async () => {
  const handler = mock();
  const client = makeClient();
  const { stop } = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: handler,
    pollIntervalMs: 10,
  });
  await new Promise((r) => setTimeout(r, 25));
  await stop();
  const callsBefore = handler.mock.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  expect(handler.mock.calls.length).toBe(callsBefore);
});

test("forget(id) drops the dedup entry so a future event for that id re-fires the handler", async () => {
  const handler = mock();
  const pollResults: any[] = [{ handoff_id: "h1", status: "approved" }];
  const client = makeClient({
    listHandoffs: mock().mockImplementation(async () => ({ handoffs: pollResults })),
    // Make SSE error immediately so polling is the active path (sseAlive stays false).
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      throw new Error("sse-down");
    }),
  });
  const { stop, forget } = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: handler,
    pollIntervalMs: 20,
    sseBackoffStartMs: 1000,
    sseBackoffCapMs: 1000, // SSE retry window beyond the test
  });
  // First poll fires handler once
  await new Promise((r) => setTimeout(r, 50));
  expect(handler).toHaveBeenCalledTimes(1);
  // Subsequent polls dedup → still 1
  await new Promise((r) => setTimeout(r, 80));
  expect(handler).toHaveBeenCalledTimes(1);
  // After forget, the next poll re-fires the handler
  forget("h1");
  await new Promise((r) => setTimeout(r, 80));
  expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
  await stop();
});

test("dedup set stays bounded by dedupCapacity under a flood of distinct ids", async () => {
  const handler = mock();
  const capacity = 5;
  const flood = 200;
  let pollCount = 0;
  const client = makeClient({
    listHandoffs: mock().mockImplementation(async () => {
      // Emit a fresh batch of distinct ids on each poll so the dedup set
      // would grow unbounded without an LRU cap.
      const start = pollCount * 50;
      pollCount++;
      if (pollCount > 4) return { handoffs: [] };
      return {
        handoffs: Array.from({ length: 50 }, (_, i) => ({
          handoff_id: `flood-${start + i}`,
          status: "approved",
        })),
      };
    }),
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      throw new Error("sse-down");
    }),
  });
  const handle = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: handler,
    pollIntervalMs: 5,
    sseBackoffStartMs: 1000,
    sseBackoffCapMs: 1000,
    dedupCapacity: capacity,
  });
  await new Promise((r) => setTimeout(r, 120));
  // Handler fired for every distinct id seen
  expect(handler.mock.calls.length).toBeGreaterThanOrEqual(flood);
  // But the dedup set never exceeded its capacity
  expect(handle._dedupSize()).toBeLessThanOrEqual(capacity);
  await handle.stop();
});

test("evicted ids re-fire the handler; recently-seen ids stay hot", async () => {
  const handler = mock();
  const capacity = 3;
  let batch: any[] = [];
  const client = makeClient({
    listHandoffs: mock().mockImplementation(async () => ({ handoffs: batch })),
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      throw new Error("sse-down");
    }),
  });
  const handle = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: handler,
    pollIntervalMs: 10,
    sseBackoffStartMs: 1000,
    sseBackoffCapMs: 1000,
    dedupCapacity: capacity,
  });

  // Fill the dedup set with ids a,b,c
  batch = [
    { handoff_id: "a", status: "approved" },
    { handoff_id: "b", status: "approved" },
    { handoff_id: "c", status: "approved" },
  ];
  await new Promise((r) => setTimeout(r, 40));
  expect(handler.mock.calls.length).toBe(3);

  // Touch 'c' to refresh its recency (it is currently the newest already),
  // then push 'd' and 'e' which evicts 'a' and 'b'.
  batch = [
    { handoff_id: "c", status: "approved" },
    { handoff_id: "d", status: "approved" },
    { handoff_id: "e", status: "approved" },
  ];
  await new Promise((r) => setTimeout(r, 40));
  // 'd' and 'e' are new → 2 more handler calls; 'c' was hot → no re-fire
  expect(handler.mock.calls.length).toBe(5);

  // 'a' was evicted → re-emitting it should re-fire the handler
  batch = [{ handoff_id: "a", status: "approved" }];
  await new Promise((r) => setTimeout(r, 40));
  expect(handler.mock.calls.length).toBe(6);
  expect(handler.mock.calls.at(-1)?.[0].handoff_id).toBe("a");

  expect(handle._dedupSize()).toBeLessThanOrEqual(capacity);
  await handle.stop();
});

test("logs daemon unreachable on poll failure when log is provided, throttled to once per window", async () => {
  const warns: any[] = [];
  const log = { warn: (obj: any, msg: string) => warns.push({ obj, msg }) };
  const client = makeClient({
    listHandoffs: mock().mockRejectedValue(new Error("connect ECONNREFUSED")),
    // SSE errors immediately so sseAlive stays false and polls keep ticking.
    subscribeHandoffEvents: mock().mockImplementation(async function* () {
      throw new Error("sse-down");
    }),
  });
  const { stop } = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: () => {},
    pollIntervalMs: 20,
    sseBackoffStartMs: 1000,
    sseBackoffCapMs: 1000,
    log,
    unreachableLogThrottleMs: 100,
  });
  // Multiple poll ticks within the throttle window → exactly one log
  await new Promise((r) => setTimeout(r, 60));
  expect(warns.length).toBe(1);
  expect(warns[0].msg).toBe("daemon unreachable, retrying");
  // After the throttle window expires, the next poll error logs again
  await new Promise((r) => setTimeout(r, 130));
  expect(warns.length).toBeGreaterThanOrEqual(2);
  await stop();
});

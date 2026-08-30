import {
  type EventSourceClient,
  type EventSourceOpts,
  type EventSourceRow,
  startEventSource,
} from "@src/worker/event-source.js";
import { expect, mock, test } from "bun:test";

// Test-local row: extends the wider production `EventSourceRow` contract with
// a status field used by the synthetic mock data. Keeping it as an extension
// keeps `(row: HandoffRow) => void` assignable to the onEvent contract.
interface HandoffRow extends EventSourceRow {
  status: string;
}

interface ListHandoffsOpts {
  statuses: string[];
  conversation_id?: string;
  project_id?: string | null;
}

// Async generator factory: when invoked with an empty events array it yields
// nothing but still references `yield`/`await` syntactically so eslint's
// require-yield / require-await pass without a disable comment.
async function* yieldHandoffs(events: HandoffRow[]): AsyncGenerator<HandoffRow, void, undefined> {
  for (const ev of events) {
    await Promise.resolve();
    yield ev;
  }
}

// Async generator that throws on entry. The `yield`/`await` after the throw
// are unreachable but satisfy require-yield / require-await syntactically.
async function* throwHandoffs(message: string): AsyncGenerator<HandoffRow, void, undefined> {
  if (message.length > 0) {
    throw new Error(message);
  }
  await Promise.resolve();
  yield { handoff_id: "", status: "" };
}

// SSE "alive but quiet" generator: sleeps until the abort signal fires so
// stop() can unblock the sseLoop's `for await` on it. The yield+await after
// the sleep are unreachable; they satisfy eslint's require-yield /
// require-await without a disable comment.
async function* hangHandoffs(opts?: {
  signal?: AbortSignal;
}): AsyncGenerator<HandoffRow, void, undefined> {
  await new Promise<void>((resolve) => {
    const signal = opts?.signal;
    if (!signal) return; // truly never resolves — legacy behavior for callers not passing a signal
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
  yield { handoff_id: "", status: "" };
}

test("drains backlog from listHandoffs(status=approved,redirected) on startup", async () => {
  const handler = mock((_row: EventSourceRow) => undefined);
  const client: EventSourceClient = {
    listHandoffs: mock(() =>
      Promise.resolve({
        handoffs: [
          { handoff_id: "a", status: "approved" },
          { handoff_id: "b", status: "redirected" },
        ],
      }),
    ),
    subscribeHandoffEvents: hangHandoffs,
  };
  const handle = startEventSource({
    client,
    statuses: ["approved", "redirected"],
    onEvent: handler,
    pollIntervalMs: 50,
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(handler).toHaveBeenCalledTimes(2);
  const ids = handler.mock.calls.map((c) => c[0].handoff_id).sort();
  expect(ids).toEqual(["a", "b"]);
  await handle.stop();
});

test("hard isolation polls only project-scoped queue", async () => {
  const handler = mock((_row: EventSourceRow) => undefined);
  const listHandoffs = mock((_opts: ListHandoffsOpts) =>
    Promise.resolve({
      handoffs: [{ handoff_id: "filtered", status: "approved" }],
    }),
  );
  const handle = startEventSource({
    client: {
      listHandoffs,
      subscribeHandoffEvents: () => throwHandoffs("sse-down"),
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
  for (const [opts] of listHandoffs.mock.calls) {
    expect(opts.project_id).toBe("alpha");
  }
  await handle.stop();
});

test("sticky isolation falls back to shared queue when project queue is empty", async () => {
  const handler = mock((_row: EventSourceRow) => undefined);
  const calls: ListHandoffsOpts[] = [];
  const listHandoffs = mock((opts: ListHandoffsOpts) => {
    calls.push(opts);
    if (opts.project_id !== undefined && opts.project_id !== null) {
      return Promise.resolve({ handoffs: [] as HandoffRow[] });
    }
    return Promise.resolve({
      handoffs: [{ handoff_id: "shared", status: "approved" }],
    });
  });

  const handle = startEventSource({
    client: {
      listHandoffs,
      subscribeHandoffEvents: () => throwHandoffs("sse-down"),
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
  await handle.stop();
});

test("shared isolation ignores project_id for listHandoffs polling", async () => {
  const handler = mock((_row: EventSourceRow) => undefined);
  const listHandoffs = mock((_opts: ListHandoffsOpts) =>
    Promise.resolve({
      handoffs: [{ handoff_id: "shared-only", status: "approved" }],
    }),
  );
  const handle = startEventSource({
    client: {
      listHandoffs,
      subscribeHandoffEvents: () => throwHandoffs("sse-down"),
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
  for (const [opts] of listHandoffs.mock.calls) {
    expect(opts.project_id).toBeUndefined();
  }
  await handle.stop();
});

test("SSE events are delivered to handler", async () => {
  const handler = mock((_row: EventSourceRow) => undefined);
  const client: EventSourceClient = {
    listHandoffs: mock(() => Promise.resolve({ handoffs: [] as HandoffRow[] })),
    subscribeHandoffEvents: (opts) =>
      yieldHandoffsThenHang(
        [
          { handoff_id: "sse-1", status: "approved" },
          { handoff_id: "sse-2", status: "approved" },
        ],
        opts,
      ),
  };
  const handle = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: handler,
    pollIntervalMs: 1000,
  });
  await new Promise((r) => setTimeout(r, 60));
  expect(handler).toHaveBeenCalledTimes(2);
  await handle.stop();
});

// Helper for SSE-style streams that yield a fixed batch then hold open
// (the production SSE channel is long-lived, so the production code path
// reading the iterator must not see done=true after the test's yields).
// Honors the abort signal so stop() can unblock the sseLoop.
async function* yieldHandoffsThenHang(
  events: HandoffRow[],
  opts?: { signal?: AbortSignal },
): AsyncGenerator<HandoffRow, void, undefined> {
  for (const ev of events) {
    await Promise.resolve();
    yield ev;
  }
  await new Promise<void>((resolve) => {
    const signal = opts?.signal;
    if (!signal) return; // hold open forever if no signal was provided
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

test("hard isolation drops SSE handoff events from other projects", async () => {
  const handler = mock((_row: EventSourceRow) => undefined);
  const client: EventSourceClient = {
    listHandoffs: mock(() => Promise.resolve({ handoffs: [] as HandoffRow[] })),
    subscribeHandoffEvents: (opts) =>
      yieldHandoffsThenHang(
        [
          { handoff_id: "sse-matched", status: "approved", project_id: "proj-a" },
          { handoff_id: "sse-other", status: "approved", project_id: "proj-b" },
        ],
        opts,
      ),
  };
  const handle = startEventSource({
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
  await handle.stop();
});

test("dedupes by handoff_id across SSE + poll", async () => {
  const handler = mock((_row: EventSourceRow) => undefined);
  let pollCount = 0;
  const client: EventSourceClient = {
    listHandoffs: mock(() => {
      pollCount++;
      return Promise.resolve({ handoffs: [{ handoff_id: "x", status: "approved" }] });
    }),
    subscribeHandoffEvents: (opts) =>
      yieldHandoffsThenHang([{ handoff_id: "x", status: "approved" }], opts),
  };
  const handle = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: handler,
    pollIntervalMs: 30,
  });
  await new Promise((r) => setTimeout(r, 100));
  // Even though SSE emits 'x' AND polling sees 'x' multiple times, handler runs once.
  expect(handler).toHaveBeenCalledTimes(1);
  expect(pollCount).toBeGreaterThan(0);
  await handle.stop();
});

test("SSE error switches to polling and resumes when SSE recovers", async () => {
  const handler = mock((_row: EventSourceRow) => undefined);
  let sseAttempt = 0;
  const client: EventSourceClient = {
    listHandoffs: mock(() =>
      Promise.resolve({ handoffs: [{ handoff_id: "p", status: "approved" }] }),
    ),
    subscribeHandoffEvents: (opts) => {
      sseAttempt++;
      if (sseAttempt === 1) return throwHandoffs("boom");
      return yieldHandoffsThenHang([{ handoff_id: "sse-after-recover", status: "approved" }], opts);
    },
  };
  const handle = startEventSource({
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
  await handle.stop();
});

test("stop() cancels SSE iterator and stops polling", async () => {
  const handler = mock((_row: EventSourceRow) => undefined);
  const client: EventSourceClient = {
    listHandoffs: mock(() => Promise.resolve({ handoffs: [] as HandoffRow[] })),
    subscribeHandoffEvents: hangHandoffs,
  };
  const handle = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: handler,
    pollIntervalMs: 10,
  });
  await new Promise((r) => setTimeout(r, 25));
  await handle.stop();
  const callsBefore = handler.mock.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  expect(handler.mock.calls.length).toBe(callsBefore);
});

test("forget(id) drops the dedup entry so a future event for that id re-fires the handler", async () => {
  const handler = mock((_row: EventSourceRow) => undefined);
  const pollResults: HandoffRow[] = [{ handoff_id: "h1", status: "approved" }];
  const client: EventSourceClient = {
    listHandoffs: mock(() => Promise.resolve({ handoffs: pollResults })),
    // Make SSE error immediately so polling is the active path (sseAlive stays false).
    subscribeHandoffEvents: () => throwHandoffs("sse-down"),
  };
  const handle = startEventSource({
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
  handle.forget("h1");
  await new Promise((r) => setTimeout(r, 80));
  expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
  await handle.stop();
});

test("dedup set stays bounded by dedupCapacity under a flood of distinct ids", async () => {
  const handler = mock((_row: EventSourceRow) => undefined);
  const capacity = 5;
  const flood = 200;
  let pollCount = 0;
  const client: EventSourceClient = {
    listHandoffs: mock(() => {
      // Emit a fresh batch of distinct ids on each poll so the dedup set
      // would grow unbounded without an LRU cap.
      const start = pollCount * 50;
      pollCount++;
      if (pollCount > 4) return Promise.resolve({ handoffs: [] as HandoffRow[] });
      return Promise.resolve({
        handoffs: Array.from({ length: 50 }, (_, i) => ({
          handoff_id: `flood-${String(start + i)}`,
          status: "approved",
        })),
      });
    }),
    subscribeHandoffEvents: () => throwHandoffs("sse-down"),
  };
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
  const handler = mock((_row: EventSourceRow) => undefined);
  const capacity = 3;
  let batch: HandoffRow[] = [];
  const client: EventSourceClient = {
    listHandoffs: mock(() => Promise.resolve({ handoffs: batch })),
    subscribeHandoffEvents: () => throwHandoffs("sse-down"),
  };
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

interface PollLogEntry {
  obj: Record<string, unknown>;
  msg: string;
}

test("stop() during the SSE backoff sleep interrupts it promptly", async () => {
  // Uncancellable-sleep regression: previously the sseLoop slept up to
  // sseBackoffCapMs before noticing stop(); now stop() must interrupt the
  // sleep so the coroutine exits and releases its closures (BoundedSeen,
  // callbacks, abort listener) quickly.
  const handler = mock((_row: EventSourceRow) => undefined);
  const client: EventSourceClient = {
    listHandoffs: mock(() => Promise.resolve({ handoffs: [] as HandoffRow[] })),
    // SSE errors immediately so the loop enters the backoff sleep.
    subscribeHandoffEvents: () => throwHandoffs("sse-down"),
  };
  const backoffMs = 3000;
  const handle = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: handler,
    // Long enough that a poll tick won't intervene during the measured close.
    pollIntervalMs: 60_000,
    sseBackoffStartMs: backoffMs,
    sseBackoffCapMs: backoffMs,
  });
  // Wait long enough to be inside the backoff sleep.
  await new Promise((r) => setTimeout(r, 30));
  const t0 = Date.now();
  await handle.stop();
  const dt = Date.now() - t0;
  expect(dt).toBeLessThan(backoffMs / 2);
});

test("logs daemon unreachable on poll failure when log is provided, throttled to once per window", async () => {
  const warns: PollLogEntry[] = [];
  const log: NonNullable<EventSourceOpts["log"]> = {
    warn: (obj: Record<string, unknown>, msg: string): void => {
      warns.push({ obj, msg });
    },
  };
  const client: EventSourceClient = {
    listHandoffs: mock(() => Promise.reject(new Error("connect ECONNREFUSED"))),
    // SSE errors immediately so sseAlive stays false and polls keep ticking.
    subscribeHandoffEvents: () => throwHandoffs("sse-down"),
  };
  const handle = startEventSource({
    client,
    statuses: ["approved"],
    onEvent: () => undefined,
    pollIntervalMs: 20,
    sseBackoffStartMs: 1000,
    sseBackoffCapMs: 1000,
    log,
    unreachableLogThrottleMs: 100,
  });
  // Multiple poll ticks within the throttle window → exactly one log
  await new Promise((r) => setTimeout(r, 60));
  expect(warns.length).toBe(1);
  expect(warns[0]?.msg).toBe("daemon unreachable, retrying");
  // After the throttle window expires, the next poll error logs again
  await new Promise((r) => setTimeout(r, 130));
  expect(warns.length).toBeGreaterThanOrEqual(2);
  await handle.stop();
});

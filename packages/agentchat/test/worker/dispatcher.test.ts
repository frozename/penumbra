import {
  ConversationChainEndEventSchema,
  ConversationHopEndEventSchema,
  type DispatchEventInput,
  type Logger,
} from "@penumbra/core";
import { expect, mock, test, vi } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnCliAdapter, spawnCliAdapterStream } from "@src/adapters/cli-spawn.js";
import { dispatchHandoff } from "@src/cli/dispatch-handoff.js";
import type { ChatTurnInput, ChatTurnResult } from "@src/cli/loop.js";
import { PenumbraClient, PenumbraHttpError } from "@src/penumbra-client.js";
import type { DispatchEvent } from "@src/sdk/adapter.js";
import type { DiscordNotificationEvent } from "@src/worker/discord-events.js";
import { createWorkerDispatcher, type WorkerDispatcherDeps } from "@src/worker/dispatcher.js";
import type { TerminalReport } from "@src/worker/terminal-outbox.js";

// Bun's mock() returns Mock<(...args: unknown[]) => unknown>; the .mock.calls
// array is therefore unknown[][] and TypeScript loses the concrete arg tuple
// across the cast. Single helper laundering through `as unknown as` lets each
// caller declare the tuple it expects without re-asserting at every read site.
function mockCalls<T extends readonly unknown[] = unknown[]>(fn: unknown): T[] {
  return (fn as { mock: { calls: T[] } }).mock.calls;
}

// pino's Logger has heavily-overloaded info/warn/debug signatures the bun mock
// can't structurally satisfy. Single laundering helper produces a Logger-typed
// stub from a plain {info,warn,debug} shape.
function asLogger(stub: { info: unknown; warn: unknown; debug: unknown }): Logger {
  return stub as unknown as Logger;
}

// Bun's mock() returns Mock<unknown> that does not structurally satisfy the
// full DOM fetch type (all overloads + AbortSignal nuances). Single helper
// laundering keeps fetch test seams in one cast site.
function asFetch(fn: unknown): typeof fetch {
  return fn as typeof fetch;
}

// jest/bun's `expect.objectContaining` returns `any`, so passing it to typed
// matchers like `toContainEqual(expected: T)` trips no-unsafe-argument at the
// call site. Single helper narrows the matcher into the discriminated-union
// element type so callers don't repeat the cast inline.
function eventMatcher<T>(shape: Partial<T>): T {
  return expect.objectContaining(shape) as T;
}

function makeMockClient(fetchImpl: typeof fetch): { client: PenumbraClient; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pen-dispatch-test-"));
  writeFileSync(join(root, "port"), "1\n");
  writeFileSync(join(root, "token"), "shared-tok\n");
  const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });
  return {
    client,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface TestHandoff {
  handoff_id: string;
  ts: string;
  project_id: string | null;
  conversation_id: string;
  from_agent: string;
  to_agent: string;
  to_role: string | null;
  message: string;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  redirected_to: string | null;
  triggered_by_event_id: string | null;
  chain_max_hops: number | null;
  chain_trust_mode: string | null;
  use_worktree?: boolean;
  isolated_install?: boolean;
}

const baseHandoff = (id: string, conv = "c1"): TestHandoff => ({
  handoff_id: id,
  ts: "t",
  project_id: null,
  conversation_id: conv,
  from_agent: "planner",
  to_agent: "executor",
  to_role: null,
  message: "m",
  status: "approved",
  resolved_by: null,
  resolved_at: null,
  redirected_to: null,
  triggered_by_event_id: null,
  chain_max_hops: null,
  chain_trust_mode: null,
});

function deps(over: Partial<WorkerDispatcherDeps> = {}): WorkerDispatcherDeps {
  return {
    claim: mock().mockResolvedValue({ status: "dispatched" }),
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "no_mention",
      text: "result",
      agent: "executor",
    }),
    postProgress: mock().mockResolvedValue(undefined),
    complete: mock().mockResolvedValue(undefined),
    markFailed: mock().mockResolvedValue(undefined),
    log: asLogger({ info: mock(), warn: mock(), debug: mock() }),
    concurrency: 4,
    ...over,
  };
}

test("claim called once per event; dispatch called once on success", async () => {
  const d = deps();
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();
  expect(d.claim).toHaveBeenCalledTimes(1);
  expect(d.dispatch).toHaveBeenCalledTimes(1);
  expect(d.postProgress).toHaveBeenCalled();
});

interface ProgressPayload {
  type: string;
}

test("progress events are emitted in order", async () => {
  const d = deps({
    dispatch: mock().mockImplementation((_h: unknown, onChunk: (delta: string) => void) => {
      onChunk("hi");
      onChunk(" there");
      return Promise.resolve({
        next: null,
        terminatedReason: "no_mention" as const,
        text: "hi there",
        agent: "executor",
      });
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();

  // hop-start, tokens, hop-end
  const calls = mockCalls<[string, ProgressPayload]>(d.postProgress).map((c) => c[1].type);
  expect(calls[0]).toBe("hop-start");
  expect(calls).toContain("token");
  expect(calls[calls.length - 1]).toBe("chain-end");
});

test("failed dispatch clears pending progress batch timer", async () => {
  const d = deps({
    dispatch: mock().mockImplementation((_h: unknown, onChunk: (delta: string) => void) => {
      onChunk("orphaned progress");
      throw new Error("adapter exploded");
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-progress-fail"));
  await dispatcher.idle();
  await Bun.sleep(150);

  const calls = mockCalls<[string, ProgressPayload]>(d.postProgress);
  const tokenCalls = calls.filter(([, payload]) => payload.type === "token");
  expect(tokenCalls).toHaveLength(0);
});

test("emits dispatch_start after claim and before hop-start progress", async () => {
  const order: string[] = [];
  const events: DiscordNotificationEvent[] = [];
  const d = deps({
    claim: mock().mockImplementation(() => {
      order.push("claim");
      return Promise.resolve({ status: "dispatched" });
    }),
    onDispatchEvent: (event) => {
      order.push(event.kind);
      events.push(event);
    },
    postProgress: mock().mockImplementation((_handoffId: string, payload: ProgressPayload) => {
      if (payload.type === "hop-start") order.push("hop-start");
      return Promise.resolve();
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-1", "c-1"));
  await dispatcher.idle();

  expect(events).toContainEqual(
    eventMatcher<DiscordNotificationEvent>({
      kind: "dispatch_start",
      handoff_id: "h-1",
      conversation_id: "c-1",
      agent: "executor",
    }),
  );
  expect(order.slice(0, 3)).toEqual(["claim", "dispatch_start", "hop-start"]);
});

test("dispatch.start meta does not include predicted worktree_mode", async () => {
  const events: DispatchEventInput[] = [];
  const d = deps({
    onEvent: (event) => events.push(event),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle({ ...baseHandoff("h-wt"), use_worktree: true, isolated_install: true });
  await dispatcher.idle();

  const startEvent = events.find((e) => e.kind === "dispatch.start");
  expect(startEvent).toBeDefined();
  expect(startEvent?.meta).not.toHaveProperty("worktree_mode");
});

test("dispatch.end meta tags classifier declines from adapter errors", async () => {
  const events: DispatchEventInput[] = [];
  const d = deps({
    dispatch: mock().mockRejectedValue(
      new Error("I'm sorry, but I can't assist with that request."),
    ),
    onEvent: (event) => events.push(event),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-classifier-error"));
  await dispatcher.idle();

  const endEvent = events.find((e) => e.kind === "dispatch.end");
  expect(endEvent?.meta).toEqual(
    expect.objectContaining({
      status: "error",
      classifier_declined: true,
      decline_reason: "provider_safety_refusal",
    }) as Record<string, unknown>,
  );
});

test("waits for durable dispatch.start delivery before calling dispatch", async () => {
  const order: string[] = [];
  const startPosted = Promise.withResolvers<undefined>();
  const releaseStart = Promise.withResolvers<undefined>();
  const d = deps({
    dispatchStartBarrier: async (event) => {
      order.push(event.kind);
      startPosted.resolve(undefined);
      await releaseStart.promise;
    },
    dispatch: mock().mockImplementation(() => {
      order.push("dispatch");
      return Promise.resolve({
        next: null,
        terminatedReason: "no_mention" as const,
        text: "result",
        agent: "executor",
      });
    }),
    postProgress: mock().mockImplementation((_handoffId: string, payload: ProgressPayload) => {
      if (payload.type === "hop-start") order.push("hop-start");
      return Promise.resolve();
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  const handlePromise = dispatcher.handle(baseHandoff("h-durable"));
  await startPosted.promise;
  expect(d.dispatch).not.toHaveBeenCalled();
  releaseStart.resolve(undefined);
  await handlePromise;
  await dispatcher.idle();

  expect(order[0]).toBe("dispatch.start");
  expect(order.indexOf("dispatch")).toBeGreaterThan(order.indexOf("dispatch.start"));
  expect(d.dispatch).toHaveBeenCalledTimes(1);
});

test("aborts dispatch when durable dispatch.start delivery fails (HTTP 500)", async () => {
  const fetchImpl = mock().mockResolvedValue({
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
    json: () => Promise.resolve({ error: "daemon down" }),
    text: () => Promise.resolve("daemon down"),
  });
  const { client, cleanup } = makeMockClient(asFetch(fetchImpl));

  const d = deps({
    dispatchStartBarrier: (event) => client.postDispatchEventsStrict([event]),
  });
  const dispatcher = createWorkerDispatcher(d);

  try {
    await dispatcher.handle(baseHandoff("h-durable-fail-500"));
    await dispatcher.idle();

    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.postProgress).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: "hop-start" }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally {
    cleanup();
  }
});

test("dispatch.start barrier failure terminates the lifecycle (emits dispatch.end + markFailed)", async () => {
  const events: DispatchEventInput[] = [];
  const onClaimRetryable = mock();
  const d = deps({
    dispatchStartBarrier: () => Promise.reject(new Error("simulated barrier failure")),
    onEvent: (event) => events.push(event),
    onClaimRetryable,
    workerId: "w-barrier",
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-barrier-terminal"));
  await dispatcher.idle();

  // Dispatch must not run.
  expect(d.dispatch).not.toHaveBeenCalled();
  // The lifecycle must not be silently truncated: dispatch.end with
  // status=error is emitted so the handoff is observable as failed.
  const endEvent = events.find(
    (event) => event.kind === "dispatch.end" && event.handoff_id === "h-barrier-terminal",
  );
  expect(endEvent).toBeDefined();
  expect(endEvent?.meta?.status).toBe("error");
  expect(endEvent?.meta?.error_summary).toContain("dispatch_start_barrier_failed");
  // markFailed() — not complete() — is called so the row is durably failed,
  // not silently masked as a successful completion.
  expect(d.complete).not.toHaveBeenCalled();
  expect(d.markFailed).toHaveBeenCalledTimes(1);
  expect(d.markFailed).toHaveBeenCalledWith(
    "h-barrier-terminal",
    expect.stringContaining("dispatch_start_barrier_failed"),
  );
  // markFailed() succeeded, so the retryable fallback is not used.
  expect(onClaimRetryable).not.toHaveBeenCalled();
});

test("dispatch.start barrier failure + markFailed failure falls back to onClaimRetryable", async () => {
  const events: DispatchEventInput[] = [];
  const onClaimRetryable = mock();
  const d = deps({
    dispatchStartBarrier: () => Promise.reject(new Error("daemon unreachable")),
    markFailed: mock().mockRejectedValue(new Error("markFailed also fails")),
    onEvent: (event) => events.push(event),
    onClaimRetryable,
    workerId: "w-barrier-fallback",
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-barrier-fallback"));
  await dispatcher.idle();

  expect(d.dispatch).not.toHaveBeenCalled();
  const endEvent = events.find(
    (event) => event.kind === "dispatch.end" && event.handoff_id === "h-barrier-fallback",
  );
  expect(endEvent?.meta?.status).toBe("error");
  expect(d.complete).not.toHaveBeenCalled();
  expect(d.markFailed).toHaveBeenCalledTimes(1);
  // Worker forgets dedup state so SSE/poll can re-surface the row.
  expect(onClaimRetryable).toHaveBeenCalledTimes(1);
  expect(onClaimRetryable).toHaveBeenCalledWith("h-barrier-fallback");
});

test("aborts dispatch when durable dispatch.start delivery fails (connection refused)", async () => {
  const fetchImpl = mock().mockRejectedValue(new TypeError("fetch failed"));
  const { client, cleanup } = makeMockClient(asFetch(fetchImpl));

  const d = deps({
    dispatchStartBarrier: (event) => client.postDispatchEventsStrict([event]),
  });
  const dispatcher = createWorkerDispatcher(d);

  try {
    await dispatcher.handle(baseHandoff("h-durable-fail-conn"));
    await dispatcher.idle();

    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.postProgress).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: "hop-start" }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally {
    cleanup();
  }
});

test("onChainEnd receives the full handoff row and mapped terminal reason", async () => {
  const onChainEnd = mock();
  const d = deps({ onChainEnd });
  const dispatcher = createWorkerDispatcher(d);
  const handoff = baseHandoff("h-chain-end", "conv-chain-end");

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  expect(onChainEnd).toHaveBeenCalledTimes(1);
  expect(onChainEnd).toHaveBeenCalledWith(
    handoff,
    "completed",
    null,
    null,
    null,
    expect.any(Number),
    null,
    "result",
  );
});

test("onChainEnd receives final response text from dispatch result", async () => {
  const onChainEnd = mock();
  const d = deps({
    onChainEnd,
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "no_mention",
      text: "This is the final response text returned by the worker dispatcher.",
      agent: "executor",
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  const handoff = baseHandoff("h-chain-final-text", "conv-chain-final-text");

  await dispatcher.handle(handoff);
  await dispatcher.idle();

  expect(onChainEnd).toHaveBeenCalledTimes(1);
  expect(onChainEnd).toHaveBeenCalledWith(
    handoff,
    "completed",
    null,
    null,
    null,
    expect.any(Number),
    null,
    "This is the final response text returned by the worker dispatcher.",
  );
  const wallMs =
    mockCalls<[unknown, string, null, null, null, number, null, string]>(onChainEnd)[0]?.[5];
  expect(wallMs).toBeGreaterThanOrEqual(0);
});

test("emits dispatch.start and dispatch.end events on successful dispatch", async () => {
  const events: DispatchEventInput[] = [];
  const d = deps({ onEvent: (event) => events.push(event), workerId: "w-dispatch" });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-events"));
  await dispatcher.idle();

  expect(
    events.some((event) => event.kind === "dispatch.start" && event.handoff_id === "h-events"),
  ).toBe(true);
  expect(events.some((event) => event.kind === "dispatch.end" && event.meta?.status === "ok")).toBe(
    true,
  );
});

test("threads adapter framework_overhead_ms into dispatch.end meta", async () => {
  const events: DispatchEventInput[] = [];
  const d = deps({
    onEvent: (event) => events.push(event),
    workerId: "w-dispatch",
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "no_mention",
      text: "result",
      agent: "executor",
      meta: { framework_overhead_ms: 321 },
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-overhead"));
  await dispatcher.idle();

  const end = events.find((event) => event.kind === "dispatch.end");
  expect(end?.meta?.framework_overhead_ms).toBe(321);
});

test("emits cancel.dispatched when cancellation matches an active dispatch", async () => {
  const events: DispatchEventInput[] = [];
  const started = Promise.withResolvers<undefined>();
  const d = deps({
    onEvent: (event) => events.push(event),
    workerId: "w-dispatch",
    dispatch: mock().mockImplementation(
      async (_h: unknown, _onChunk: unknown, signal: AbortSignal) => {
        started.resolve(undefined);
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
        return { next: null, terminatedReason: "untrusted" as const, text: "", agent: "executor" };
      },
    ),
  });
  const dispatcher = createWorkerDispatcher(d);
  const handoff = baseHandoff("h-cancel", "c-cancel");

  await dispatcher.handle(handoff);
  await started.promise;
  dispatcher.cancel("c-cancel", "h-cancel");
  await dispatcher.idle();

  expect(
    events.some((event) => event.kind === "cancel.dispatched" && event.meta?.matched === true),
  ).toBe(true);
  expect(
    events.some((event) => event.kind === "dispatch.end" && event.meta?.status === "aborted"),
  ).toBe(true);
});

test("unmatched cancels do not grow pendingCancel state without bound", () => {
  const d = deps();
  const dispatcher = createWorkerDispatcher(d);

  // Each cancel targets a distinct handoff/conversation with no active
  // dispatch, so every one lands in the pending-cancel state. In a long-lived
  // worker these are never consumed and (before the fix) grow unbounded.
  for (let i = 0; i < 1_500; i += 1) {
    dispatcher.cancel(`c-unmatched-${String(i)}`, `h-unmatched-${String(i)}`);
  }

  expect(dispatcher.__internals().pendingCancelSize).toBeLessThanOrEqual(1_000);

  // Conv-scoped cancels (legacy callers, no handoff_id) share the same cap.
  for (let i = 0; i < 1_500; i += 1) {
    dispatcher.cancel(`c-conv-only-${String(i)}`);
  }

  expect(dispatcher.__internals().pendingCancelSize).toBeLessThanOrEqual(1_000);
});

test("stale unmatched cancels are evicted before the size cap is reached", () => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  try {
    const d = deps();
    const dispatcher = createWorkerDispatcher(d);

    dispatcher.cancel("c-stale", "h-stale");
    expect(dispatcher.__internals().pendingCancelsByHandoffKeys).toContain("h-stale");

    nowMs += 300_001;
    dispatcher.cancel("c-fresh", "h-fresh");

    const internals = dispatcher.__internals();
    expect(internals.pendingCancelsByHandoffKeys).toEqual(["h-fresh"]);
    expect(internals.pendingCancelsByHandoffKeys).not.toContain("h-stale");
    expect(internals.pendingCancelSize).toBe(1);
  } finally {
    nowSpy.mockRestore();
  }
});

test("emits dispatch.end status=error when dispatch reports terminal error", async () => {
  const events: DispatchEventInput[] = [];
  const dispatchEvents: DiscordNotificationEvent[] = [];
  const d = deps({
    onEvent: (event) => events.push(event),
    onDispatchEvent: (event) => dispatchEvents.push(event),
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "error",
      text: "",
      agent: "executor",
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-error"));
  await dispatcher.idle();

  expect(
    events.some((event) => event.kind === "dispatch.end" && event.meta?.status === "error"),
  ).toBe(true);
  expect(dispatchEvents).toContainEqual(
    eventMatcher<DiscordNotificationEvent>({
      kind: "adapter_retry_exhausted",
      handoff_id: "h-error",
      agent: "executor",
    }),
  );
});

test("handoff creation failures propagate to hop-end and dispatch.end metadata", async () => {
  const events: DispatchEventInput[] = [];
  const terminalError = {
    status: 403,
    code: "auth_failed",
    message: "penumbra /handoffs: HTTP 403",
  };
  const d = deps({
    onEvent: (event) => events.push(event),
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "handoff_creation_failed",
      terminalError,
      text: "ping @executor",
      agent: "planner",
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-create-failed"));
  await dispatcher.idle();

  const progressCalls = mockCalls<[string, Record<string, unknown>]>(d.postProgress).map(
    (call) => call[1],
  );
  expect(progressCalls.find((call) => call.type === "hop-end")).toMatchObject({
    type: "hop-end",
    error: terminalError,
  });
  expect(progressCalls.find((call) => call.type === "chain-end")).toMatchObject({
    type: "chain-end",
    reason: "handoff_creation_failed",
    error: terminalError,
  });
  expect(events).toContainEqual(
    eventMatcher<DispatchEventInput>({
      kind: "dispatch.end",
      meta: expect.objectContaining({
        status: "error",
        terminal_error: terminalError,
      }) as DispatchEventInput["meta"],
    }),
  );
  const hopEndPayload = progressCalls.find((payload) => payload.type === "hop-end");
  const chainEndPayload = progressCalls.find((payload) => payload.type === "chain-end");
  expect(ConversationHopEndEventSchema.safeParse(hopEndPayload).success).toBe(true);
  expect(ConversationChainEndEventSchema.safeParse(chainEndPayload).success).toBe(true);
  expect(
    ConversationHopEndEventSchema.safeParse({
      type: "hop-end",
      handoff_id: "h-legacy",
      chain_id: "c-legacy",
      text: "done",
      next_handoff_id: null,
      error: "dispatch error",
    }).success,
  ).toBe(true);
});

test("terminal-error dispatch is marked failed, not completed", async () => {
  const d = deps({
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "error",
      text: "",
      agent: "executor",
    }),
    markFailed: mock().mockResolvedValue(undefined),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-error-fail"));
  await dispatcher.idle();

  // The defect: complete() was called on an errored dispatch, durably masking
  // the failure. The corrected behavior routes it through markFailed() so the
  // row stays recoverable.
  expect(d.complete).not.toHaveBeenCalled();
  expect(d.markFailed).toHaveBeenCalledTimes(1);
  expect(mockCalls<[string, string]>(d.markFailed)[0]?.[0]).toBe("h-error-fail");
});

test("thrown dispatch is marked failed with the error summary, not completed", async () => {
  const d = deps({
    dispatch: mock().mockRejectedValue(new Error("adapter exploded")),
    markFailed: mock().mockResolvedValue(undefined),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-thrown"));
  await dispatcher.idle();

  expect(d.complete).not.toHaveBeenCalled();
  expect(d.markFailed).toHaveBeenCalledTimes(1);
  const [id, reason] = mockCalls<[string, string]>(d.markFailed)[0] ?? ["", ""];
  expect(id).toBe("h-thrown");
  expect(reason).toBe("adapter exploded");
});

test("markFailed conflict (already terminal) is swallowed; complete is never called", async () => {
  const d = deps({
    dispatch: mock().mockRejectedValue(new Error("adapter exploded")),
    markFailed: mock().mockRejectedValue(
      new PenumbraHttpError("conflict", 409, "/handoffs/h-thrown-409/fail"),
    ),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-thrown-409"));
  await dispatcher.idle();

  expect(d.complete).not.toHaveBeenCalled();
  expect(d.markFailed).toHaveBeenCalledTimes(1);
});

test("successful dispatch still completes (regression guard for the error routing)", async () => {
  const d = deps({ markFailed: mock().mockResolvedValue(undefined) });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-ok"));
  await dispatcher.idle();

  expect(d.complete).toHaveBeenCalledTimes(1);
  expect(d.complete).toHaveBeenCalledWith("h-ok");
  expect(d.markFailed).not.toHaveBeenCalled();
});

test("aborted dispatch is failed, not completed (shutdown must not mask an in-flight hop)", async () => {
  const started = Promise.withResolvers<undefined>();
  const d = deps({
    markFailed: mock().mockResolvedValue(undefined),
    dispatch: mock().mockImplementation(
      async (_h: unknown, _onChunk: unknown, signal: AbortSignal) => {
        started.resolve(undefined);
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
        // The reachable race: dispatch-handoff returns this WITHOUT marking the
        // row failed (dispatch-handoff.ts:309), so the daemon row is still
        // `dispatched` and a complete() here would win.
        return {
          next: null,
          terminatedReason: "handoff_creation_failed" as const,
          text: "",
          agent: "executor",
        };
      },
    ),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-abort", "c-abort"));
  await started.promise;
  // The shutdown.ts sequence: dispatcher.stop() then dispatcher.idle().
  dispatcher.stop();
  await dispatcher.idle();

  expect(d.complete).not.toHaveBeenCalled();
  expect(d.markFailed).toHaveBeenCalledTimes(1);
  const [id, reason] = mockCalls<[string, string]>(d.markFailed)[0] ?? ["", ""];
  expect(id).toBe("h-abort");
  expect(reason).toBe("cancelled");
});

test("cancelled dispatch result cannot complete without a local abort signal", async () => {
  const d = deps({
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "cancelled",
      text: "",
      agent: "executor",
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h-explicit-cancelled"));
  await dispatcher.idle();

  expect(d.complete).not.toHaveBeenCalled();
  expect(d.markFailed).toHaveBeenCalledWith("h-explicit-cancelled", "cancelled");
});

test("cancelled terminal result emits chain-end cancellation and is marked failed by worker", async () => {
  const events: DispatchEventInput[] = [];
  const started = Promise.withResolvers<undefined>();
  const d = deps({
    onEvent: (event) => events.push(event),
    markFailed: mock().mockResolvedValue(undefined),
    dispatch: mock().mockImplementation(
      async (_h: unknown, _onChunk: unknown, signal: AbortSignal) => {
        started.resolve(undefined);
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
        return {
          next: null,
          terminatedReason: "cancelled" as const,
          text: "",
          agent: "executor",
        };
      },
    ),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-cancelled-result", "c-cancelled-result"));
  await started.promise;
  dispatcher.cancel("c-cancelled-result", "h-cancelled-result");
  await dispatcher.idle();

  const progressCalls = mockCalls<[string, Record<string, unknown>]>(d.postProgress).map(
    (call) => call[1],
  );
  const hopEndPayload = progressCalls.find((payload) => payload.type === "hop-end");
  const chainEndPayload = progressCalls.find((payload) => payload.type === "chain-end");
  expect(hopEndPayload).toMatchObject({
    type: "hop-end",
    next_handoff_id: null,
    error: null,
  });
  expect(chainEndPayload).toMatchObject({
    type: "chain-end",
    reason: "cancelled",
  });
  expect(ConversationChainEndEventSchema.safeParse(chainEndPayload).success).toBe(true);
  expect(events).toContainEqual(
    eventMatcher<DispatchEventInput>({
      kind: "dispatch.end",
      meta: expect.objectContaining({ status: "aborted" }) as DispatchEventInput["meta"],
    }),
  );
  expect(d.complete).not.toHaveBeenCalled();
  expect(d.markFailed).toHaveBeenCalledWith("h-cancelled-result", "cancelled");
});

test("real retry helper and worker finalize cancellation once without another turn", async () => {
  const started = Promise.withResolvers<undefined>();
  const runChatTurn = mock<(input: ChatTurnInput) => Promise<ChatTurnResult>>(
    async ({ signal }) => {
      started.resolve(undefined);
      if (!signal?.aborted) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
      }
      return {
        text: "",
        prompt_event_id: "p-cancel",
        response_event_id: "r-cancel",
        next_mention: null,
        mentions: [],
        error: { message: "adapter aborted" },
      };
    },
  );
  const innerMarkFailed = mock().mockResolvedValue(undefined);
  const createHandoff = mock().mockRejectedValue(new Error("unexpected continuation"));
  const approve = mock().mockResolvedValue(undefined);
  const delay = mock<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  const d = deps({
    dispatch: (handoff, _onChunk, signal) =>
      dispatchHandoff({
        handoff: { ...handoff, from_agent: "planner", message: "m" },
        config: { agents: [], default_roles: {} },
        conversation: { id: handoff.conversation_id, project_id: null },
        transcript: [],
        transcriptBudget: 1000,
        hopsSoFar: 0,
        maxHops: 1,
        trustMode: "all",
        signal,
        observe: () => Promise.resolve({ event_id: "cancel-observation" }),
        createHandoff,
        approve,
        runChatTurn,
        markFailed: innerMarkFailed,
        delay,
      }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h-real-cancel", "c-real-cancel"));
  await started.promise;
  dispatcher.cancel("c-real-cancel", "h-real-cancel");
  await dispatcher.idle();

  expect(runChatTurn).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
  expect(innerMarkFailed).not.toHaveBeenCalled();
  expect(createHandoff).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(d.complete).not.toHaveBeenCalled();
  expect(d.markFailed).toHaveBeenCalledTimes(1);
  expect(d.markFailed).toHaveBeenCalledWith("h-real-cancel", "cancelled");
  expect(d.postProgress).toHaveBeenCalledWith(
    "h-real-cancel",
    expect.objectContaining({
      type: "chain-end",
      chain_id: "c-real-cancel",
      reason: "cancelled",
    }),
    expect.any(AbortSignal),
  );
});

test("missing cli binary fails only the handoff and does not surface an unhandled rejection", async () => {
  const events: DispatchEventInput[] = [];
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const d = deps({
    onEvent: (event) => events.push(event),
    workerId: "w-dispatch",
    dispatch: mock().mockImplementation(
      async (handoff: TestHandoff, _onChunk: unknown, signal: AbortSignal) => {
        const command =
          handoff.handoff_id === "h-missing" ? "/nonexistent/definitely-not-a-binary-xyz" : "sh";
        const args =
          handoff.handoff_id === "h-missing"
            ? ["-c", "printf should-not-run"]
            : ["-c", 'printf "ok"'];
        const result = await spawnCliAdapter({
          command,
          args,
          prompt: handoff.message,
          signal,
          pass_via: "argv",
        });
        return {
          next: null,
          terminatedReason: "no_mention" as const,
          text: result.text,
          agent: handoff.to_agent,
        };
      },
    ),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-missing"));
  await dispatcher.idle();
  await dispatcher.handle(baseHandoff("h-followup"));
  await dispatcher.idle();

  process.off("unhandledRejection", onUnhandledRejection);

  expect(unhandled).toHaveLength(0);
  expect(
    events.some((event) => event.kind === "dispatch.end" && event.handoff_id === "h-missing"),
  ).toBe(true);
  expect(
    events.find((event) => event.kind === "dispatch.end" && event.handoff_id === "h-missing")?.meta
      ?.status,
  ).toBe("error");
  expect(
    events.some((event) => event.kind === "dispatch.end" && event.handoff_id === "h-followup"),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.kind === "dispatch.end" &&
        event.handoff_id === "h-followup" &&
        event.meta?.status === "ok",
    ),
  ).toBe(true);
});

test("streaming stdin dispatch with a missing binary rejects cleanly", async () => {
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const missingStream = spawnCliAdapterStream({
    command: "/nonexistent/definitely-not-a-binary-xyz",
    args: [],
    prompt: "hello",
    signal: new AbortController().signal,
  });

  const missingEvents: DispatchEvent[] = [];
  let thrownErr: unknown;
  try {
    for await (const ev of missingStream) {
      missingEvents.push(ev);
    }
  } catch (err) {
    thrownErr = err;
  }

  process.off("unhandledRejection", onUnhandledRejection);

  expect(missingEvents.some((event) => event.type === "done")).toBe(false);
  expect(thrownErr).toBeInstanceOf(Error);
  expect(unhandled).toHaveLength(0);
});

test("streaming argv dispatch with a missing binary rejects cleanly and later streaming dispatch still works", async () => {
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const missingStream = spawnCliAdapterStream({
    command: "/nonexistent/definitely-not-a-binary-xyz",
    args: ["--ignored"],
    prompt: "hello",
    signal: new AbortController().signal,
    pass_via: "argv",
  });

  const missingEvents: DispatchEvent[] = [];
  let thrownErr: unknown;
  try {
    for await (const ev of missingStream) {
      missingEvents.push(ev);
    }
  } catch (err) {
    thrownErr = err;
  }

  const followupEvents: DispatchEvent[] = [];
  for await (const ev of spawnCliAdapterStream({
    command: "sh",
    args: ["-c", 'printf "ok"'],
    prompt: "",
    signal: new AbortController().signal,
    pass_via: "argv",
  })) {
    followupEvents.push(ev);
  }

  process.off("unhandledRejection", onUnhandledRejection);

  expect(missingEvents.some((event) => event.type === "done")).toBe(false);
  expect(thrownErr).toBeInstanceOf(Error);
  expect(unhandled).toHaveLength(0);
  expect(followupEvents.at(-1)).toEqual(
    expect.objectContaining({
      type: "done",
      result: expect.objectContaining({ text: "ok" }) as unknown,
    }) as DispatchEvent,
  );
});

test("lost claim race (claim throws 409): dispatch NOT called; onClaimRetryable fires so the host forgets dedup", async () => {
  const onClaimRetryable = mock();
  const events: DiscordNotificationEvent[] = [];
  const d = deps({
    claim: mock().mockRejectedValue(new PenumbraHttpError("/handoffs/h1/claim", 409)),
    onClaimRetryable,
    onDispatchEvent: (event) => events.push(event),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();
  expect(d.dispatch).not.toHaveBeenCalled();
  expect(onClaimRetryable).toHaveBeenCalledTimes(1);
  expect(onClaimRetryable).toHaveBeenCalledWith("h1");
  expect(events.some((event) => event.kind === "claim_retry")).toBe(false);
  expect(dispatcher.__internals().claimRetryStateSize).toBe(0);
});

test("claim 404 is treated as terminal, not retryable", async () => {
  const onClaimRetryable = mock();
  const d = deps({
    claim: mock().mockRejectedValue(new PenumbraHttpError("/handoffs/h1/claim", 404)),
    onClaimRetryable,
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();
  expect(onClaimRetryable).not.toHaveBeenCalled();
});

test("claim 500 is retryable: onClaimRetryable is invoked with the handoff_id", async () => {
  const onClaimRetryable = mock();
  const events: DiscordNotificationEvent[] = [];
  const d = deps({
    claim: mock().mockRejectedValue(new PenumbraHttpError("/handoffs/h1/claim", 500)),
    onClaimRetryable,
    onDispatchEvent: (event) => events.push(event),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();
  expect(d.dispatch).not.toHaveBeenCalled();
  expect(onClaimRetryable).toHaveBeenCalledTimes(1);
  expect(onClaimRetryable).toHaveBeenCalledWith("h1");
  expect(events).toContainEqual(
    eventMatcher<DiscordNotificationEvent>({
      kind: "claim_retry",
      handoff_id: "h1",
      agent: "executor",
    }),
  );
});

test("retryable claim failures back off per handoff and reset after success", async () => {
  const onClaimRetryable = mock();
  const events: DiscordNotificationEvent[] = [];
  const claims = mock()
    .mockRejectedValueOnce(new PenumbraHttpError("/handoffs/h1/claim", 500))
    .mockRejectedValueOnce(new PenumbraHttpError("/handoffs/h1/claim", 500))
    .mockResolvedValueOnce({ status: "dispatched" })
    .mockRejectedValueOnce(new PenumbraHttpError("/handoffs/h1/claim", 500));
  const d = deps({
    claim: claims,
    onClaimRetryable,
    onDispatchEvent: (event) => events.push(event),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();

  // onClaimRetryable fires on every retryable failure (incl. backoff-suppressed
  // ones) so the host can re-arm dedup state for re-discovery; the dispatch
  // event/log warn is what's rate-limited by backoff.
  expect(onClaimRetryable).toHaveBeenCalledTimes(3);
  expect(mockCalls<[string]>(onClaimRetryable).map((call) => call[0])).toEqual(["h1", "h1", "h1"]);
  // claim_retry dispatch event is suppressed inside the backoff window (handle
  // #2) but re-emitted after success resets state and a new failure occurs.
  const claimRetryEvents = events.filter((e) => e.kind === "claim_retry");
  expect(claimRetryEvents).toHaveLength(2);
});

test("backoff-active early return still re-arms onClaimRetryable so host can re-surface", async () => {
  const onClaimRetryable = mock();
  const events: DiscordNotificationEvent[] = [];
  const d = deps({
    claim: mock().mockRejectedValue(new PenumbraHttpError("/handoffs/h1/claim", 500)),
    onClaimRetryable,
    onDispatchEvent: (event) => events.push(event),
  });
  const dispatcher = createWorkerDispatcher(d);

  // First failure schedules the backoff window. Second failure lands inside
  // that window (no real delay between handle() calls in the test).
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();

  // Even though the second failure is suppressed for log/dispatch-event
  // emission (rate-limited), it MUST still re-arm onClaimRetryable: the
  // host may have cleared dedup state since the first retry was scheduled
  // and would otherwise never re-surface this row past resumeAtMs.
  expect(onClaimRetryable).toHaveBeenCalledTimes(2);
  expect(mockCalls<[string]>(onClaimRetryable).map((call) => call[0])).toEqual(["h1", "h1"]);
  // But the dispatch claim_retry event fires only once (rate-limited).
  expect(events.filter((e) => e.kind === "claim_retry")).toHaveLength(1);
});

test("claimRetryState stays bounded and is cleared on stop()", async () => {
  const d = deps({
    claim: mock().mockRejectedValue(new PenumbraHttpError("/handoffs/x/claim", 500)),
    onClaimRetryable: mock(),
  });
  const dispatcher = createWorkerDispatcher(d);

  // Populate state with a handful of failing handoffs.
  for (let i = 0; i < 5; i++) {
    await dispatcher.handle(baseHandoff(`h-${String(i)}`, `c-${String(i)}`));
  }
  await dispatcher.idle();
  expect(dispatcher.__internals().claimRetryStateSize).toBe(5);

  // stop() must clear the map for symmetry with the other collections so
  // a recycled dispatcher does not carry forward stale per-handoff backoff.
  dispatcher.stop();
  expect(dispatcher.__internals().claimRetryStateSize).toBe(0);
});

test("claim network error (non-HTTP) is retryable: onClaimRetryable is invoked", async () => {
  const onClaimRetryable = mock();
  const d = deps({
    claim: mock().mockRejectedValue(new Error("fetch failed: connect ECONNREFUSED")),
    onClaimRetryable,
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();
  expect(d.dispatch).not.toHaveBeenCalled();
  expect(onClaimRetryable).toHaveBeenCalledWith("h1");
});

test("claim 408 (timeout) and 429 (rate-limit) are retryable", async () => {
  for (const status of [408, 429]) {
    const onClaimRetryable = mock();
    const d = deps({
      claim: mock().mockRejectedValue(new PenumbraHttpError("/handoffs/h1/claim", status)),
      onClaimRetryable,
    });
    const dispatcher = createWorkerDispatcher(d);
    await dispatcher.handle(baseHandoff("h1"));
    await dispatcher.idle();
    expect(onClaimRetryable).toHaveBeenCalledWith("h1");
  }
});

test("two handoffs for same conversation are serialized", async () => {
  let inflight = 0;
  let maxInflight = 0;
  const d = deps({
    dispatch: mock().mockImplementation(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return { next: null, terminatedReason: "no_mention" as const, text: "", agent: "x" };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await Promise.all([
    dispatcher.handle(baseHandoff("h1", "cA")),
    dispatcher.handle(baseHandoff("h2", "cA")),
  ]);
  await dispatcher.idle();
  expect(maxInflight).toBe(1);
  expect(d.dispatch).toHaveBeenCalledTimes(2);
});

test("cross-conversation dispatch parallelizes up to concurrency cap", async () => {
  let inflight = 0;
  let maxInflight = 0;
  const d = deps({
    concurrency: 2,
    dispatch: mock().mockImplementation(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return { next: null, terminatedReason: "no_mention" as const, text: "", agent: "x" };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await Promise.all([
    dispatcher.handle(baseHandoff("h1", "cA")),
    dispatcher.handle(baseHandoff("h2", "cB")),
    dispatcher.handle(baseHandoff("h3", "cC")),
  ]);
  await dispatcher.idle();
  expect(maxInflight).toBeLessThanOrEqual(2);
  expect(maxInflight).toBeGreaterThanOrEqual(2);
});

test("dispatch throw releases lock and semaphore; subsequent handoffs proceed", async () => {
  let calls = 0;
  const events: DiscordNotificationEvent[] = [];
  const d = deps({
    onDispatchEvent: (event) => events.push(event),
    dispatch: mock().mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("adapter blew up"));
      return Promise.resolve({
        next: null,
        terminatedReason: "no_mention" as const,
        text: "",
        agent: "x",
      });
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1", "cA"));
  await dispatcher.handle(baseHandoff("h2", "cA"));
  await dispatcher.idle();
  expect(d.dispatch).toHaveBeenCalledTimes(2);
  expect(events).toContainEqual(
    eventMatcher<DiscordNotificationEvent>({
      kind: "adapter_retry_exhausted",
      handoff_id: "h1",
      agent: "executor",
    }),
  );
});

test("token batching: multiple rapid chunks are coalesced into fewer POSTs", async () => {
  let progressCount = 0;
  const d = deps({
    postProgress: mock().mockImplementation(async () => {
      progressCount++;
      // simulated latency shorter than cooldown
      await new Promise((r) => setTimeout(r, 10));
    }),
    dispatch: mock().mockImplementation(async (_h: unknown, onChunk: (delta: string) => void) => {
      onChunk("t1"); // fires immediately
      await new Promise((r) => setTimeout(r, 50));
      onChunk("t2"); // arrives during cooldown (cooldown ends at ~110ms)
      await new Promise((r) => setTimeout(r, 20));
      onChunk("t3"); // arrives during cooldown
      return { next: null, terminatedReason: "no_mention" as const, text: "t1t2t3", agent: "x" };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();

  const tokenCalls = mockCalls<[string, ProgressPayload]>(d.postProgress).filter(
    (c) => c[1].type === "token",
  );
  // With correct cooldown, t2 and t3 should be batched and sent AFTER the cooldown.
  // Currently, t2 will fire immediately at 50ms because inflightProgress is already null.
  expect(tokenCalls.length).toBeLessThan(3);
  // progressCount is reported by the postProgress mock; assert it tracked at
  // least one flight so the silenced linter rule doesn't shadow a regression
  // where postProgress is never invoked at all.
  expect(progressCount).toBeGreaterThanOrEqual(1);
});

test("slow postProgress keeps the buffered token queue bounded", async () => {
  const releaseFirst = Promise.withResolvers<undefined>();
  const firstSeen = Promise.withResolvers<undefined>();
  const d = deps({
    postProgress: mock().mockImplementation(
      async (_handoffId: string, payload: ProgressPayload) => {
        if (payload.type === "token") {
          firstSeen.resolve();
          await releaseFirst.promise;
        }
      },
    ),
    dispatch: mock().mockImplementation(async (_h: unknown, onChunk: (delta: string) => void) => {
      onChunk("seed");
      await firstSeen.promise;
      for (let i = 0; i < 200; i++) {
        onChunk(`chunk-${String(i).padStart(3, "0")}-xxxxxxxxxxxxxxxx`);
      }
      return { next: null, terminatedReason: "no_mention" as const, text: "done", agent: "x" };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  const handlePromise = dispatcher.handle(baseHandoff("h-bounded"));
  await firstSeen.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const internals = dispatcher.__internals() as {
    claimRetryStateSize: number;
    progressBufferBytes?: number;
    progressBufferedChunks?: number;
    progressBufferText?: unknown;
  };
  expect(internals.progressBufferBytes ?? 0).toBeLessThanOrEqual(16_384);
  expect(internals.progressBufferedChunks ?? 0).toBeLessThanOrEqual(64);
  releaseFirst.resolve();
  await handlePromise;
  await dispatcher.idle();
  expect(d.postProgress).toHaveBeenCalled();
});

test("claimGraceMs > 0 delays BEFORE claim (cross-project affinity grace)", async () => {
  const order: string[] = [];
  const delay = mock().mockImplementation((ms: number) => {
    order.push(`delay:${String(ms)}`);
    return Promise.resolve();
  });
  const claim = mock().mockImplementation(() => {
    order.push("claim");
    return Promise.resolve({ status: "dispatched" });
  });
  const d = deps({ claim, delay, claimGraceMs: () => 500 });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("cross"));
  await dispatcher.idle();
  // The grace is awaited before the claim fires, so a home worker can win first.
  expect(order).toEqual(["delay:500", "claim"]);
  expect(d.claim).toHaveBeenCalledTimes(1);
});

test("claimGraceMs 0 (home worker) claims immediately, no delay", async () => {
  const delay = mock().mockResolvedValue(undefined);
  const d = deps({ delay, claimGraceMs: () => 0 });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("home"));
  await dispatcher.idle();
  expect(delay).not.toHaveBeenCalled();
  expect(d.claim).toHaveBeenCalledTimes(1);
});

test("no claimGraceMs dep → claim immediately (backward compatible)", async () => {
  const delay = mock().mockResolvedValue(undefined);
  const d = deps({ delay });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();
  expect(delay).not.toHaveBeenCalled();
  expect(d.claim).toHaveBeenCalledTimes(1);
});

test("unmatched handoff-scoped cancels are bounded and evict oldest entries", () => {
  const d = deps();
  const dispatcher = createWorkerDispatcher(d);

  for (let i = 0; i < 1_005; i++) {
    dispatcher.cancel("c-leak", `h-${String(i).padStart(4, "0")}`);
  }

  const internals = dispatcher.__internals() as {
    pendingCancelsByHandoffKeys?: string[];
    pendingCancelsByHandoffSize?: number;
  };
  expect(internals.pendingCancelsByHandoffSize).toBe(1_000);
  expect(internals.pendingCancelsByHandoffKeys?.[0]).toBe("h-0005");
  expect(internals.pendingCancelsByHandoffKeys).not.toContain("h-0000");
});

test("unmatched conversation-scoped cancels are bounded and evict oldest entries", () => {
  const d = deps();
  const dispatcher = createWorkerDispatcher(d);

  for (let i = 0; i < 1_005; i++) {
    dispatcher.cancel(`c-${String(i).padStart(4, "0")}`);
  }

  const internals = dispatcher.__internals() as {
    pendingCancelsByConvKeys?: string[];
    pendingCancelsByConvSize?: number;
  };
  expect(internals.pendingCancelsByConvSize).toBe(1_000);
  expect(internals.pendingCancelsByConvKeys?.[0]).toBe("c-0005");
  expect(internals.pendingCancelsByConvKeys).not.toContain("c-0000");
});

function reportTerminalDeps(
  over: Partial<WorkerDispatcherDeps> = {},
  status: "delivered" | "pending" | "superseded" = "delivered",
): { d: WorkerDispatcherDeps; reports: TerminalReport[]; onEventCalls: DispatchEventInput[] } {
  const reports: TerminalReport[] = [];
  const onEventCalls: DispatchEventInput[] = [];
  const d = deps({
    reportTerminal: mock((report: TerminalReport) => {
      reports.push(report);
      return Promise.resolve(status);
    }),
    onEvent: (event) => {
      onEventCalls.push(event);
    },
    workerId: "w-terminal",
    ...over,
  });
  return { d, reports, onEventCalls };
}

test("reportTerminal wired: dispatch.end travels inside the report, not the lossy queue", async () => {
  const { d, reports, onEventCalls } = reportTerminalDeps();
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-terminal"));
  await dispatcher.idle();

  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report.handoff_id).toBe("h-terminal");
  expect(report.worker_id).toBe("w-terminal");
  expect(report.outcome).toBe("complete");
  expect(report.reason).toBeUndefined();
  expect(report.dispatch_end.kind).toBe("dispatch.end");
  expect(report.dispatch_end.meta?.status).toBe("ok");
  // dispatch.end must NOT also go through the lossy event queue — it would be
  // duplicated on outbox replay.
  expect(onEventCalls.some((event) => event.kind === "dispatch.end")).toBe(false);
  // The legacy terminal calls are replaced by the report.
  expect(d.complete).not.toHaveBeenCalled();
  expect(d.markFailed).not.toHaveBeenCalled();
});

test("reportTerminal wired: post-turn progress failures do not flip status to error", async () => {
  const { d, reports } = reportTerminalDeps({
    onChainEnd: mock(),
    dispatch: mock().mockImplementation((_h: unknown, onChunk: (delta: string) => void) => {
      onChunk("tail-delta");
      return Promise.resolve({
        next: null,
        terminatedReason: "no_mention" as const,
        text: "tail-delta",
        agent: "executor",
      });
    }),
    postProgress: mock().mockImplementation((_id: string, payload: ProgressPayload) => {
      if (payload.type === "hop-start") return Promise.resolve();
      // The tail token flush, hop-end, and chain-end all fail — exactly what a
      // blocked daemon main thread did on 2026-10-06.
      return Promise.reject(new TypeError("The socket connection was closed unexpectedly"));
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-postturn"));
  await dispatcher.idle();

  // A progress failure must no longer flip status to 'error' or skip onChainEnd.
  expect(d.onChainEnd).toHaveBeenCalledTimes(1);
  expect(reports).toHaveLength(1);
  expect(reports[0]!.outcome).toBe("complete");
  expect(reports[0]!.dispatch_end.meta?.status).toBe("ok");
  expect(d.markFailed).not.toHaveBeenCalled();
});

test("reportTerminal wired: 'pending' return does not block idle()", async () => {
  const { d } = reportTerminalDeps({}, "pending");
  const dispatcher = createWorkerDispatcher(d);

  const start = Date.now();
  await dispatcher.handle(baseHandoff("h-pending"));
  await dispatcher.idle();

  expect(Date.now() - start).toBeLessThan(2_000);
});

test("reportTerminal wired: pendingObservations on the result land in the report", async () => {
  const env = { event_id: "pre-1", event_type: "agent-response" };
  const { d, reports } = reportTerminalDeps({
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "no_mention" as const,
      text: "done",
      agent: "executor",
      pendingObservations: [env],
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-pending-obs"));
  await dispatcher.idle();

  expect(reports[0]!.observations).toEqual([env]);
});

test("reportTerminal wired: pendingObservations carried on a thrown dispatch error land in the report", async () => {
  const env = { event_id: "pre-2", event_type: "agent-response" };
  const thrown = Object.assign(new TypeError("socket closed"), {
    pendingObservations: [env],
  });
  const { d, reports } = reportTerminalDeps({
    dispatch: mock().mockRejectedValue(thrown),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-thrown-pending"));
  await dispatcher.idle();

  expect(reports).toHaveLength(1);
  expect(reports[0]!.outcome).toBe("fail");
  expect(reports[0]!.reason).toBe("socket closed");
  expect(reports[0]!.observations).toEqual([env]);
});

test("reportTerminal wired: adapterError message becomes the fail reason", async () => {
  const { d, reports } = reportTerminalDeps({
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "error" as const,
      adapterError: { message: "adapter blew up" },
      text: "",
      agent: "executor",
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-adapter-err"));
  await dispatcher.idle();

  expect(reports[0]!.outcome).toBe("fail");
  expect(reports[0]!.reason).toBe("adapter blew up");
});

test("adapterError message also wins the legacy markFailed reason", async () => {
  const d = deps({
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "error" as const,
      adapterError: { message: "adapter blew up" },
      text: "",
      agent: "executor",
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-adapter-err-legacy"));
  await dispatcher.idle();

  expect(d.markFailed).toHaveBeenCalledWith("h-adapter-err-legacy", "adapter blew up");
});

test("reportTerminal wired: cancelled dispatch stays fail-closed (outcome 'fail', reason 'cancelled')", async () => {
  const { d, reports } = reportTerminalDeps({
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "cancelled" as const,
      text: "",
      agent: "executor",
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-cancelled-report"));
  await dispatcher.idle();

  expect(reports[0]!.outcome).toBe("fail");
  expect(reports[0]!.reason).toBe("cancelled");
});

test("a mid-turn token post slower than the timeout does not abort the dispatch", async () => {
  let dispatches = 0;
  const d = deps({
    progressPostTimeoutMs: 30,
    postProgress: mock().mockImplementation(
      (_id: string, payload: ProgressPayload, signal?: AbortSignal) => {
        if (payload.type !== "token" || !signal) return Promise.resolve();
        // A hung mid-turn token post: rejects only when the timeout signal fires.
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("timed out", "TimeoutError"));
            },
            { once: true },
          );
        });
      },
    ),
    dispatch: mock().mockImplementation(
      async (_h: unknown, onChunk: (delta: string) => void, signal: AbortSignal) => {
        dispatches++;
        onChunk("partial");
        await new Promise((r) => setTimeout(r, 250));
        if (signal.aborted) {
          return {
            next: null,
            terminatedReason: "cancelled" as const,
            text: "",
            agent: "executor",
          };
        }
        return {
          next: null,
          terminatedReason: "no_mention" as const,
          text: "done",
          agent: "executor",
        };
      },
    ),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-slow-token"));
  await dispatcher.idle();

  expect(dispatches).toBe(1);
  // The slow token post dropped its delta; the dispatch was NOT aborted.
  expect(d.complete).toHaveBeenCalledTimes(1);
  expect(d.markFailed).not.toHaveBeenCalled();
});

test("reportTerminal throwing is logged but does not wedge the dispatcher", async () => {
  const warns: unknown[][] = [];
  const { d } = reportTerminalDeps({
    reportTerminal: mock((_report: TerminalReport) => {
      return Promise.reject(new Error("outbox exploded"));
    }),
    log: asLogger({
      info: mock(),
      warn: mock((...args: unknown[]) => {
        warns.push(args);
      }),
      debug: mock(),
    }),
  });
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-report-throws"));
  await dispatcher.idle();

  expect(warns.length).toBeGreaterThanOrEqual(1);
  expect(d.complete).not.toHaveBeenCalled();
});

import { expect, test, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCliAdapter, spawnCliAdapterStream } from "../../src/adapters/cli-spawn.js";
import { createWorkerDispatcher, type WorkerDispatcherDeps } from "../../src/worker/dispatcher.js";
import { PenumbraClient, PenumbraHttpError } from "../../src/penumbra-client.js";

function makeMockClient(fetchImpl: typeof fetch): { client: PenumbraClient; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pen-dispatch-test-"));
  writeFileSync(join(root, "port"), "1\n");
  writeFileSync(join(root, "token"), "shared-tok\n");
  const client = new PenumbraClient({ storageRoot: root, fetch: fetchImpl });
  return { client, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const baseHandoff = (id: string, conv = "c1") => ({
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
    log: { info: () => {}, warn: () => {}, debug: () => {} } as any,
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

test("progress events are emitted in order", async () => {
  const d = deps({
    dispatch: mock().mockImplementation(async (_h, onChunk) => {
      onChunk("hi");
      onChunk(" there");
      return { next: null, terminatedReason: "no_mention", text: "hi there", agent: "executor" };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();

  // hop-start, tokens, hop-end
  const calls = (d.postProgress as any).mock.calls.map((c: any[]) => c[1].type);
  expect(calls[0]).toBe("hop-start");
  expect(calls).toContain("token");
  expect(calls[calls.length - 1]).toBe("chain-end");
});

test("emits dispatch_start after claim and before hop-start progress", async () => {
  const order: string[] = [];
  const events: any[] = [];
  const d = deps({
    claim: mock().mockImplementation(async () => {
      order.push("claim");
      return { status: "dispatched" };
    }),
    onDispatchEvent: (event: any) => {
      order.push(event.kind);
      events.push(event);
    },
    postProgress: mock().mockImplementation(async (_handoffId, payload) => {
      if (payload.type === "hop-start") order.push("hop-start");
    }),
  } as any);
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-1", "c-1"));
  await dispatcher.idle();

  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "dispatch_start",
      handoff_id: "h-1",
      conversation_id: "c-1",
      agent: "executor",
    }),
  );
  expect(order.slice(0, 3)).toEqual(["claim", "dispatch_start", "hop-start"]);
});

test("waits for durable dispatch.start delivery before calling dispatch", async () => {
  const order: string[] = [];
  const startPosted = Promise.withResolvers<void>();
  const releaseStart = Promise.withResolvers<void>();
  const d = deps({
    dispatchStartBarrier: async (event: any) => {
      order.push(event.kind);
      startPosted.resolve();
      await releaseStart.promise;
    },
    dispatch: mock().mockImplementation(async () => {
      order.push("dispatch");
      return { next: null, terminatedReason: "no_mention", text: "result", agent: "executor" };
    }),
    postProgress: mock().mockImplementation(async (_handoffId, payload) => {
      if (payload.type === "hop-start") order.push("hop-start");
    }),
  } as any);
  const dispatcher = createWorkerDispatcher(d);

  const handlePromise = dispatcher.handle(baseHandoff("h-durable"));
  await startPosted.promise;
  expect(d.dispatch).not.toHaveBeenCalled();
  releaseStart.resolve();
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
  const { client, cleanup } = makeMockClient(fetchImpl as any);

  const d = deps({
    dispatchStartBarrier: (event: any) => client.postDispatchEventsStrict([event]),
  } as any);
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

test("aborts dispatch when durable dispatch.start delivery fails (connection refused)", async () => {
  const fetchImpl = mock().mockRejectedValue(new TypeError("fetch failed"));
  const { client, cleanup } = makeMockClient(fetchImpl as any);

  const d = deps({
    dispatchStartBarrier: (event: any) => client.postDispatchEventsStrict([event]),
  } as any);
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
  expect(onChainEnd).toHaveBeenCalledWith(handoff, "completed", null, null, null, 0, null);
});

test("emits dispatch.start and dispatch.end events on successful dispatch", async () => {
  const events: any[] = [];
  const d = deps({ onEvent: (event: any) => events.push(event), workerId: "w-dispatch" } as any);
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
  const events: any[] = [];
  const d = deps({
    onEvent: (event: any) => events.push(event),
    workerId: "w-dispatch",
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "no_mention",
      text: "result",
      agent: "executor",
      meta: { framework_overhead_ms: 321 },
    }),
  } as any);
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-overhead"));
  await dispatcher.idle();

  const end = events.find((event) => event.kind === "dispatch.end");
  expect(end?.meta?.framework_overhead_ms).toBe(321);
});

test("emits cancel.dispatched when cancellation matches an active dispatch", async () => {
  const events: any[] = [];
  const started = Promise.withResolvers<void>();
  const d = deps({
    onEvent: (event: any) => events.push(event),
    workerId: "w-dispatch",
    dispatch: mock().mockImplementation(async (_h, _onChunk, signal: AbortSignal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { next: null, terminatedReason: "untrusted", text: "", agent: "executor" };
    }),
  } as any);
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

test("emits dispatch.end status=error when dispatch reports terminal error", async () => {
  const events: any[] = [];
  const dispatchEvents: any[] = [];
  const d = deps({
    onEvent: (event: any) => events.push(event),
    onDispatchEvent: (event: any) => dispatchEvents.push(event),
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "error",
      text: "",
      agent: "executor",
    }),
  } as any);
  const dispatcher = createWorkerDispatcher(d);

  await dispatcher.handle(baseHandoff("h-error"));
  await dispatcher.idle();

  expect(
    events.some((event) => event.kind === "dispatch.end" && event.meta?.status === "error"),
  ).toBe(true);
  expect(dispatchEvents).toContainEqual(
    expect.objectContaining({
      kind: "adapter_retry_exhausted",
      handoff_id: "h-error",
      agent: "executor",
    }),
  );
});

test("missing cli binary fails only the handoff and does not surface an unhandled rejection", async () => {
  const events: any[] = [];
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const d = deps({
    onEvent: (event: any) => events.push(event),
    workerId: "w-dispatch",
    dispatch: mock().mockImplementation(async (handoff, _onChunk, signal: AbortSignal) => {
      const command =
        handoff.handoff_id === "h-missing" ? "/nonexistent/definitely-not-a-binary-xyz" : "sh";
      const args =
        handoff.handoff_id === "h-missing"
          ? ["-c", "printf should-not-run"]
          : ["-c", 'printf "ok"'];
      const result = await spawnCliAdapter({
        command,
        args,
        prompt: handoff.message ?? "",
        signal,
        pass_via: "argv",
      });
      return {
        next: null,
        terminatedReason: "no_mention",
        text: result.text,
        agent: handoff.to_agent,
      };
    }),
  } as any);
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
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const missingStream = spawnCliAdapterStream({
    command: "/nonexistent/definitely-not-a-binary-xyz",
    args: [],
    prompt: "hello",
    signal: new AbortController().signal,
  });

  const missingEvents: any[] = [];
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
  const onUnhandledRejection = (reason: unknown) => {
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

  const missingEvents: any[] = [];
  let thrownErr: unknown;
  try {
    for await (const ev of missingStream) {
      missingEvents.push(ev);
    }
  } catch (err) {
    thrownErr = err;
  }

  const followupEvents: any[] = [];
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
      result: expect.objectContaining({ text: "ok" }),
    }),
  );
});

test("lost claim race (claim throws 409): dispatch is NOT called; no rethrow", async () => {
  const onClaimRetryable = mock();
  const d = deps({
    claim: mock().mockRejectedValue(new PenumbraHttpError("/handoffs/h1/claim", 409)),
    onClaimRetryable,
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();
  expect(d.dispatch).not.toHaveBeenCalled();
  expect(onClaimRetryable).not.toHaveBeenCalled();
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
  const events: any[] = [];
  const d = deps({
    claim: mock().mockRejectedValue(new PenumbraHttpError("/handoffs/h1/claim", 500)),
    onClaimRetryable,
    onDispatchEvent: (event: any) => events.push(event),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();
  expect(d.dispatch).not.toHaveBeenCalled();
  expect(onClaimRetryable).toHaveBeenCalledTimes(1);
  expect(onClaimRetryable).toHaveBeenCalledWith("h1");
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "claim_retry",
      handoff_id: "h1",
      agent: "executor",
    }),
  );
});

test("retryable claim failures back off per handoff and reset after success", async () => {
  const onClaimRetryable = mock();
  const claims = mock()
    .mockRejectedValueOnce(new PenumbraHttpError("/handoffs/h1/claim", 500))
    .mockRejectedValueOnce(new PenumbraHttpError("/handoffs/h1/claim", 500))
    .mockResolvedValueOnce({ status: "dispatched" })
    .mockRejectedValueOnce(new PenumbraHttpError("/handoffs/h1/claim", 500));
  const d = deps({
    claim: claims,
    onClaimRetryable,
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

  expect(onClaimRetryable).toHaveBeenCalledTimes(2);
  expect(onClaimRetryable.mock.calls.map((call) => call[0])).toEqual(["h1", "h1"]);
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
      return { next: null, terminatedReason: "no_mention", text: "", agent: "x" };
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
      return { next: null, terminatedReason: "no_mention", text: "", agent: "x" };
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
  const events: any[] = [];
  const d = deps({
    onDispatchEvent: (event: any) => events.push(event),
    dispatch: mock().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error("adapter blew up");
      return { next: null, terminatedReason: "no_mention", text: "", agent: "x" };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1", "cA"));
  await dispatcher.handle(baseHandoff("h2", "cA"));
  await dispatcher.idle();
  expect(d.dispatch).toHaveBeenCalledTimes(2);
  expect(events).toContainEqual(
    expect.objectContaining({
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
    dispatch: mock().mockImplementation(async (_h, onChunk) => {
      onChunk("t1"); // fires immediately
      await new Promise((r) => setTimeout(r, 50));
      onChunk("t2"); // arrives during cooldown (cooldown ends at ~110ms)
      await new Promise((r) => setTimeout(r, 20));
      onChunk("t3"); // arrives during cooldown
      return { next: null, terminatedReason: "no_mention", text: "t1t2t3", agent: "x" };
    }),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(baseHandoff("h1"));
  await dispatcher.idle();

  const tokenCalls = (d.postProgress as any).mock.calls.filter((c: any[]) => c[1].type === "token");
  // With correct cooldown, t2 and t3 should be batched and sent AFTER the cooldown.
  // Currently, t2 will fire immediately at 50ms because inflightProgress is already null.
  expect(tokenCalls.length).toBeLessThan(3);
});

test("claimGraceMs > 0 delays BEFORE claim (cross-project affinity grace)", async () => {
  const order: string[] = [];
  const delay = mock().mockImplementation(async (ms: number) => {
    order.push(`delay:${ms}`);
  });
  const claim = mock().mockImplementation(async () => {
    order.push("claim");
    return { status: "dispatched" };
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

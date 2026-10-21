import type { Logger } from "@penumbra/core";

import { expect, mock, test } from "bun:test";

import {
  createWorkerDispatcher,
  type DispatcherHandoff,
  type WorkerDispatcherDeps,
} from "@src/worker/dispatcher.js";

function handoff(id: string, conv = `c-${id}`): DispatcherHandoff {
  return { handoff_id: id, conversation_id: conv, to_agent: "executor", message: "m" };
}

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
    log: { info: mock(), warn: mock(), debug: mock() } as unknown as Logger,
    concurrency: 1,
    ...over,
  };
}

test("a failed memory admission leaves the handoff unclaimed and re-offerable", async () => {
  const d = deps({
    admitClaim: mock().mockResolvedValue(false),
    onClaimRetryable: mock(),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(handoff("h1"));
  await dispatcher.idle();
  expect(d.claim).not.toHaveBeenCalled();
  expect(d.dispatch).not.toHaveBeenCalled();
  expect(d.onClaimRetryable).toHaveBeenCalledWith("h1");
});

test("an admitted handoff is claimed and dispatched", async () => {
  const d = deps({ admitClaim: mock().mockResolvedValue(true) });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(handoff("h2"));
  await dispatcher.idle();
  expect(d.admitClaim).toHaveBeenCalledTimes(1);
  expect(d.claim).toHaveBeenCalledWith("h2");
  expect(d.dispatch).toHaveBeenCalledTimes(1);
});

test("admission runs after the concurrency slot is taken and before the claim", async () => {
  const order: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const d = deps({
    admitClaim: mock((h: DispatcherHandoff) => {
      order.push(`admit:${h.handoff_id}`);
      return Promise.resolve(true);
    }),
    claim: mock((id: string) => {
      order.push(`claim:${id}`);
      return Promise.resolve({ status: "dispatched" });
    }),
    dispatch: mock(
      (h: DispatcherHandoff) =>
        new Promise<Awaited<ReturnType<WorkerDispatcherDeps["dispatch"]>>>((resolve) => {
          order.push(`dispatch:${h.handoff_id}`);
          const done = (): void => {
            resolve({ next: null, terminatedReason: "no_mention", text: "r", agent: "executor" });
          };
          if (h.handoff_id === "a") releaseFirst = done;
          else done();
        }),
    ),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(handoff("a"));
  await dispatcher.handle(handoff("b"));
  for (let i = 0; i < 50 && !order.includes("dispatch:a"); i++) await Bun.sleep(2);
  expect(order).toEqual(["admit:a", "claim:a", "dispatch:a"]);
  releaseFirst();
  await dispatcher.idle();
  expect(order).toEqual(["admit:a", "claim:a", "dispatch:a", "admit:b", "claim:b", "dispatch:b"]);
});

test("a cancel during the admission wait falls through to the normal cancel path", async () => {
  let seenSignal: AbortSignal | undefined;
  const d = deps({
    admitClaim: mock(
      (_h: DispatcherHandoff, signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          seenSignal = signal;
          signal.addEventListener("abort", () => {
            resolve(false);
          });
        }),
    ),
    onClaimRetryable: mock(),
  });
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(handoff("h3", "conv-3"));
  for (let i = 0; i < 50 && !seenSignal; i++) await Bun.sleep(2);
  dispatcher.cancel("conv-3", "h3");
  await dispatcher.idle();
  expect(seenSignal?.aborted).toBe(true);
  expect(d.onClaimRetryable).not.toHaveBeenCalled();
  expect(d.claim).toHaveBeenCalledWith("h3");
});

import { type Logger } from "@penumbra/core";
import { expect, mock, test } from "bun:test";

import { PenumbraHttpError } from "@src/penumbra-client.js";
import { createWorkerDispatcher, type WorkerDispatcherDeps } from "@src/worker/dispatcher.js";
import {
  type EventSourceClient,
  type EventSourceRow,
  startEventSource,
} from "@src/worker/event-source.js";

interface TestHandoff extends EventSourceRow {
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
}

const baseHandoff = (id: string): TestHandoff => ({
  handoff_id: id,
  ts: "t",
  project_id: null,
  conversation_id: "c1",
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

function asLogger(stub: { info: unknown; warn: unknown; debug: unknown }): Logger {
  return stub as unknown as Logger;
}

function mockCalls<T extends readonly unknown[] = unknown[]>(fn: unknown): T[] {
  return (fn as { mock: { calls: T[] } }).mock.calls;
}

async function waitForMockCallCount(fn: unknown, expected: number, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (mockCalls(fn).length < expected) {
    if (Date.now() >= deadline) {
      throw new Error(`${label} was called ${String(mockCalls(fn).length)} times, expected ${String(expected)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deps(
  over: Partial<WorkerDispatcherDeps<TestHandoff>> = {},
): WorkerDispatcherDeps<TestHandoff> {
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

test("terminal 409 claim conflict clears event-source dedup so re-emitted handoff is claimed again", async () => {
  const queue: TestHandoff[] = [];
  let wake: (() => void) | undefined;
  const push = (row: TestHandoff): void => {
    queue.push(row);
    wake?.();
    wake = undefined;
  };
  async function* pushableHandoffs(opts?: {
    signal?: AbortSignal;
  }): AsyncGenerator<TestHandoff, void, undefined> {
    while (!opts?.signal?.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          const onAbort = (): void => {
            clearWake();
          };
          const clearWake = (): void => {
            if (wake === clearWake) wake = undefined;
            opts?.signal?.removeEventListener("abort", onAbort);
            resolve();
          };
          wake = clearWake;
          opts?.signal?.addEventListener("abort", onAbort, { once: true });
        });
        continue;
      }
      const next = queue.shift();
      if (next) yield next;
    }
  }

  const client: EventSourceClient = {
    listHandoffs: mock(() => Promise.resolve({ handoffs: [] as EventSourceRow[] })),
    subscribeHandoffEvents: pushableHandoffs,
  };
  const claim = mock()
    .mockRejectedValueOnce(new PenumbraHttpError("/handoffs/h1/claim", 409))
    .mockResolvedValueOnce({ status: "dispatched" });
  const dispatch = mock().mockResolvedValue({
    next: null,
    terminatedReason: "no_mention",
    text: "result",
    agent: "executor",
  });
  const d = deps({ claim, dispatch });
  const dispatcher = createWorkerDispatcher(d);
  const handle = startEventSource({
    client,
    statuses: ["approved"],
    pollIntervalMs: 10_000,
    onEvent: (row) => {
      void dispatcher.handle(row as TestHandoff);
    },
  });
  const forgetSpy = mock((id: string) => {
    handle.forget(id);
  });
  d.onClaimRetryable = forgetSpy;

  push(baseHandoff("h1"));
  await waitForMockCallCount(claim, 1, "claim");
  await dispatcher.idle();
  expect(claim).toHaveBeenCalledTimes(1);
  expect(forgetSpy).toHaveBeenCalledTimes(1);
  expect(forgetSpy).toHaveBeenCalledWith("h1");
  expect(dispatch).not.toHaveBeenCalled();
  expect(d.postProgress).not.toHaveBeenCalled();
  expect(d.markFailed).not.toHaveBeenCalled();
  expect(d.complete).not.toHaveBeenCalled();

  push(baseHandoff("h1"));
  await waitForMockCallCount(claim, 2, "claim");
  await dispatcher.idle();
  expect(claim).toHaveBeenCalledTimes(2);
  expect(dispatch).toHaveBeenCalledTimes(1);
  await handle.stop();
});

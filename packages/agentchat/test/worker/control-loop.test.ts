import type { Logger } from "@penumbra/core";
import type { DispatchHandoffResult } from "@src/cli/dispatch-handoff.js";

import { createWorkerDispatcher, type WorkerDispatcherDeps } from "@src/worker/dispatcher.js";
import { expect, mock, test } from "bun:test";

// pino's Logger has heavily-overloaded info/warn/debug signatures the bun mock
// can't structurally satisfy. Single laundering helper produces a Logger-typed
// stub from a plain {info,warn,debug} shape.
function asLogger(stub: { info: unknown; warn: unknown; debug: unknown }): Logger {
  return stub as unknown as Logger;
}

interface TestHandoff {
  handoff_id: string;
  conversation_id: string;
  to_agent: string;
}

// Boxed state so a callback assigning to `.signal` / `.started` is not
// narrowed by TS control-flow to the initial literal type. Direct `let`
// bindings trip @typescript-eslint/no-unnecessary-condition on later
// truthy checks because the linter cannot see the mutation through the
// dispatch callback.
interface DispatchProbe {
  signal: AbortSignal | null;
  started: boolean;
}

function makeAbortableDispatch(
  capture: (signal: AbortSignal) => void,
): WorkerDispatcherDeps["dispatch"] {
  return mock((_h: unknown, _onChunk: (delta: string) => void, signal: AbortSignal) => {
    capture(signal);
    return new Promise<DispatchHandoffResult>((resolve) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve({
          next: null,
          terminatedReason: "untrusted",
          text: "aborted",
          agent: "x",
        });
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
    });
  });
}

function makeDeps(over: Partial<WorkerDispatcherDeps> = {}): WorkerDispatcherDeps {
  return {
    claim: mock(() => Promise.resolve({ status: "dispatched" })),
    dispatch: mock(() =>
      Promise.resolve({
        next: null,
        terminatedReason: "no_mention" as const,
        text: "result",
        agent: "x",
      }),
    ),
    postProgress: mock(() => Promise.resolve()),
    complete: mock(() => Promise.resolve()),
    markFailed: mock(() => Promise.resolve()),
    log: asLogger({ info: mock(), warn: mock(), debug: mock() }),
    concurrency: 4,
    ...over,
  };
}

function waitForStarted(probe: DispatchProbe): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if (probe.started) {
        resolve();
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function expectAborted(signal: AbortSignal | null, value: boolean): void {
  if (signal === null) {
    throw new Error("expected signal to be captured");
  }
  expect(signal.aborted).toBe(value);
}

test("dispatcher.cancel(cid) triggers abort on active dispatch", async () => {
  const probe: DispatchProbe = { signal: null, started: false };

  const deps = makeDeps({
    dispatch: makeAbortableDispatch((signal) => {
      probe.signal = signal;
      probe.started = true;
    }),
  });

  const dispatcher = createWorkerDispatcher(deps);
  const handoff: TestHandoff = { handoff_id: "h1", conversation_id: "c1", to_agent: "a1" };

  void dispatcher.handle(handoff);
  await waitForStarted(probe);
  expectAborted(probe.signal, false);

  dispatcher.cancel("c1");

  await dispatcher.idle();
  expectAborted(probe.signal, true);
});

test("dispatcher.stop() aborts all active dispatches", async () => {
  const probeA: DispatchProbe = { signal: null, started: false };
  const probeB: DispatchProbe = { signal: null, started: false };

  const deps = makeDeps({
    dispatch: makeAbortableDispatch((signal) => {
      if (probeA.signal === null) {
        probeA.signal = signal;
        probeA.started = true;
      } else {
        probeB.signal = signal;
        probeB.started = true;
      }
    }),
  });

  const dispatcher = createWorkerDispatcher(deps);
  void dispatcher.handle({ handoff_id: "h1", conversation_id: "c1", to_agent: "a1" });
  void dispatcher.handle({ handoff_id: "h2", conversation_id: "c2", to_agent: "a2" });

  await waitForStarted(probeA);
  await waitForStarted(probeB);

  expectAborted(probeA.signal, false);
  expectAborted(probeB.signal, false);

  dispatcher.stop();

  expectAborted(probeA.signal, true);
  expectAborted(probeB.signal, true);
});

test("dispatcher.cancel(cid, hid) does NOT abort when hid is for a different (stale) handoff in same conv", async () => {
  // Repro for the SSE-reconnect replay bug: daemon flushes durable
  // cancellations on every fresh /worker/control connection. If a
  // previously-cancelled handoff's row is still in the replay set when
  // a NEW dispatch for the same conversation is in flight, the stale
  // cancel must not kill the fresh work.
  const probe: DispatchProbe = { signal: null, started: false };

  const deps = makeDeps({
    dispatch: makeAbortableDispatch((signal) => {
      probe.signal = signal;
      probe.started = true;
    }),
  });

  const dispatcher = createWorkerDispatcher(deps);

  // Active dispatch is handoff h-current
  void dispatcher.handle({ handoff_id: "h-current", conversation_id: "c1", to_agent: "a1" });
  await waitForStarted(probe);

  // Replayed cancel targets stale handoff h-stale in the same conversation
  dispatcher.cancel("c1", "h-stale");

  // Give the abort a tick to (incorrectly) fire if the bug is present
  await new Promise((r) => setTimeout(r, 20));

  expectAborted(probe.signal, false);

  // Cleanup: now actually cancel the current handoff
  dispatcher.cancel("c1", "h-current");
  await dispatcher.idle();
  expectAborted(probe.signal, true);
});

test("dispatcher.cancel(cid, hid) for stale hid does NOT pre-abort a fresh handoff in same conv", async () => {
  // Same bug, but cancel arrives BEFORE the fresh dispatch starts (e.g.
  // via durable replay just as a new handoff is being claimed).
  const probe: DispatchProbe = { signal: null, started: false };

  const deps = makeDeps({
    dispatch: makeAbortableDispatch((signal) => {
      probe.signal = signal;
      probe.started = true;
    }),
  });

  const dispatcher = createWorkerDispatcher(deps);

  // Stale cancel arrives first, targeting a handoff that won't be the
  // one we dispatch.
  dispatcher.cancel("c1", "h-stale");

  // Now dispatch a fresh handoff in the same conv.
  void dispatcher.handle({ handoff_id: "h-fresh", conversation_id: "c1", to_agent: "a1" });

  // Let it run briefly.
  await new Promise((r) => setTimeout(r, 20));
  expectAborted(probe.signal, false);

  // Cleanup.
  dispatcher.cancel("c1", "h-fresh");
  await dispatcher.idle();
  expectAborted(probe.signal, true);
});

test("dispatcher.cancel(cid) before handle() starts dispatch should still abort", async () => {
  const probe: DispatchProbe = { signal: null, started: false };

  const deps = makeDeps({
    dispatch: makeAbortableDispatch((signal) => {
      probe.signal = signal;
      probe.started = true;
    }),
  });

  const dispatcher = createWorkerDispatcher(deps);
  const handoff: TestHandoff = { handoff_id: "h1", conversation_id: "c1", to_agent: "a1" };

  // Trigger cancel BEFORE handle
  dispatcher.cancel("c1");

  // Now handle
  void dispatcher.handle(handoff);

  await dispatcher.idle();

  expect(deps.dispatch).toHaveBeenCalled();
  expectAborted(probe.signal, true);
});

import type { DispatchEventInput, Logger } from "@penumbra/core";

import { expect, mock, test } from "bun:test";

import {
  type ControlListenerClient,
  type ControlListenerDispatcher,
  type ControlListenerLogger,
  handleControlEvent,
  runWorkerControlListener,
  type WorkerControlEvent,
} from "@src/worker/control-listener.js";
import {
  createWorkerDispatcher,
  type DispatcherHandoff,
  type WorkerDispatcherDeps,
} from "@src/worker/dispatcher.js";

// Async generator factory satisfies the ControlListenerClient contract:
// when called with an empty events array it yields nothing but still
// references `yield`/`await` syntactically so eslint's require-yield /
// require-await rules are satisfied without a disable comment.
async function* yieldControlEvents(
  events: WorkerControlEvent[],
): AsyncGenerator<WorkerControlEvent, void, undefined> {
  for (const ev of events) {
    await Promise.resolve();
    yield ev;
  }
}

const emptyControlStream = (): AsyncIterable<WorkerControlEvent> => yieldControlEvents([]);

interface LogEntry {
  obj: Record<string, unknown>;
  msg: string;
}

interface CancelCall {
  conversation_id: string;
  handoff_id: string;
}

function makeLogger(sink: { warns: LogEntry[] }): ControlListenerLogger {
  return {
    warn: (obj: Record<string, unknown>, msg: string): void => {
      sink.warns.push({ obj, msg });
    },
    error: (): void => undefined,
    info: (): void => undefined,
  };
}

test("handleControlEvent emits cancel.received before dispatching cancel", () => {
  const events: DispatchEventInput[] = [];
  const cancels: CancelCall[] = [];

  const client: ControlListenerClient = {
    sendProbeAck: () => Promise.resolve(),
    subscribeWorkerControl: emptyControlStream,
  };
  const dispatcher: ControlListenerDispatcher = {
    cancel: (conversation_id, handoff_id) => cancels.push({ conversation_id, handoff_id }),
  };

  handleControlEvent(
    { type: "cancel", conversation_id: "c1", handoff_id: "h1" },
    {
      client,
      dispatcher,
      workerId: "w1",
      onEvent: (event) => events.push(event),
    },
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    handoff_id: "h1",
    worker_id: "w1",
    source: "worker",
    kind: "cancel.received",
    meta: { source: "sse" },
  });
  expect(cancels).toEqual([{ conversation_id: "c1", handoff_id: "h1" }]);
});

test("handleControlEvent sends ping ACK only for matching worker", () => {
  const acks: [string, string][] = [];

  const client: ControlListenerClient = {
    sendProbeAck: (worker_id, probe_id) => {
      acks.push([worker_id, probe_id]);
      return Promise.resolve();
    },
    subscribeWorkerControl: emptyControlStream,
  };
  const dispatcher: ControlListenerDispatcher = { cancel: () => undefined };

  handleControlEvent(
    { type: "ping", worker_id: "w1", probe_id: "p1" },
    {
      client,
      dispatcher,
      workerId: "w1",
    },
  );

  expect(acks).toEqual([["w1", "p1"]]);
});

test("handleControlEvent logs probe-ack failures without throwing", async () => {
  const sink = { warns: [] as LogEntry[] };

  const client: ControlListenerClient = {
    sendProbeAck: () => {
      return Promise.reject(new Error("probe ack failed"));
    },
    subscribeWorkerControl: emptyControlStream,
  };
  const dispatcher: ControlListenerDispatcher = { cancel: () => undefined };

  expect(() => {
    handleControlEvent(
      { type: "ping", worker_id: "w1", probe_id: "p1" },
      {
        client,
        dispatcher,
        workerId: "w1",
        log: makeLogger(sink),
      },
    );
  }).not.toThrow();

  await Promise.resolve();

  expect(sink.warns).toEqual([
    {
      obj: {
        worker_id: "w1",
        probe_id: "p1",
        err: "Error: probe ack failed",
      },
      msg: "probe-ack failed",
    },
  ]);
});

test("handleControlEvent logs malformed cancel event and does not call cancel", () => {
  const cancels: CancelCall[] = [];
  const sink = { warns: [] as LogEntry[] };

  const client: ControlListenerClient = {
    sendProbeAck: () => Promise.resolve(),
    subscribeWorkerControl: emptyControlStream,
  };
  const dispatcher: ControlListenerDispatcher = {
    cancel: (conversation_id, handoff_id) => cancels.push({ conversation_id, handoff_id }),
  };

  handleControlEvent(
    { type: "cancel", conversation_id: "c1" },
    {
      client,
      dispatcher,
      workerId: "w1",
      onEvent: () => undefined,
      log: makeLogger(sink),
    },
  );

  expect(cancels).toHaveLength(0);
  expect(sink.warns).toHaveLength(1);
  expect(sink.warns[0]).toEqual({
    obj: {
      event: "control_event_malformed",
      type: "cancel",
      payload: { type: "cancel", conversation_id: "c1" },
    },
    msg: "malformed cancel control event",
  });
});

test("handleControlEvent ignores ping not addressed to this worker", () => {
  const acks: [string, string][] = [];

  const client: ControlListenerClient = {
    sendProbeAck: (worker_id, probe_id) => {
      acks.push([worker_id, probe_id]);
      return Promise.resolve();
    },
    subscribeWorkerControl: emptyControlStream,
  };
  const dispatcher: ControlListenerDispatcher = { cancel: () => undefined };

  handleControlEvent(
    { type: "ping", worker_id: "w2", probe_id: "p1" },
    {
      client,
      dispatcher,
      workerId: "w1",
    },
  );

  expect(acks).toHaveLength(0);
});

test("reconnects when control stream ends cleanly", async () => {
  const cancels: CancelCall[] = [];
  const abort = new AbortController();
  let subscribeCalls = 0;

  async function* subscribeWorkerControl(): AsyncGenerator<WorkerControlEvent, void, undefined> {
    subscribeCalls++;
    if (subscribeCalls === 2) {
      yield { type: "cancel", conversation_id: "c1", handoff_id: "h1" };
      abort.abort();
    }
    await Promise.resolve();
  }

  const client: ControlListenerClient = {
    sendProbeAck: () => Promise.resolve(),
    subscribeWorkerControl,
  };

  await runWorkerControlListener({
    client,
    dispatcher: {
      cancel: (conversation_id, handoff_id) => cancels.push({ conversation_id, handoff_id }),
    },
    signal: abort.signal,
    log: { warn: () => undefined, error: () => undefined, info: () => undefined },
    sleep: () => Promise.resolve(),
  });

  expect(subscribeCalls).toBe(2);
  expect(cancels).toEqual([{ conversation_id: "c1", handoff_id: "h1" }]);
});

test("throttles control-listener reconnect log to once per window and reports suppressedCount", async () => {
  const sink = { warns: [] as LogEntry[] };

  let subscribeCalls = 0;
  // Async generator that throws on entry. References `yield`/`await`
  // syntactically (in unreachable but valid code paths) so eslint's
  // require-yield / require-await pass without a disable comment.
  async function* subscribeWorkerControl(): AsyncGenerator<WorkerControlEvent, void, undefined> {
    subscribeCalls++;
    if (subscribeCalls > 0) {
      throw new Error(`boom-${String(subscribeCalls)}`);
    }
    await Promise.resolve();
    yield { type: "noop" };
  }

  const client: ControlListenerClient = {
    sendProbeAck: () => Promise.resolve(),
    subscribeWorkerControl,
  };

  const dispatcher: ControlListenerDispatcher = { cancel: () => undefined };
  const abort = new AbortController();

  let nowMs = 0;
  let warnsAfterFive = 0;
  const sleep = (): Promise<void> => {
    if (subscribeCalls === 5) {
      warnsAfterFive = sink.warns.length;
      nowMs = 60_001; // advance past 60s window for the next error
    }
    if (subscribeCalls >= 6) abort.abort();
    return Promise.resolve();
  };

  await runWorkerControlListener({
    client,
    dispatcher,
    signal: abort.signal,
    log: makeLogger(sink),
    sleep,
    now: () => nowMs,
    streamErrorLogThrottleMs: 60_000,
  });

  expect(warnsAfterFive).toBe(1);
  expect(sink.warns.length).toBe(2);
  expect(sink.warns[0]?.msg).toBe("control listener stream error; reconnecting in 5s");
  expect(sink.warns[1]?.obj.suppressedCount).toBe(4);
});

test("handleControlEvent triggers onConfigReload on agentchat_reload", () => {
  let reloads = 0;
  const sink = { warns: [] as LogEntry[] };

  const client: ControlListenerClient = {
    sendProbeAck: () => Promise.resolve(),
    subscribeWorkerControl: emptyControlStream,
  };
  const dispatcher: ControlListenerDispatcher = { cancel: () => undefined };

  handleControlEvent(
    { type: "agentchat_reload" },
    {
      client,
      dispatcher,
      workerId: "w1",
      onConfigReload: () => {
        reloads++;
      },
      log: makeLogger(sink),
    },
  );

  expect(reloads).toBe(1);
  expect(sink.warns).toHaveLength(0);
});

const baseHandoff = (id: string, conv: string): DispatcherHandoff => ({
  handoff_id: id,
  conversation_id: conv,
  project_id: null,
  to_agent: "executor",
  message: "m",
});

function makeDeps(over: Partial<WorkerDispatcherDeps> = {}): WorkerDispatcherDeps {
  return {
    claim: mock().mockResolvedValue({ status: "dispatched" }),
    dispatch: mock().mockResolvedValue({
      next: null,
      terminatedReason: "no_mention" as const,
      text: "",
      agent: "executor",
    }),
    postProgress: mock().mockResolvedValue(undefined),
    complete: mock().mockResolvedValue(undefined),
    markFailed: mock().mockResolvedValue(undefined),
    log: { info: mock(), warn: mock(), debug: mock(), error: mock() } as unknown as Logger,
    concurrency: 1,
    ...over,
  };
}

test("a daemon cancel control event aborts the matching in-flight dispatch (#218)", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => {
    resolveStarted = r;
  });
  let outcome = "";

  const dispatchFn = mock().mockImplementation(
    async (_handoff: DispatcherHandoff, _onChunk: (d: string) => void, signal: AbortSignal) => {
      resolveStarted();
      outcome = await Promise.race([
        new Promise<string>((r) => {
          signal.addEventListener(
            "abort",
            () => {
              r("aborted");
            },
            { once: true },
          );
        }),
        new Promise<string>((r) => {
          setTimeout(() => {
            r("timeout");
          }, 1000);
        }),
      ]);
      return {
        next: null,
        terminatedReason: "no_mention" as const,
        text: "",
        agent: "executor",
      };
    },
  );

  const markFailed = mock().mockResolvedValue(undefined);
  const complete = mock().mockResolvedValue(undefined);
  const dispatcher = createWorkerDispatcher(
    makeDeps({ dispatch: dispatchFn, markFailed, complete }),
  );

  void dispatcher.handle(baseHandoff("h-swept", "c-swept"));
  await started;

  const client: ControlListenerClient = {
    sendProbeAck: () => Promise.resolve(),
    subscribeWorkerControl: emptyControlStream,
  };

  handleControlEvent(
    { type: "cancel", conversation_id: "c-swept", handoff_id: "h-swept" },
    { client, dispatcher, workerId: "w1" },
  );

  await dispatcher.idle();

  expect(outcome).toBe("aborted");
  expect(markFailed).toHaveBeenCalledTimes(1);
  expect(markFailed.mock.calls[0]).toEqual(["h-swept", "cancelled"]);
  expect(complete).not.toHaveBeenCalled();
});

test("a cancel for another handoff in the same conversation does not abort", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => {
    resolveStarted = r;
  });
  const signalRef: { signal: AbortSignal | null } = { signal: null };

  const dispatchFn = mock().mockImplementation(
    async (_handoff: DispatcherHandoff, _onChunk: (d: string) => void, signal: AbortSignal) => {
      signalRef.signal = signal;
      resolveStarted();
      await Promise.race([
        new Promise<string>((r) => {
          signal.addEventListener(
            "abort",
            () => {
              r("aborted");
            },
            { once: true },
          );
        }),
        new Promise<string>((r) => {
          setTimeout(() => {
            r("timeout");
          }, 1000);
        }),
      ]);
      return {
        next: null,
        terminatedReason: "no_mention" as const,
        text: "",
        agent: "executor",
      };
    },
  );

  const markFailed = mock().mockResolvedValue(undefined);
  const dispatcher = createWorkerDispatcher(makeDeps({ dispatch: dispatchFn, markFailed }));

  void dispatcher.handle(baseHandoff("h-swept", "c-swept"));
  await started;

  const client: ControlListenerClient = {
    sendProbeAck: () => Promise.resolve(),
    subscribeWorkerControl: emptyControlStream,
  };

  handleControlEvent(
    { type: "cancel", conversation_id: "c-swept", handoff_id: "h-older" },
    { client, dispatcher, workerId: "w1" },
  );

  expect(signalRef.signal?.aborted).toBe(false);

  handleControlEvent(
    { type: "cancel", conversation_id: "c-swept", handoff_id: "h-swept" },
    { client, dispatcher, workerId: "w1" },
  );

  await dispatcher.idle();
});

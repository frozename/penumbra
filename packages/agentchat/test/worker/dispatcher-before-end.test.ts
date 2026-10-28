import type { DispatchEventInput, Logger } from "@penumbra/core";

import { expect, mock, test } from "bun:test";

import type { DispatchHandoffResult } from "@src/cli/dispatch-handoff.js";
import {
  createWorkerDispatcher,
  type DispatcherHandoff,
  type WorkerDispatcherDeps,
} from "@src/worker/dispatcher.js";
import type { TerminalReport, TerminalReportStatus } from "@src/worker/terminal-outbox.js";
import { ThoughtCapture } from "@src/worker/thought-capture.js";
import type { RuntimeThoughtsConfig } from "@src/worker/thought-config.js";

const HOOK_WARNING = "beforeDispatchEnd hook threw; emitting dispatch.end anyway";

const okResult: DispatchHandoffResult = {
  next: null,
  terminatedReason: "no_mention",
  text: "result",
  agent: "executor",
};

function asLogger(stub: { info: unknown; warn: unknown; debug: unknown }): Logger {
  return stub as unknown as Logger;
}

function handoff(id: string): DispatcherHandoff {
  return { handoff_id: id, conversation_id: `conv-${id}`, to_agent: "executor", message: "m" };
}

// One ordered log for every observable step: onEvent pushes "event:<kind>",
// the default hook pushes "before:<handoff id>".
function harness(
  over: (order: string[]) => Partial<WorkerDispatcherDeps> = () => ({}),
  order: string[] = [],
): { d: WorkerDispatcherDeps; order: string[]; warns: unknown[][] } {
  const warns: unknown[][] = [];
  const d: WorkerDispatcherDeps = {
    claim: mock().mockResolvedValue({ status: "dispatched" }),
    dispatch: mock().mockResolvedValue(okResult),
    postProgress: mock().mockResolvedValue(undefined),
    complete: mock().mockResolvedValue(undefined),
    markFailed: mock().mockResolvedValue(undefined),
    log: asLogger({
      info: mock(),
      warn: mock((...args: unknown[]) => {
        warns.push(args);
      }),
      debug: mock(),
    }),
    concurrency: 1,
    onEvent: (event: DispatchEventInput): void => {
      order.push(`event:${event.kind}`);
    },
    beforeDispatchEnd: (handoffId: string): void => {
      order.push(`before:${handoffId}`);
    },
    ...over(order),
  };
  return { d, order, warns };
}

async function runOne(d: WorkerDispatcherDeps, id: string): Promise<void> {
  const dispatcher = createWorkerDispatcher(d);
  await dispatcher.handle(handoff(id));
  await dispatcher.idle();
}

function beforeEntries(order: string[]): string[] {
  return order.filter((entry) => entry.startsWith("before:"));
}

function thoughtsConfig(): RuntimeThoughtsConfig {
  return {
    enabled: true,
    capture: {
      maxTextBytes: 16384,
      maxStreamBytes: 1_048_576,
      adapters: { "stdio-acp": true },
      perAgentOverrides: {},
    },
    analyze: {
      enabled: false,
      onlyWhen: [],
      digest: { enabled: false, pool: "local-gemma26", maxInputChars: 50000, timeoutMs: 60000 },
      signals: {
        enabled: false,
        pool: "local-gemma26",
        timeoutMs: 60000,
        maxInputChars: null,
        definitions: [],
      },
    },
  };
}

test("calls beforeDispatchEnd once, right before dispatch.end, on a completed dispatch", async () => {
  const { d, order } = harness();
  await runOne(d, "h-ok");
  expect(beforeEntries(order)).toEqual(["before:h-ok"]);
  const endAt = order.indexOf("event:dispatch.end");
  expect(endAt).toBeGreaterThan(0);
  expect(order[endAt - 1]).toBe("before:h-ok");
  expect(d.complete).toHaveBeenCalledTimes(1);
});

test("calls beforeDispatchEnd right before dispatch.end when the dispatch throws", async () => {
  const { d, order } = harness(() => ({
    dispatch: mock().mockRejectedValue(new Error("adapter exploded")),
  }));
  await runOne(d, "h-throw");
  expect(beforeEntries(order)).toEqual(["before:h-throw"]);
  const endAt = order.indexOf("event:dispatch.end");
  expect(endAt).toBeGreaterThan(0);
  expect(order[endAt - 1]).toBe("before:h-throw");
  expect(d.markFailed).toHaveBeenCalledTimes(1);
});

test("calls beforeDispatchEnd right before dispatch.end on a dispatch.start barrier failure", async () => {
  const { d, order } = harness(() => ({
    dispatchStartBarrier: (): Promise<void> => Promise.reject(new Error("barrier down")),
  }));
  await runOne(d, "h-barrier");
  expect(d.dispatch).not.toHaveBeenCalled();
  expect(beforeEntries(order)).toEqual(["before:h-barrier"]);
  const endAt = order.indexOf("event:dispatch.end");
  expect(endAt).toBeGreaterThanOrEqual(0);
  expect(order[endAt - 1]).toBe("before:h-barrier");
  expect(d.markFailed).toHaveBeenCalledTimes(1);
});

test("calls beforeDispatchEnd right before the terminal report when reportTerminal is wired", async () => {
  const { d, order } = harness((log) => ({
    reportTerminal: (report: TerminalReport): Promise<TerminalReportStatus> => {
      log.push(`report:${report.dispatch_end.kind}`);
      return Promise.resolve("delivered");
    },
  }));
  await runOne(d, "h-report");
  expect(beforeEntries(order)).toEqual(["before:h-report"]);
  const reportAt = order.indexOf("report:dispatch.end");
  expect(reportAt).toBeGreaterThan(0);
  expect(order[reportAt - 1]).toBe("before:h-report");
  expect(order).not.toContain("event:dispatch.end");
});

test("a throwing beforeDispatchEnd is logged and dispatch.end is still emitted", async () => {
  const { d, order, warns } = harness(() => ({
    beforeDispatchEnd: (): void => {
      throw new Error("hook exploded");
    },
  }));
  await runOne(d, "h-hook-throws");
  expect(order).toContain("event:dispatch.end");
  expect(d.complete).toHaveBeenCalledTimes(1);
  expect(warns.some((args) => args[1] === HOOK_WARNING)).toBe(true);
});

test("a throwing beforeDispatchEnd does not stop the barrier-failure dispatch.end or markFailed", async () => {
  const { d, order, warns } = harness(() => ({
    dispatchStartBarrier: (): Promise<void> => Promise.reject(new Error("barrier down")),
    beforeDispatchEnd: (): void => {
      throw new Error("hook exploded");
    },
  }));
  await runOne(d, "h-barrier-throws");
  expect(order).toContain("event:dispatch.end");
  expect(d.markFailed).toHaveBeenCalledTimes(1);
  expect(warns.some((args) => args[1] === HOOK_WARNING)).toBe(true);
});

test("worker-style wiring writes the buffered thought tail before dispatch.end and frees its state", async () => {
  const order: string[] = [];
  const capture = new ThoughtCapture({
    config: thoughtsConfig(),
    enqueue: (event: DispatchEventInput): void => {
      const text = event.meta?.text;
      order.push(`thought:${typeof text === "string" ? text : ""}`);
    },
  });
  const { d } = harness(
    () => ({
      dispatch: (): Promise<DispatchHandoffResult> => {
        // Under 80 chars and no sentence end: stays buffered until a flush.
        capture.appendThoughtChunk({
          handoffId: "h-capture",
          adapter: "stdio-acp",
          agentName: "executor",
          text: "Half a thought",
        });
        return Promise.resolve(okResult);
      },
      beforeDispatchEnd: (handoffId: string): void => {
        capture.flush(handoffId);
        capture.resetDispatch(handoffId);
      },
    }),
    order,
  );
  await runOne(d, "h-capture");
  expect(order.filter((entry) => entry.startsWith("thought:"))).toEqual(["thought:Half a thought"]);
  const endAt = order.indexOf("event:dispatch.end");
  expect(endAt).toBeGreaterThan(0);
  expect(order[endAt - 1]).toBe("thought:Half a thought");
  expect(capture._perDispatchSize()).toBe(0);
});

test("without a beforeDispatchEnd dep, dispatch.end is emitted as before", async () => {
  const { d, order } = harness(() => ({ beforeDispatchEnd: undefined }));
  await runOne(d, "h-no-hook");
  expect(beforeEntries(order)).toEqual([]);
  expect(order).toContain("event:dispatch.end");
  expect(d.complete).toHaveBeenCalledTimes(1);
});

import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

import { createWorkerShutdown, type WorkerShutdownDeps } from "@src/worker/shutdown.js";

const noop = (): void => {
  /* test mock placeholder */
};
const noopAsync = (): Promise<void> => Promise.resolve();

describe("createWorkerShutdown", () => {
  test("runs shutdown path, stops heartbeat loop, and exits without throwing", async () => {
    const calls: string[] = [];
    const shutdown = createWorkerShutdown({
      log: {
        info(meta, msg): void {
          calls.push(`log:${msg}:${String(meta.sig)}`);
        },
      },
      controlAbort: {
        abort: mock((): void => {
          calls.push("controlAbort");
        }),
      },
      heartbeatLoop: {
        stop: mock((): void => {
          calls.push("heartbeatLoop.stop");
        }),
      },
      prewarmAbort: {
        abort: mock((): void => {
          calls.push("prewarmAbort");
        }),
      },
      prewarmLoop: {
        stop: mock((): void => {
          calls.push("prewarmLoop.stop");
        }),
      },
      usagePoller: {
        stop: mock((): void => {
          calls.push("usagePoller.stop");
        }),
      },
      notificationScheduler: {
        stop: mock((): void => {
          calls.push("notificationScheduler.stop");
        }),
      },
      shutdownAllAcpWarmPools: mock((): void => {
        calls.push("shutdownAllAcpWarmPools");
      }),
      eventSource: {
        stop: mock((): Promise<void> => {
          calls.push("eventSource.stop");
          return Promise.resolve();
        }),
      },
      permissionDaemonClient: {
        stop: mock((): void => {
          calls.push("permissionDaemonClient.stop");
        }),
      },
      terminalOutbox: {
        stop: mock((): void => {
          calls.push("terminalOutbox.stop");
        }),
      },
      dispatcher: {
        stop: mock((): void => {
          calls.push("dispatcher.stop");
        }),
        idle: mock((): Promise<void> => {
          calls.push("dispatcher.idle");
          return Promise.resolve();
        }),
      },
      eventQueue: {
        stop: mock((): Promise<void> => {
          calls.push("eventQueue.stop");
          return Promise.resolve();
        }),
      },
      exit: mock((code: number): void => {
        calls.push(`exit:${String(code)}`);
      }),
    });

    await shutdown("SIGTERM");

    expect(calls).toEqual([
      "log:shutting down:SIGTERM",
      "controlAbort",
      "prewarmAbort",
      "prewarmLoop.stop",
      "usagePoller.stop",
      "notificationScheduler.stop",
      "shutdownAllAcpWarmPools",
      "eventSource.stop",
      "permissionDaemonClient.stop",
      "terminalOutbox.stop",
      "dispatcher.stop",
      "dispatcher.idle",
      "heartbeatLoop.stop",
      "eventQueue.stop",
      "exit:0",
    ]);
  });

  test("stops the current prewarm loop from a dynamic getter", async () => {
    const calls: string[] = [];
    const staleLoop = {
      stop: mock((): void => {
        calls.push("stale.stop");
      }),
    };
    const currentLoop = {
      stop: mock((): void => {
        calls.push("current.stop");
      }),
    };
    const deps: WorkerShutdownDeps = {
      log: { info: mock(noop) },
      controlAbort: { abort: mock(noop) },
      heartbeatLoop: { stop: mock(noop) },
      prewarmAbort: { abort: mock(noop) },
      prewarmLoop: staleLoop,
      getPrewarmLoop: () => currentLoop,
      shutdownAllAcpWarmPools: mock(noop),
      eventSource: { stop: mock(noopAsync) },
      permissionDaemonClient: { stop: mock(noop) },
      dispatcher: { stop: mock(noop), idle: mock(noopAsync) },
      eventQueue: { stop: mock(noopAsync) },
      exit: mock(noop),
    };
    const shutdown = createWorkerShutdown(deps);

    await shutdown("SIGTERM");

    expect(calls).toEqual(["current.stop"]);
  });

  test("forces exit(1) when shutdown exceeds the hard timeout", async () => {
    const calls: string[] = [];
    const deps: WorkerShutdownDeps = {
      log: {
        info: mock(noop),
        error: mock((meta: Record<string, unknown>, msg: string): void => {
          calls.push(`error:${msg}:${String(meta.sig)}`);
        }),
      },
      controlAbort: { abort: mock(noop) },
      heartbeatLoop: {
        stop: mock((): void => {
          calls.push("heartbeatLoop.stop");
        }),
      },
      prewarmAbort: { abort: mock(noop) },
      shutdownAllAcpWarmPools: mock(noop),
      eventSource: { stop: mock(noopAsync) },
      permissionDaemonClient: { stop: mock(noop) },
      dispatcher: {
        stop: mock(noop),
        idle: mock(
          () =>
            new Promise<void>(() => {
              /* never resolves to trigger timeout */
            }),
        ),
      },
      eventQueue: { stop: mock(noopAsync) },
      exit: mock((code: number): void => {
        calls.push(`exit:${String(code)}`);
      }),
      shutdownTimeoutMs: 5,
    };
    const shutdown = createWorkerShutdown(deps);

    await shutdown("SIGTERM");

    expect(calls).toEqual(["error:worker shutdown timed out:SIGTERM", "exit:1"]);
  });

  test("worker signal handlers catch shutdown rejections before exiting", () => {
    const source = readFileSync("packages/agentchat/bin/agentchat-worker.ts", "utf8");

    expect(source).not.toContain('process.on("SIGINT", () => void shutdown("SIGINT"))');
    expect(source).not.toContain('process.on("SIGTERM", () => void shutdown("SIGTERM"))');
    expect(source).toContain('shutdown("SIGINT").catch');
    expect(source).toContain('shutdown("SIGTERM").catch');
    expect(source).toContain("process.exit(1)");
  });
});

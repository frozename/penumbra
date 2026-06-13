import { describe, expect, test, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { createWorkerShutdown } from "../../src/worker/shutdown.js";

describe("createWorkerShutdown", () => {
  test("runs shutdown path, stops heartbeat loop, and exits without throwing", async () => {
    const calls: string[] = [];
    const shutdown = createWorkerShutdown({
      log: {
        info(meta, msg) {
          calls.push(`log:${msg}:${meta.sig}`);
        },
      },
      controlAbort: {
        abort: mock(() => calls.push("controlAbort")),
      },
      heartbeatLoop: {
        stop: mock(() => calls.push("heartbeatLoop.stop")),
      },
      prewarmAbort: {
        abort: mock(() => calls.push("prewarmAbort")),
      },
      prewarmLoop: {
        stop: mock(() => calls.push("prewarmLoop.stop")),
      },
      usagePoller: {
        stop: mock(() => calls.push("usagePoller.stop")),
      },
      notificationScheduler: {
        stop: mock(() => calls.push("notificationScheduler.stop")),
      },
      shutdownAllAcpWarmPools: mock(() => calls.push("shutdownAllAcpWarmPools")),
      eventSource: {
        stop: mock(async () => {
          calls.push("eventSource.stop");
        }),
      },
      permissionDaemonClient: {
        stop: mock(() => calls.push("permissionDaemonClient.stop")),
      },
      dispatcher: {
        stop: mock(() => calls.push("dispatcher.stop")),
        idle: mock(async () => {
          calls.push("dispatcher.idle");
        }),
      },
      eventQueue: {
        stop: mock(async () => {
          calls.push("eventQueue.stop");
        }),
      },
      exit: mock((code) => calls.push(`exit:${code}`)),
    });

    await expect(shutdown("SIGTERM")).resolves.toBeUndefined();

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
      "dispatcher.stop",
      "dispatcher.idle",
      "heartbeatLoop.stop",
      "eventQueue.stop",
      "exit:0",
    ]);
  });

  test("stops the current prewarm loop from a dynamic getter", async () => {
    const calls: string[] = [];
    const staleLoop = { stop: mock(() => calls.push("stale.stop")) };
    const currentLoop = { stop: mock(() => calls.push("current.stop")) };
    const shutdown = createWorkerShutdown({
      log: { info: mock(() => {}) },
      controlAbort: { abort: mock(() => {}) },
      heartbeatLoop: { stop: mock(() => {}) },
      prewarmAbort: { abort: mock(() => {}) },
      prewarmLoop: staleLoop,
      getPrewarmLoop: () => currentLoop,
      shutdownAllAcpWarmPools: mock(() => {}),
      eventSource: { stop: mock(async () => {}) },
      permissionDaemonClient: { stop: mock(() => {}) },
      dispatcher: { stop: mock(() => {}), idle: mock(async () => {}) },
      eventQueue: { stop: mock(async () => {}) },
      exit: mock(() => {}),
    });

    await shutdown("SIGTERM");

    expect(calls).toEqual(["current.stop"]);
  });

  test("forces exit(1) when shutdown exceeds the hard timeout", async () => {
    const calls: string[] = [];
    const shutdown = createWorkerShutdown({
      log: {
        info: mock(() => {}),
        error: mock((meta, msg) => calls.push(`error:${msg}:${meta.sig}`)),
      },
      controlAbort: { abort: mock(() => {}) },
      heartbeatLoop: { stop: mock(() => calls.push("heartbeatLoop.stop")) },
      prewarmAbort: { abort: mock(() => {}) },
      shutdownAllAcpWarmPools: mock(() => {}),
      eventSource: { stop: mock(async () => {}) },
      permissionDaemonClient: { stop: mock(() => {}) },
      dispatcher: {
        stop: mock(() => {}),
        idle: mock(() => new Promise<void>(() => {})),
      },
      eventQueue: { stop: mock(async () => {}) },
      exit: mock((code) => calls.push(`exit:${code}`)),
      shutdownTimeoutMs: 5,
    });

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

import { describe, expect, test } from "bun:test";
import { PenumbraHttpError } from "../../src/penumbra-client.js";
import { MAX_HEARTBEAT_ATTEMPTS } from "../../src/worker/heartbeat-retry.js";
import { startHeartbeatLoop } from "../../src/worker/heartbeat-loop.js";

type ScheduledTask = {
  delayMs: number;
  run: () => Promise<void> | void;
};

function createManualScheduler() {
  const tasks: ScheduledTask[] = [];
  return {
    tasks,
    schedule(run: () => Promise<void> | void, delayMs: number) {
      tasks.push({ delayMs, run });
      return { cancel: () => {} };
    },
  };
}

async function runNextScheduled(tasks: ScheduledTask[]): Promise<void> {
  const next = tasks.shift();
  if (!next) throw new Error("expected a scheduled heartbeat task");
  await next.run();
  await Promise.resolve();
}

describe("startHeartbeatLoop", () => {
  test("exhaustion exits after MAX_HEARTBEAT_ATTEMPTS retryable failures and stops scheduling", async () => {
    const scheduler = createManualScheduler();
    let emitCount = 0;
    const exitCalls: number[] = [];
    const loop = startHeartbeatLoop({
      emitHeartbeat: async () => {
        emitCount++;
        throw new Error(`retryable-${emitCount}`);
      },
      reRegisterWorker: async () => {
        throw new Error("unexpected re-register");
      },
      exit: (code) => {
        exitCalls.push(code);
      },
      schedule: scheduler.schedule,
      timeoutMs: 1,
      log: { debug() {}, error() {}, info() {}, warn() {} },
      workerId: "W-A",
    });

    expect(scheduler.tasks).toHaveLength(1);
    expect(scheduler.tasks[0].delayMs).toBe(0);

    for (let i = 0; i < MAX_HEARTBEAT_ATTEMPTS; i++) {
      await runNextScheduled(scheduler.tasks);
    }

    expect(emitCount).toBe(MAX_HEARTBEAT_ATTEMPTS);
    expect(exitCalls).toEqual([1]);
    expect(scheduler.tasks).toHaveLength(0);

    loop.stop();
  });

  test("terminal 4xx re-registers once, resets backoff on success, and exits when re-register fails", async () => {
    const scheduler = createManualScheduler();
    const emitPlan: Array<"terminal" | "retryable" | "ok"> = ["terminal", "retryable", "ok"];
    const emitDelays: number[] = [];
    const reRegisterCalls: number[] = [];
    const exitCalls: number[] = [];
    const loop = startHeartbeatLoop({
      emitHeartbeat: async () => {
        const step = emitPlan.shift();
        if (step === "terminal") throw new PenumbraHttpError("HTTP 403", 403);
        if (step === "retryable") throw new Error("retryable-after-reregister");
      },
      reRegisterWorker: async () => {
        reRegisterCalls.push(reRegisterCalls.length + 1);
      },
      exit: (code) => {
        exitCalls.push(code);
      },
      schedule: (run, delayMs) => {
        emitDelays.push(delayMs);
        return scheduler.schedule(run, delayMs);
      },
      timeoutMs: 1,
      log: { debug() {}, error() {}, info() {}, warn() {} },
      workerId: "W-A",
    });

    expect(scheduler.tasks).toHaveLength(1);

    await runNextScheduled(scheduler.tasks);
    expect(reRegisterCalls).toEqual([1]);
    expect(exitCalls).toEqual([]);
    expect(emitDelays[0]).toBe(0);

    await runNextScheduled(scheduler.tasks);
    expect(emitDelays[1]).toBe(15_000);

    await runNextScheduled(scheduler.tasks);
    expect(emitDelays[2]).toBe(1_000);

    await runNextScheduled(scheduler.tasks);
    expect(emitDelays[3]).toBe(15_000);
    expect(exitCalls).toEqual([]);
    expect(scheduler.tasks).toHaveLength(1);
    expect(scheduler.tasks[0].delayMs).toBe(15_000);

    loop.stop();
  });

  test("terminal 4xx exits when re-register fails", async () => {
    const scheduler = createManualScheduler();
    const exitCalls: number[] = [];
    const loop = startHeartbeatLoop({
      emitHeartbeat: async () => {
        throw new PenumbraHttpError("HTTP 409", 409);
      },
      reRegisterWorker: async () => {
        throw new Error("re-register failed");
      },
      exit: (code) => {
        exitCalls.push(code);
      },
      schedule: scheduler.schedule,
      timeoutMs: 1,
      log: { debug() {}, error() {}, info() {}, warn() {} },
      workerId: "W-A",
    });

    await runNextScheduled(scheduler.tasks);

    expect(exitCalls).toEqual([1]);
    expect(scheduler.tasks).toHaveLength(0);

    loop.stop();
  });
});

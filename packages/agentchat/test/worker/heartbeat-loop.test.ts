import { describe, expect, test } from "bun:test";

import { PenumbraHttpError } from "../../src/penumbra-client.js";
import { startHeartbeatLoop } from "../../src/worker/heartbeat-loop.js";
import { MAX_HEARTBEAT_ATTEMPTS } from "../../src/worker/heartbeat-retry.js";

interface ScheduledTask {
  delayMs: number;
  run: () => Promise<void> | void;
}

interface ManualScheduler {
  tasks: ScheduledTask[];
  schedule: (run: () => Promise<void> | void, delayMs: number) => { cancel: () => void };
}

const noop = (): void => {
  // intentionally empty: silent logger/cancel for heartbeat tests
};

const silentLog = { debug: noop, error: noop, info: noop, warn: noop };

function createManualScheduler(): ManualScheduler {
  const tasks: ScheduledTask[] = [];
  return {
    tasks,
    schedule(run, delayMs): { cancel: () => void } {
      tasks.push({ delayMs, run });
      return { cancel: noop };
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
      emitHeartbeat: (): Promise<void> => {
        emitCount++;
        return Promise.reject(new Error(`retryable-${String(emitCount)}`));
      },
      reregisterWorker: (): Promise<void> => Promise.reject(new Error("unexpected re-register")),
      exit: (code) => {
        exitCalls.push(code);
      },
      schedule: scheduler.schedule,
      timeoutMs: 1,
      log: silentLog,
      workerId: "W-A",
    });

    expect(scheduler.tasks).toHaveLength(1);
    expect(scheduler.tasks.at(0)?.delayMs).toBe(0);

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
    const emitPlan: ("terminal" | "retryable" | "ok")[] = ["terminal", "retryable", "ok"];
    const emitDelays: number[] = [];
    const reregisterCalls: number[] = [];
    const exitCalls: number[] = [];
    const loop = startHeartbeatLoop({
      emitHeartbeat: (): Promise<void> => {
        const step = emitPlan.shift();
        if (step === "terminal") return Promise.reject(new PenumbraHttpError("HTTP 403", 403));
        if (step === "retryable") return Promise.reject(new Error("retryable-after-reregister"));
        return Promise.resolve();
      },
      reregisterWorker: (): Promise<void> => {
        reregisterCalls.push(reregisterCalls.length + 1);
        return Promise.resolve();
      },
      exit: (code) => {
        exitCalls.push(code);
      },
      schedule: (run, delayMs) => {
        emitDelays.push(delayMs);
        return scheduler.schedule(run, delayMs);
      },
      timeoutMs: 1,
      log: silentLog,
      workerId: "W-A",
    });

    expect(scheduler.tasks).toHaveLength(1);

    await runNextScheduled(scheduler.tasks);
    expect(reregisterCalls).toEqual([1]);
    expect(exitCalls).toEqual([]);
    expect(emitDelays[0]).toBe(0);

    await runNextScheduled(scheduler.tasks);
    expect(emitDelays[1]).toBe(0);

    await runNextScheduled(scheduler.tasks);
    expect(emitDelays[2]).toBe(1_000);

    await runNextScheduled(scheduler.tasks);
    expect(emitDelays[3]).toBe(15_000);
    expect(exitCalls).toEqual([]);
    expect(scheduler.tasks).toHaveLength(1);
    expect(scheduler.tasks.at(0)?.delayMs).toBe(15_000);

    loop.stop();
  });

  test("stop during in-flight heartbeat prevents exit and further scheduling", async () => {
    const scheduler = createManualScheduler();
    let resolveHeartbeat!: () => void;
    const exitCalls: number[] = [];
    const emitSignals: AbortSignal[] = [];
    const loop = startHeartbeatLoop({
      emitHeartbeat: async (signal?: AbortSignal): Promise<void> => {
        if (signal) emitSignals.push(signal);
        await new Promise<void>((resolve) => {
          resolveHeartbeat = resolve;
        });
      },
      reregisterWorker: (): Promise<void> => Promise.reject(new Error("unexpected re-register")),
      exit: (code) => {
        exitCalls.push(code);
      },
      schedule: scheduler.schedule,
      timeoutMs: 1,
      log: silentLog,
      workerId: "W-A",
    });

    const running = runNextScheduled(scheduler.tasks);
    await Promise.resolve();
    loop.stop();
    resolveHeartbeat();
    await running;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(emitSignals).toHaveLength(1);
    expect(exitCalls).toEqual([]);
    expect(scheduler.tasks).toHaveLength(0);
  });

  test("exits without re-registering when the recovery cap of 3 is hit with no intervening healthy heartbeat", async () => {
    const scheduler = createManualScheduler();
    const emitPlan: "terminal"[] = ["terminal", "terminal", "terminal", "terminal"];
    const reregisterCalls: number[] = [];
    const exitCalls: number[] = [];
    const loop = startHeartbeatLoop({
      emitHeartbeat: (): Promise<void> => {
        const step = emitPlan.shift();
        if (step === "terminal") return Promise.reject(new PenumbraHttpError("HTTP 403", 403));
        return Promise.resolve();
      },
      reregisterWorker: (): Promise<void> => {
        reregisterCalls.push(reregisterCalls.length + 1);
        return Promise.resolve();
      },
      exit: (code) => {
        exitCalls.push(code);
      },
      schedule: scheduler.schedule,
      timeoutMs: 1,
      log: silentLog,
      workerId: "W-A",
    });

    for (let i = 0; i < 4; i++) {
      await runNextScheduled(scheduler.tasks);
    }

    expect(reregisterCalls).toEqual([1, 2, 3]);
    expect(exitCalls).toEqual([1]);
    expect(scheduler.tasks).toHaveLength(0);

    loop.stop();
  });

  test("healthy heartbeat resets the recovery counter so isolated terminal events never exhaust the cap", async () => {
    const scheduler = createManualScheduler();
    const emitPlan: ("terminal" | "ok")[] = [
      "terminal",
      "ok",
      "terminal",
      "ok",
      "terminal",
      "ok",
      "terminal",
      "ok",
    ];
    const reregisterCalls: number[] = [];
    const exitCalls: number[] = [];
    const loop = startHeartbeatLoop({
      emitHeartbeat: (): Promise<void> => {
        const step = emitPlan.shift();
        if (step === "terminal") return Promise.reject(new PenumbraHttpError("HTTP 403", 403));
        return Promise.resolve();
      },
      reregisterWorker: (): Promise<void> => {
        reregisterCalls.push(reregisterCalls.length + 1);
        return Promise.resolve();
      },
      exit: (code) => {
        exitCalls.push(code);
      },
      schedule: scheduler.schedule,
      timeoutMs: 1,
      log: silentLog,
      workerId: "W-A",
    });

    for (let i = 0; i < 8; i++) {
      await runNextScheduled(scheduler.tasks);
    }

    expect(reregisterCalls).toEqual([1, 2, 3, 4]);
    expect(exitCalls).toEqual([]);
    expect(scheduler.tasks).toHaveLength(1);

    loop.stop();
  });

  test("terminal 4xx exits when re-register hangs and times out", async () => {
    const scheduler = createManualScheduler();
    const exitCalls: number[] = [];
    const loop = startHeartbeatLoop({
      emitHeartbeat: (): Promise<void> => Promise.reject(new PenumbraHttpError("HTTP 409", 409)),
      reregisterWorker: () =>
        new Promise<void>(() => {
          /* hang */
        }),
      exit: (code) => {
        exitCalls.push(code);
      },
      schedule: scheduler.schedule,
      timeoutMs: 1,
      log: silentLog,
      workerId: "W-A",
    });

    await runNextScheduled(scheduler.tasks);

    expect(exitCalls).toEqual([1]);
    expect(scheduler.tasks).toHaveLength(0);

    loop.stop();
  });

  test("terminal 4xx exits when re-register fails", async () => {
    const scheduler = createManualScheduler();
    const exitCalls: number[] = [];
    const loop = startHeartbeatLoop({
      emitHeartbeat: (): Promise<void> => Promise.reject(new PenumbraHttpError("HTTP 409", 409)),
      reregisterWorker: (): Promise<void> => Promise.reject(new Error("re-register failed")),
      exit: (code) => {
        exitCalls.push(code);
      },
      schedule: scheduler.schedule,
      timeoutMs: 1,
      log: silentLog,
      workerId: "W-A",
    });

    await runNextScheduled(scheduler.tasks);

    expect(exitCalls).toEqual([1]);
    expect(scheduler.tasks).toHaveLength(0);

    loop.stop();
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

import type { WorkerFatalRecord } from "../src/crash-guard.js";

import { installGlobalCrashHandlers } from "../src/crash-guard.js";

const logged: { record: WorkerFatalRecord; msg: string }[] = [];
let flushCount = 0;
let throwOnLog = false;

const log = {
  error: (obj: unknown, msg?: string): void => {
    if (throwOnLog) throw new Error("logger unavailable");
    logged.push({ record: obj as WorkerFatalRecord, msg: msg ?? "" });
  },
};

const priorRejectionListeners = process.listeners("unhandledRejection");
const priorExceptionListeners = process.listeners("uncaughtException");
let exitSpy: ReturnType<typeof spyOn<typeof process, "exit">>;
const originalGuardEnv = process.env["PENUMBRA_WORKER_CRASH_GUARD"];

beforeAll(() => {
  exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  installGlobalCrashHandlers({
    log,
    flush: () => {
      flushCount += 1;
    },
  });
});

afterEach(() => {
  logged.length = 0;
  flushCount = 0;
  throwOnLog = false;
  exitSpy.mockClear();
  if (originalGuardEnv === undefined) {
    delete process.env["PENUMBRA_WORKER_CRASH_GUARD"];
  } else {
    process.env["PENUMBRA_WORKER_CRASH_GUARD"] = originalGuardEnv;
  }
});

afterAll(() => {
  exitSpy.mockRestore();
  for (const listener of process.listeners("unhandledRejection")) {
    if (!priorRejectionListeners.includes(listener)) {
      process.removeListener("unhandledRejection", listener);
    }
  }
  for (const listener of process.listeners("uncaughtException")) {
    if (!priorExceptionListeners.includes(listener)) {
      process.removeListener("uncaughtException", listener);
    }
  }
});

describe("installGlobalCrashHandlers", () => {
  test("registers exactly one handler per fatal event", () => {
    expect(process.listenerCount("unhandledRejection")).toBe(priorRejectionListeners.length + 1);
    expect(process.listenerCount("uncaughtException")).toBe(priorExceptionListeners.length + 1);
  });

  test("second install is a no-op", () => {
    installGlobalCrashHandlers({ log });
    expect(process.listenerCount("unhandledRejection")).toBe(priorRejectionListeners.length + 1);
    expect(process.listenerCount("uncaughtException")).toBe(priorExceptionListeners.length + 1);
  });

  test("uncaughtException logs a worker_fatal record with stack and exits 1", () => {
    const err = new Error("kaboom");
    process.emit("uncaughtException", err);

    expect(logged).toHaveLength(1);
    expect(logged[0]?.record).toMatchObject({
      event: "worker_fatal",
      kind: "uncaughtException",
      err: "kaboom",
    });
    expect(logged[0]?.record.stack).toContain("kaboom");
    expect(logged[0]?.msg).toBe("agentchat-worker-fatal");
    expect(flushCount).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("uncaughtException exits even when PENUMBRA_WORKER_CRASH_GUARD=survive", () => {
    process.env["PENUMBRA_WORKER_CRASH_GUARD"] = "survive";
    process.emit("uncaughtException", new Error("still fatal"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("unhandledRejection exits by default", () => {
    delete process.env["PENUMBRA_WORKER_CRASH_GUARD"];
    process.emit("unhandledRejection", new Error("rejected"), Promise.resolve());

    expect(logged[0]?.record.kind).toBe("unhandledRejection");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("unhandledRejection survives when PENUMBRA_WORKER_CRASH_GUARD=survive", () => {
    process.env["PENUMBRA_WORKER_CRASH_GUARD"] = "survive";
    process.emit("unhandledRejection", new Error("survivable"), Promise.resolve());

    expect(logged).toHaveLength(1);
    expect(flushCount).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("non-Error fatals are stringified with a null stack", () => {
    process.env["PENUMBRA_WORKER_CRASH_GUARD"] = "survive";
    process.emit("unhandledRejection", "plain string failure", Promise.resolve());

    expect(logged[0]?.record.err).toBe("plain string failure");
    expect(logged[0]?.record.stack).toBeNull();
  });

  test("a throwing logger does not mask the exit", () => {
    throwOnLog = true;
    process.emit("uncaughtException", new Error("logger down"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

import type { WorkerFatalRecord } from "../src/crash-guard.js";

// The query string forces a fresh module instance so the module-level
// installed flag starts false regardless of other files in the same process.
// The specifier must stay non-literal for tsc, which cannot resolve query imports.
const crashGuardSpec = "../src/crash-guard.js?crash-guard-test";
const crashGuardModule: unknown = await import(crashGuardSpec);
const crashGuard = crashGuardModule as typeof import("../src/crash-guard.js");
const { installGlobalCrashHandlers } = crashGuard;

type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;
type ExceptionListener = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;

const logged: { record: WorkerFatalRecord; msg: string }[] = [];
let flushCount = 0;
let throwOnLog = false;

const log = {
  error: (obj: unknown, msg?: string): void => {
    if (throwOnLog) throw new Error("logger unavailable");
    logged.push({ record: obj as WorkerFatalRecord, msg: msg ?? "" });
  },
};

let listenersAtInstall: {
  rejection: RejectionListener[];
  exception: ExceptionListener[];
};
let exitSpy: ReturnType<typeof spyOn<typeof process, "exit">>;
const originalGuardEnv = process.env["PENUMBRA_WORKER_CRASH_GUARD"];
let testRejectionListeners: RejectionListener[] = [];
let testExceptionListeners: ExceptionListener[] = [];

beforeAll(() => {
  exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const rejectionListenersBeforeInstall = new Set(process.listeners("unhandledRejection"));
  const exceptionListenersBeforeInstall = new Set(process.listeners("uncaughtException"));
  installGlobalCrashHandlers({
    log,
    flush: () => {
      flushCount += 1;
    },
  });
  listenersAtInstall = {
    rejection: process.listeners("unhandledRejection"),
    exception: process.listeners("uncaughtException"),
  };
  testRejectionListeners = listenersAtInstall.rejection.filter(
    (listener) => !rejectionListenersBeforeInstall.has(listener),
  );
  testExceptionListeners = listenersAtInstall.exception.filter(
    (listener) => !exceptionListenersBeforeInstall.has(listener),
  );
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
  for (const listener of testRejectionListeners) {
    process.removeListener("unhandledRejection", listener);
  }
  for (const listener of testExceptionListeners) {
    process.removeListener("uncaughtException", listener);
  }
});

describe("installGlobalCrashHandlers", () => {
  test("registers exactly one handler per fatal event", () => {
    expect(process.listenerCount("unhandledRejection")).toBe(listenersAtInstall.rejection.length);
    expect(process.listenerCount("uncaughtException")).toBe(listenersAtInstall.exception.length);
  });

  test("second install is a no-op", () => {
    installGlobalCrashHandlers({ log });
    expect(process.listenerCount("unhandledRejection")).toBe(listenersAtInstall.rejection.length);
    expect(process.listenerCount("uncaughtException")).toBe(listenersAtInstall.exception.length);
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

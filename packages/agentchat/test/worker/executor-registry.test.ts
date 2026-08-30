import type { WriteToolsExecutor } from "@src/worker/write-tools-executor.js";

import {
  __resetExecutorRegistry,
  lookupExecutor,
  registerExecutor,
  unregisterExecutor,
} from "@src/worker/executor-registry.js";
import { beforeEach, describe, expect, test } from "bun:test";

const stubExec = (id = "stub"): WriteToolsExecutor => ({ id }) as unknown as WriteToolsExecutor;

describe("executor-registry", () => {
  beforeEach(() => {
    __resetExecutorRegistry();
  });

  test("lookupExecutor returns null for unknown id", () => {
    expect(lookupExecutor("missing")).toBeNull();
  });

  test("registerExecutor + lookupExecutor round-trip", () => {
    const exec = stubExec("a");
    registerExecutor("d1", exec);
    expect(lookupExecutor("d1")).toBe(exec);
  });

  test("unregisterExecutor removes the entry", () => {
    registerExecutor("d1", stubExec());
    unregisterExecutor("d1");
    expect(lookupExecutor("d1")).toBeNull();
  });

  test("unregister of unknown id is a silent no-op", () => {
    expect(() => {
      unregisterExecutor("never-registered");
    }).not.toThrow();
  });

  test("multiple dispatches can coexist", () => {
    const e1 = stubExec("a"),
      e2 = stubExec("b");
    registerExecutor("d1", e1);
    registerExecutor("d2", e2);
    expect(lookupExecutor("d1")).toBe(e1);
    expect(lookupExecutor("d2")).toBe(e2);
  });
});

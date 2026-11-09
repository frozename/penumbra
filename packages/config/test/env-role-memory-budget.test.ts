import { describe, expect, test } from "bun:test";

import * as envMod from "../src/env.js";
import * as cfg from "../src/index.js";

type RoleBudget = {
  rssMiB: number;
  heapUsedMiB: number;
};

type RoleMemoryBudgetEnv = {
  daemon: RoleBudget;
  worker: RoleBudget;
  settledGrowthMiB: number;
};

type GetRoleMemoryBudgetEnv = (env?: Record<string, string | undefined>) => RoleMemoryBudgetEnv;

const getRoleMemoryBudgetEnv = (envMod as Record<string, unknown>)[
  "getRoleMemoryBudgetEnv"
] as GetRoleMemoryBudgetEnv;
const packageGetRoleMemoryBudgetEnv = (cfg as Record<string, unknown>)[
  "getRoleMemoryBudgetEnv"
] as GetRoleMemoryBudgetEnv;

const BUDGET_ENV_KEYS = [
  "PENUMBRA_MEMORY_BUDGET_DAEMON_RSS_MIB",
  "PENUMBRA_MEMORY_BUDGET_DAEMON_HEAP_MIB",
  "PENUMBRA_MEMORY_BUDGET_WORKER_RSS_MIB",
  "PENUMBRA_MEMORY_BUDGET_WORKER_HEAP_MIB",
  "PENUMBRA_MEMORY_BUDGET_SETTLED_GROWTH_MIB",
];

const DEFAULT_ROLE_MEMORY_BUDGET_ENV: RoleMemoryBudgetEnv = {
  daemon: { rssMiB: 1024, heapUsedMiB: 512 },
  worker: { rssMiB: 384, heapUsedMiB: 192 },
  settledGrowthMiB: 64,
};

describe("role memory budget env registry", () => {
  test.each(BUDGET_ENV_KEYS)("registers %s with a non-empty description", (key) => {
    expect(envMod.ENV_REGISTRY).toHaveProperty(key);
    expect(envMod.ENV_REGISTRY[key]?.description).toBeTruthy();
  });
});

describe("getRoleMemoryBudgetEnv", () => {
  test("returns the documented defaults for an empty env", () => {
    expect(typeof getRoleMemoryBudgetEnv).toBe("function");
    expect(getRoleMemoryBudgetEnv({})).toEqual(DEFAULT_ROLE_MEMORY_BUDGET_ENV);
  });

  test("coerces string values and accepts 0", () => {
    expect(typeof getRoleMemoryBudgetEnv).toBe("function");
    const env = getRoleMemoryBudgetEnv({
      PENUMBRA_MEMORY_BUDGET_WORKER_RSS_MIB: "256",
      PENUMBRA_MEMORY_BUDGET_SETTLED_GROWTH_MIB: "0",
    });
    expect(env.worker.rssMiB).toBe(256);
    expect(env.settledGrowthMiB).toBe(0);
  });

  test.each(["-1", "1.5", "abc"])(
    "rejects invalid PENUMBRA_MEMORY_BUDGET_DAEMON_RSS_MIB %j",
    (value) => {
      expect(typeof getRoleMemoryBudgetEnv).toBe("function");
      expect(() =>
        getRoleMemoryBudgetEnv({ PENUMBRA_MEMORY_BUDGET_DAEMON_RSS_MIB: value }),
      ).toThrow(/PENUMBRA_MEMORY_BUDGET_DAEMON_RSS_MIB/);
    },
  );

  test("ignores unrelated malformed keys and still returns defaults", () => {
    expect(typeof getRoleMemoryBudgetEnv).toBe("function");
    expect(() =>
      getRoleMemoryBudgetEnv({ PENUMBRA_UPDATE_SERVICE_MANAGER: "upstart" }),
    ).not.toThrow();
    expect(getRoleMemoryBudgetEnv({ PENUMBRA_UPDATE_SERVICE_MANAGER: "upstart" })).toEqual(
      DEFAULT_ROLE_MEMORY_BUDGET_ENV,
    );
  });
});

describe("package export", () => {
  test("getRoleMemoryBudgetEnv is re-exported from the package index", () => {
    expect(typeof packageGetRoleMemoryBudgetEnv).toBe("function");
    expect(packageGetRoleMemoryBudgetEnv({})).toEqual(DEFAULT_ROLE_MEMORY_BUDGET_ENV);
  });
});

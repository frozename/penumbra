import { describe, expect, test } from "bun:test";

import {
  getDispatchCapsuleMode,
  getJobResourceEnv,
  getMcpResponseBudgetTokens,
  getSessionExtractMaxCharsPerChunk,
  getSessionExtractMaxChunks,
} from "../src/env.js";

describe("getJobResourceEnv", () => {
  test("empty env returns the documented defaults", () => {
    expect(getJobResourceEnv({})).toEqual({
      scope: "auto",
      memoryHigh: "12G",
      memoryMax: "16G",
      swapMax: "1G",
      oomScoreAdj: 900,
      admitMinGiB: undefined,
      admitWaitS: 900,
      heavyLockPath: undefined,
      slice: undefined,
    });
  });

  test("numeric keys are coerced from strings", () => {
    const result = getJobResourceEnv({
      PENUMBRA_JOB_OOM_SCORE_ADJ: "0",
      PENUMBRA_JOB_ADMIT_MIN_GIB: "2.5",
      PENUMBRA_JOB_ADMIT_WAIT_S: "30",
    });
    expect(result.oomScoreAdj).toBe(0);
    expect(result.admitMinGiB).toBe(2.5);
    expect(result.admitWaitS).toBe(30);
  });

  test("whitespace-only heavy lock collapses to undefined", () => {
    expect(getJobResourceEnv({ PENUMBRA_JOB_HEAVY_LOCK: "   " }).heavyLockPath).toBeUndefined();
  });

  test("non-blank heavy lock is returned verbatim", () => {
    expect(getJobResourceEnv({ PENUMBRA_JOB_HEAVY_LOCK: "/locks/heavy.lock" }).heavyLockPath).toBe(
      "/locks/heavy.lock",
    );
  });

  test("unrelated malformed keys do not break job-resource parsing", () => {
    expect(() =>
      getJobResourceEnv({
        PENUMBRA_DISPATCH_CAPSULE_MODE: "on",
        PENUMBRA_UPDATE_SERVICE_MANAGER: "upstart",
        PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS: "0",
      }),
    ).not.toThrow();
    expect(
      getJobResourceEnv({
        PENUMBRA_DISPATCH_CAPSULE_MODE: "on",
        PENUMBRA_UPDATE_SERVICE_MANAGER: "upstart",
        PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS: "0",
      }).scope,
    ).toBe("auto");
  });

  test.each(["512M", "1.5G", "80%", "infinity", "INFINITY", "1024"])(
    "accepts systemd size %s for PENUMBRA_JOB_MEMORY_MAX",
    (size) => {
      expect(getJobResourceEnv({ PENUMBRA_JOB_MEMORY_MAX: size }).memoryMax).toBe(size);
    },
  );

  test.each(["12GB", "1000%", "12 G", ""])(
    "rejects non-systemd size %j for PENUMBRA_JOB_MEMORY_HIGH",
    (size) => {
      expect(() => getJobResourceEnv({ PENUMBRA_JOB_MEMORY_HIGH: size })).toThrow(
        /PENUMBRA_JOB_MEMORY_HIGH/,
      );
    },
  );

  test.each(["1001", "-1", "1.5", ""])(
    "rejects out-of-range PENUMBRA_JOB_OOM_SCORE_ADJ %j",
    (value) => {
      expect(() => getJobResourceEnv({ PENUMBRA_JOB_OOM_SCORE_ADJ: value })).toThrow(
        /PENUMBRA_JOB_OOM_SCORE_ADJ/,
      );
    },
  );

  test("empty PENUMBRA_JOB_ADMIT_WAIT_S throws instead of falling back to 900", () => {
    expect(() => getJobResourceEnv({ PENUMBRA_JOB_ADMIT_WAIT_S: "" })).toThrow(
      /PENUMBRA_JOB_ADMIT_WAIT_S/,
    );
  });

  test("empty PENUMBRA_JOB_ADMIT_MIN_GIB throws instead of meaning derive-the-floor", () => {
    expect(() => getJobResourceEnv({ PENUMBRA_JOB_ADMIT_MIN_GIB: "" })).toThrow(
      /PENUMBRA_JOB_ADMIT_MIN_GIB/,
    );
  });

  test("PENUMBRA_JOB_SCOPE outside auto|on|off throws", () => {
    expect(() => getJobResourceEnv({ PENUMBRA_JOB_SCOPE: "yes" })).toThrow(/PENUMBRA_JOB_SCOPE/);
  });

  test.each(["on", "off"] as const)("PENUMBRA_JOB_SCOPE %s is returned as-is", (scope) => {
    expect(getJobResourceEnv({ PENUMBRA_JOB_SCOPE: scope }).scope).toBe(scope);
  });

  test("PENUMBRA_JOB_SLICE is returned verbatim", () => {
    expect(getJobResourceEnv({ PENUMBRA_JOB_SLICE: "penumbra-jobs.slice" }).slice).toBe(
      "penumbra-jobs.slice",
    );
  });

  test("PENUMBRA_JOB_SLICE accepts a nested slice name verbatim", () => {
    expect(getJobResourceEnv({ PENUMBRA_JOB_SLICE: "penumbra-jobs-heavy.slice" }).slice).toBe(
      "penumbra-jobs-heavy.slice",
    );
  });

  test.each([
    "penumbra-jobs.service",
    "penumbra jobs.slice",
    "-penumbra.slice",
    "penumbra--jobs.slice",
    "penumbra-.slice",
    ".slice",
  ])("rejects non-slice unit %j for PENUMBRA_JOB_SLICE", (value) => {
    expect(() => getJobResourceEnv({ PENUMBRA_JOB_SLICE: value })).toThrow(/PENUMBRA_JOB_SLICE/);
  });

  test("PENUMBRA_JOB_SLICE unset or whitespace-only yields no slice", () => {
    expect(getJobResourceEnv({}).slice).toBeUndefined();
    expect(getJobResourceEnv({ PENUMBRA_JOB_SLICE: "   " }).slice).toBeUndefined();
  });
});

describe("getDispatchCapsuleMode", () => {
  test("empty env returns off", () => {
    expect(getDispatchCapsuleMode({})).toBe("off");
  });

  test("shadow is accepted", () => {
    expect(getDispatchCapsuleMode({ PENUMBRA_DISPATCH_CAPSULE_MODE: "shadow" })).toBe("shadow");
  });

  test.each(["on", "true", "SHADOW"])("rejects capsule mode %s with the key name", (value) => {
    expect(() => getDispatchCapsuleMode({ PENUMBRA_DISPATCH_CAPSULE_MODE: value })).toThrow(
      /PENUMBRA_DISPATCH_CAPSULE_MODE/,
    );
  });

  test("unrelated malformed keys do not break capsule-mode parsing", () => {
    expect(() =>
      getDispatchCapsuleMode({
        PENUMBRA_JOB_MEMORY_MAX: "not-a-size",
        PENUMBRA_JOB_SCOPE: "yes",
      }),
    ).not.toThrow();
    expect(
      getDispatchCapsuleMode({
        PENUMBRA_JOB_MEMORY_MAX: "not-a-size",
        PENUMBRA_JOB_SCOPE: "yes",
      }),
    ).toBe("off");
  });
});

describe("getMcpResponseBudgetTokens", () => {
  test("empty env returns null, not undefined", () => {
    expect(getMcpResponseBudgetTokens({})).toBeNull();
  });

  test("numeric string is coerced to a number", () => {
    expect(getMcpResponseBudgetTokens({ PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS: "4000" })).toBe(4000);
  });

  test.each(["0", "-5", "abc", "1.5"])(
    "rejects invalid budget value %s with the key name",
    (value) => {
      expect(() =>
        getMcpResponseBudgetTokens({ PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS: value }),
      ).toThrow(/PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS/);
    },
  );
});

describe("session extract limits", () => {
  test("empty env gives the default max chars per chunk", () => {
    expect(getSessionExtractMaxCharsPerChunk({})).toBe(20000);
  });

  test("empty env gives the default max chunks", () => {
    expect(getSessionExtractMaxChunks({})).toBe(8);
  });

  test("max chars per chunk is coerced from a string", () => {
    expect(
      getSessionExtractMaxCharsPerChunk({ PENUMBRA_SESSION_EXTRACT_MAX_CHARS_PER_CHUNK: "12000" }),
    ).toBe(12000);
  });

  test("max chunks is coerced from a string", () => {
    expect(getSessionExtractMaxChunks({ PENUMBRA_SESSION_EXTRACT_MAX_CHUNKS: "3" })).toBe(3);
  });

  test("zero max chars per chunk throws", () => {
    expect(() =>
      getSessionExtractMaxCharsPerChunk({ PENUMBRA_SESSION_EXTRACT_MAX_CHARS_PER_CHUNK: "0" }),
    ).toThrow(/PENUMBRA_SESSION_EXTRACT_MAX_CHARS_PER_CHUNK/);
  });

  test("zero max chunks throws", () => {
    expect(() => getSessionExtractMaxChunks({ PENUMBRA_SESSION_EXTRACT_MAX_CHUNKS: "0" })).toThrow(
      /PENUMBRA_SESSION_EXTRACT_MAX_CHUNKS/,
    );
  });
});

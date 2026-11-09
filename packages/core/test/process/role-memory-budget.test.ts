import { describe, expect, test } from "bun:test";

import * as rmb from "@src/process/index.js";

const MiB = 1024 * 1024;

type MemoryUsageLike = {
  rss?: number | undefined;
  heapTotal?: number | undefined;
  heapUsed?: number | undefined;
  external?: number | undefined;
  arrayBuffers?: number | undefined;
};

type ProcessMemoryDeps = {
  memoryUsage?: () => MemoryUsageLike;
  uptime?: () => number;
};

type ProcessMemorySample = {
  rssBytes: number | null;
  heapUsedBytes: number | null;
  heapTotalBytes: number | null;
  externalBytes: number | null;
  arrayBuffersBytes: number | null;
  uptimeS: number;
};

type BudgetMetric = "rss" | "heap_used";

type RoleMemoryBudget = {
  rssMiB: number;
  heapUsedMiB: number;
};

type RoleMemoryBudgetVerdict = {
  status: "within" | "over" | "unknown" | "unbudgeted";
  breaches: { metric: BudgetMetric; observedBytes: number; limitBytes: number }[];
  unknownMetrics: BudgetMetric[];
  role: "daemon" | "worker";
  outcomeClass: string | null;
};

type HeapUsageSample = {
  heapUsedBytes: number | null;
};

type SettledGrowthVerdict = {
  status: "bounded" | "regressed" | "unknown" | "disabled";
  growthBytes: number | null;
  limitBytes: number | null;
  outcomeClass: string | null;
};

const sampleProcessMemory = (rmb as Record<string, unknown>)["sampleProcessMemory"] as (
  deps?: ProcessMemoryDeps,
) => ProcessMemorySample;

const evaluateRoleMemoryBudget = (rmb as Record<string, unknown>)["evaluateRoleMemoryBudget"] as (
  role: "daemon" | "worker",
  sample: ProcessMemorySample,
  budget: RoleMemoryBudget,
) => RoleMemoryBudgetVerdict;

const evaluateSettledGrowth = (rmb as Record<string, unknown>)["evaluateSettledGrowth"] as (
  baseline: HeapUsageSample,
  settled: HeapUsageSample,
  settledGrowthMiB: number,
) => SettledGrowthVerdict;

const STANDARD_BUDGET: RoleMemoryBudget = { rssMiB: 1024, heapUsedMiB: 512 };

function memSample(overrides: Partial<ProcessMemorySample> = {}): ProcessMemorySample {
  return {
    rssBytes: 300 * MiB,
    heapUsedBytes: 100 * MiB,
    heapTotalBytes: 150 * MiB,
    externalBytes: 5 * MiB,
    arrayBuffersBytes: 2 * MiB,
    uptimeS: 42.5,
    ...overrides,
  };
}

describe("sampleProcessMemory", () => {
  test("maps memoryUsage fields to byte fields and uptime to uptimeS", () => {
    expect(typeof sampleProcessMemory).toBe("function");
    expect(
      sampleProcessMemory({
        memoryUsage: () => ({
          rss: 300 * MiB,
          heapUsed: 100 * MiB,
          heapTotal: 150 * MiB,
          external: 5 * MiB,
          arrayBuffers: 2 * MiB,
        }),
        uptime: () => 42.5,
      }),
    ).toEqual({
      rssBytes: 300 * MiB,
      heapUsedBytes: 100 * MiB,
      heapTotalBytes: 150 * MiB,
      externalBytes: 5 * MiB,
      arrayBuffersBytes: 2 * MiB,
      uptimeS: 42.5,
    });
  });

  test("keeps unsupported readings unknown instead of coercing to zero", () => {
    expect(typeof sampleProcessMemory).toBe("function");
    const sample = sampleProcessMemory({
      memoryUsage: () => ({
        rss: NaN,
        heapUsed: -1,
        heapTotal: 150 * MiB,
        external: undefined,
        arrayBuffers: 3 * MiB,
      }),
      uptime: () => 7,
    });
    expect(sample.rssBytes).toBeNull();
    expect(sample.heapUsedBytes).toBeNull();
    expect(sample.externalBytes).toBeNull();
    expect(sample.heapTotalBytes).toBe(150 * MiB);
    expect(sample.arrayBuffersBytes).toBe(3 * MiB);
    expect(sample.uptimeS).toBe(7);
  });

  test("still reads uptime when memoryUsage throws", () => {
    expect(typeof sampleProcessMemory).toBe("function");
    let uptimeCalls = 0;
    const sample = sampleProcessMemory({
      memoryUsage: () => {
        throw new Error("memoryUsage unavailable");
      },
      uptime: () => {
        uptimeCalls += 1;
        return 12.5;
      },
    });
    expect(sample).toMatchObject({
      rssBytes: null,
      heapUsedBytes: null,
      heapTotalBytes: null,
      externalBytes: null,
      arrayBuffersBytes: null,
      uptimeS: 12.5,
    });
    expect(uptimeCalls).toBe(1);
  });

  test("samples the live process when deps are omitted", () => {
    expect(typeof sampleProcessMemory).toBe("function");
    const sample = sampleProcessMemory();
    expect(Number.isFinite(sample.rssBytes)).toBe(true);
    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(Number.isFinite(sample.heapUsedBytes)).toBe(true);
    expect(sample.heapUsedBytes).toBeGreaterThan(0);
    expect(typeof sample.uptimeS).toBe("number");
  });
});

describe("evaluateRoleMemoryBudget", () => {
  test("reports within when every budgeted metric stays under its limit", () => {
    expect(typeof evaluateRoleMemoryBudget).toBe("function");
    expect(
      evaluateRoleMemoryBudget(
        "daemon",
        memSample({ rssBytes: 900 * MiB, heapUsedBytes: 400 * MiB }),
        STANDARD_BUDGET,
      ),
    ).toMatchObject({
      status: "within",
      breaches: [],
      unknownMetrics: [],
      role: "daemon",
      outcomeClass: null,
    });
  });

  test("reports over with a resource outcome when rss exceeds its limit", () => {
    expect(typeof evaluateRoleMemoryBudget).toBe("function");
    const verdict = evaluateRoleMemoryBudget(
      "daemon",
      memSample({ rssBytes: 1100 * MiB, heapUsedBytes: 400 * MiB }),
      STANDARD_BUDGET,
    );
    expect(verdict.status).toBe("over");
    expect(verdict.breaches).toEqual([
      { metric: "rss", observedBytes: 1100 * MiB, limitBytes: 1024 * MiB },
    ]);
    expect(verdict.unknownMetrics).toEqual([]);
    expect(verdict.outcomeClass).toBe("resource");
  });

  test("treats the limit as inclusive and orders breaches rss then heap_used", () => {
    expect(typeof evaluateRoleMemoryBudget).toBe("function");
    const atLimit = evaluateRoleMemoryBudget(
      "worker",
      memSample({ rssBytes: 1024 * MiB, heapUsedBytes: 512 * MiB }),
      STANDARD_BUDGET,
    );
    expect(atLimit.status).toBe("within");
    expect(atLimit.breaches).toEqual([]);

    const bothOver = evaluateRoleMemoryBudget(
      "worker",
      memSample({ rssBytes: 1100 * MiB, heapUsedBytes: 600 * MiB }),
      STANDARD_BUDGET,
    );
    expect(bothOver.status).toBe("over");
    expect(bothOver.breaches).toEqual([
      { metric: "rss", observedBytes: 1100 * MiB, limitBytes: 1024 * MiB },
      { metric: "heap_used", observedBytes: 600 * MiB, limitBytes: 512 * MiB },
    ]);
  });

  test("reports unknown when a budgeted metric cannot be sampled", () => {
    expect(typeof evaluateRoleMemoryBudget).toBe("function");
    const verdict = evaluateRoleMemoryBudget(
      "daemon",
      memSample({ rssBytes: null, heapUsedBytes: 400 * MiB }),
      STANDARD_BUDGET,
    );
    expect(verdict.status).toBe("unknown");
    expect(verdict.unknownMetrics).toEqual(["rss"]);
    expect(verdict.breaches).toEqual([]);
    expect(verdict.outcomeClass).toBeNull();
  });

  test("lets a known breach outrank an unknown metric", () => {
    expect(typeof evaluateRoleMemoryBudget).toBe("function");
    const verdict = evaluateRoleMemoryBudget(
      "daemon",
      memSample({ rssBytes: null, heapUsedBytes: 600 * MiB }),
      STANDARD_BUDGET,
    );
    expect(verdict.status).toBe("over");
    expect(verdict.outcomeClass).toBe("resource");
    expect(verdict.unknownMetrics).toEqual(["rss"]);
    expect(verdict.breaches).toEqual([
      { metric: "heap_used", observedBytes: 600 * MiB, limitBytes: 512 * MiB },
    ]);
  });

  test("treats a zero limit as disabled and all-zero budgets as unbudgeted", () => {
    expect(typeof evaluateRoleMemoryBudget).toBe("function");
    const verdict = evaluateRoleMemoryBudget(
      "daemon",
      memSample({ rssBytes: null, heapUsedBytes: 400 * MiB }),
      { rssMiB: 0, heapUsedMiB: 512 },
    );
    expect(verdict.status).toBe("within");
    expect(verdict.breaches).toEqual([]);
    expect(verdict.unknownMetrics).toEqual([]);

    const unbudgeted = evaluateRoleMemoryBudget("daemon", memSample(), {
      rssMiB: 0,
      heapUsedMiB: 0,
    });
    expect(unbudgeted.status).toBe("unbudgeted");
    expect(unbudgeted.outcomeClass).toBeNull();
  });
});

describe("evaluateSettledGrowth", () => {
  test("reports bounded when settled heap growth stays within the threshold", () => {
    expect(typeof evaluateSettledGrowth).toBe("function");
    expect(
      evaluateSettledGrowth(
        memSample({ heapUsedBytes: 100 * MiB }),
        memSample({ heapUsedBytes: 101.5 * MiB }),
        64,
      ),
    ).toEqual({
      status: "bounded",
      growthBytes: 1.5 * MiB,
      limitBytes: 64 * MiB,
      outcomeClass: null,
    });
  });

  test("reports regressed as a resource outcome when growth exceeds the threshold", () => {
    expect(typeof evaluateSettledGrowth).toBe("function");
    const verdict = evaluateSettledGrowth(
      memSample({ heapUsedBytes: 100 * MiB }),
      memSample({ heapUsedBytes: 200 * MiB }),
      64,
    );
    expect(verdict.status).toBe("regressed");
    expect(verdict.growthBytes).toBe(100 * MiB);
    expect(verdict.outcomeClass).toBe("resource");
  });

  test("treats the growth threshold as inclusive — at-threshold growth is bounded", () => {
    expect(typeof evaluateSettledGrowth).toBe("function");
    const verdict = evaluateSettledGrowth(
      memSample({ heapUsedBytes: 100 * MiB }),
      memSample({ heapUsedBytes: 164 * MiB }),
      64,
    );
    expect(verdict.status).toBe("bounded");
    expect(verdict.growthBytes).toBe(64 * MiB);
    expect(verdict.limitBytes).toBe(64 * MiB);
    expect(verdict.outcomeClass).toBeNull();
  });

  test("keeps negative growth bounded", () => {
    expect(typeof evaluateSettledGrowth).toBe("function");
    const verdict = evaluateSettledGrowth(
      memSample({ heapUsedBytes: 100 * MiB }),
      memSample({ heapUsedBytes: 90 * MiB }),
      64,
    );
    expect(verdict.status).toBe("bounded");
    expect(verdict.growthBytes).toBe(-10 * MiB);
    expect(verdict.outcomeClass).toBeNull();
  });

  test("reports unknown when either side lacks heapUsedBytes", () => {
    expect(typeof evaluateSettledGrowth).toBe("function");
    const baselineUnknown = evaluateSettledGrowth(
      memSample({ heapUsedBytes: null }),
      memSample({ heapUsedBytes: 101 * MiB }),
      64,
    );
    expect(baselineUnknown.status).toBe("unknown");
    expect(baselineUnknown.growthBytes).toBeNull();
    expect(baselineUnknown.outcomeClass).toBeNull();

    const settledUnknown = evaluateSettledGrowth(
      memSample({ heapUsedBytes: 100 * MiB }),
      memSample({ heapUsedBytes: null }),
      64,
    );
    expect(settledUnknown.status).toBe("unknown");
    expect(settledUnknown.growthBytes).toBeNull();
    expect(settledUnknown.outcomeClass).toBeNull();
  });

  test("reports disabled when the growth threshold is zero", () => {
    expect(typeof evaluateSettledGrowth).toBe("function");
    const verdict = evaluateSettledGrowth(
      memSample({ heapUsedBytes: 100 * MiB }),
      memSample({ heapUsedBytes: 300 * MiB }),
      0,
    );
    expect(verdict.status).toBe("disabled");
    expect(verdict.outcomeClass).toBeNull();
  });
});

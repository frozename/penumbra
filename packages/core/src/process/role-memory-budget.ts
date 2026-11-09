/**
 * Deterministic per-role process memory budget check for #370.
 *
 * RSS and heap readings are not physical footprint: they are
 * process-accounting figures for the long-lived process itself and say
 * nothing about agent/tool/test children, which are covered separately by
 * the PENUMBRA_JOB_MEMORY_* scope caps.
 *
 * Unknown must never be coerced to 0: a metric that cannot be sampled is
 * reported as unknown rather than as zero usage.
 *
 * A null outcomeClass is not a failure: it must not be mapped onto
 * agent_performance.failure_class.
 */

const MiB = 1024 * 1024;

export type ProcessRole = "daemon" | "worker";

export interface ProcessMemorySampleDeps {
  memoryUsage?: () => Partial<NodeJS.MemoryUsage>;
  uptime?: () => number;
}

export interface ProcessMemorySample {
  rssBytes: number | null;
  heapUsedBytes: number | null;
  heapTotalBytes: number | null;
  externalBytes: number | null;
  arrayBuffersBytes: number | null;
  uptimeS: number | null;
}

export interface RoleMemoryBudget {
  rssMiB: number;
  heapUsedMiB: number;
}

export type MemoryBudgetMetric = "rss" | "heap_used";

export type MemoryOutcomeClass = "resource" | null;

export interface RoleMemoryBudgetBreach {
  metric: MemoryBudgetMetric;
  observedBytes: number;
  limitBytes: number;
}

export interface RoleMemoryBudgetVerdict {
  role: ProcessRole;
  status: "within" | "over" | "unknown" | "unbudgeted";
  breaches: RoleMemoryBudgetBreach[];
  unknownMetrics: MemoryBudgetMetric[];
  outcomeClass: MemoryOutcomeClass;
}

export interface HeapUsageSample {
  heapUsedBytes: number | null;
}

export interface SettledGrowthVerdict {
  status: "bounded" | "regressed" | "unknown" | "disabled";
  growthBytes: number | null;
  limitBytes: number;
  outcomeClass: MemoryOutcomeClass;
}

function safeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function sampleProcessMemory(deps: ProcessMemorySampleDeps = {}): ProcessMemorySample {
  const readUsage = deps.memoryUsage ?? ((): Partial<NodeJS.MemoryUsage> => process.memoryUsage());
  const readUptime = deps.uptime ?? ((): number => process.uptime());
  let usage: Partial<NodeJS.MemoryUsage> | undefined;
  try {
    usage = readUsage();
  } catch {
    usage = undefined;
  }
  let uptimeS: number | null = null;
  try {
    uptimeS = safeNumber(readUptime());
  } catch {
    uptimeS = null;
  }
  return {
    rssBytes: safeNumber(usage?.rss),
    heapUsedBytes: safeNumber(usage?.heapUsed),
    heapTotalBytes: safeNumber(usage?.heapTotal),
    externalBytes: safeNumber(usage?.external),
    arrayBuffersBytes: safeNumber(usage?.arrayBuffers),
    uptimeS,
  };
}

export function evaluateRoleMemoryBudget(
  role: ProcessRole,
  sample: ProcessMemorySample,
  budget: RoleMemoryBudget,
): RoleMemoryBudgetVerdict {
  const breaches: RoleMemoryBudgetBreach[] = [];
  const unknownMetrics: MemoryBudgetMetric[] = [];
  const metrics: {
    metric: MemoryBudgetMetric;
    limitMiB: number;
    observedBytes: number | null;
  }[] = [
    { metric: "rss", limitMiB: budget.rssMiB, observedBytes: sample.rssBytes },
    { metric: "heap_used", limitMiB: budget.heapUsedMiB, observedBytes: sample.heapUsedBytes },
  ];

  let anyBudgeted = false;
  for (const { metric, limitMiB, observedBytes } of metrics) {
    if (limitMiB <= 0) continue;
    anyBudgeted = true;
    const limitBytes = limitMiB * MiB;
    if (observedBytes === null) {
      unknownMetrics.push(metric);
    } else if (observedBytes > limitBytes) {
      breaches.push({ metric, observedBytes, limitBytes });
    }
  }

  if (!anyBudgeted) {
    return { role, status: "unbudgeted", breaches: [], unknownMetrics: [], outcomeClass: null };
  }
  if (breaches.length > 0) {
    return { role, status: "over", breaches, unknownMetrics, outcomeClass: "resource" };
  }
  if (unknownMetrics.length > 0) {
    return { role, status: "unknown", breaches, unknownMetrics, outcomeClass: null };
  }
  return { role, status: "within", breaches, unknownMetrics, outcomeClass: null };
}

export function evaluateSettledGrowth(
  baseline: HeapUsageSample,
  settled: HeapUsageSample,
  thresholdMiB: number,
): SettledGrowthVerdict {
  const limitBytes = thresholdMiB * MiB;
  if (thresholdMiB <= 0) {
    return { status: "disabled", growthBytes: null, limitBytes, outcomeClass: null };
  }
  if (baseline.heapUsedBytes === null || settled.heapUsedBytes === null) {
    return { status: "unknown", growthBytes: null, limitBytes, outcomeClass: null };
  }
  const growthBytes = settled.heapUsedBytes - baseline.heapUsedBytes;
  if (growthBytes > limitBytes) {
    return { status: "regressed", growthBytes, limitBytes, outcomeClass: "resource" };
  }
  return { status: "bounded", growthBytes, limitBytes, outcomeClass: null };
}

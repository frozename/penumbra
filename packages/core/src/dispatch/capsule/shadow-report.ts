import { z } from "zod";

import { Sha256HexSchema } from "../eval-primitives.js";
import { RefusalCodeSchema } from "./schema.js";

export const CAPSULE_SHADOW_KIND = "dispatch.capsule_shadow";

export const CapsuleShadowMetaSchema = z
  .strictObject({
    input_hash: Sha256HexSchema,
    dropped_ids: z.array(z.string()),
    preflight_codes: z.array(z.string()),
    recipe_hash: Sha256HexSchema.optional(),
    output_hash: Sha256HexSchema.optional(),
    token_report: z
      .strictObject({
        estimator: z.enum(["tokenizer", "fallback_estimate"]),
        used: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
      })
      .optional(),
    refusal_code: RefusalCodeSchema.optional(),
  })
  .superRefine((meta, ctx) => {
    const hasRefusal = meta.refusal_code !== undefined;
    const hasOutput = meta.output_hash !== undefined;
    if (!hasRefusal && !hasOutput) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of refusal_code or output_hash is required",
      });
      return;
    }
    if (hasRefusal && hasOutput) {
      ctx.addIssue({
        code: "custom",
        message: "refusal_code and output_hash are mutually exclusive",
      });
    }
  });

export type ShadowOutcome = "success" | "failure";
export type ShadowTally = { success: number; failure: number; unknown: number };
export type EstimatorCounts = { tokenizer: number; fallback_estimate: number; missing: number };
export type TokenUtilization = { n: number; min: number; median: number; max: number };
export type ParsedShadowEvent = {
  handoff_id: string;
  meta: z.infer<typeof CapsuleShadowMetaSchema>;
  is_refused: boolean;
};
export type CapsuleShadowSummary = {
  design: "observational_shadow";
  uplift: null;
  uplift_unavailable_reason: "shadow_untreated";
  events_total: number;
  duplicates: number;
  malformed: number;
  compiled: number;
  refused: number;
  refusal_codes: Record<string, number>;
  preflight_codes: Record<string, number>;
  estimator: EstimatorCounts;
  token_utilization: TokenUtilization | null;
  with_dropped: number;
  outcomes: {
    by_status: { compiled: ShadowTally; refused: ShadowTally };
    by_preflight: { clean: number; flagged: number };
  } | null;
};

function parseShadowEvents(
  events: readonly { handoff_id: string; kind: string; meta: unknown }[],
): { parsed: ParsedShadowEvent[]; malformed: number } {
  const filtered = events.filter((e) => e.kind === CAPSULE_SHADOW_KIND);
  const parsed: ParsedShadowEvent[] = [];
  let malformed = 0;
  for (const event of filtered) {
    const result = CapsuleShadowMetaSchema.safeParse(event.meta);
    if (!result.success) {
      malformed++;
      continue;
    }
    parsed.push({
      handoff_id: event.handoff_id,
      meta: result.data,
      is_refused: result.data.refusal_code !== undefined,
    });
  }
  return { parsed, malformed };
}

function deduplicateEvents(parsed: ParsedShadowEvent[]): {
  seen: Map<string, ParsedShadowEvent>;
  duplicates: number;
} {
  const seen = new Map<string, ParsedShadowEvent>();
  let duplicates = 0;
  for (const event of parsed) {
    const key = `${event.handoff_id}\u0000${event.meta.input_hash}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.set(key, event);
  }
  return { seen, duplicates };
}

function countCompiledAndRefused(seen: Map<string, ParsedShadowEvent>): {
  compiled: number;
  refused: number;
} {
  const compiled = [...seen.values()].filter((e) => !e.is_refused).length;
  const refused = [...seen.values()].filter((e) => e.is_refused).length;
  return { compiled, refused };
}

function aggregateCodes(seen: Map<string, ParsedShadowEvent>): {
  refusalCodes: Record<string, number>;
  preflightCodes: Record<string, number>;
} {
  const refusalCodes: Record<string, number> = {};
  const preflightCodes: Record<string, number> = {};
  for (const event of seen.values()) {
    if (event.is_refused && event.meta.refusal_code !== undefined) {
      refusalCodes[event.meta.refusal_code] = (refusalCodes[event.meta.refusal_code] ?? 0) + 1;
    }
    for (const code of event.meta.preflight_codes) {
      preflightCodes[code] = (preflightCodes[code] ?? 0) + 1;
    }
  }
  return { refusalCodes, preflightCodes };
}

function computeEstimatorAndUtilization(seen: Map<string, ParsedShadowEvent>): {
  estimator: EstimatorCounts;
  token_utilization: TokenUtilization | null;
  with_dropped: number;
} {
  const estimator: EstimatorCounts = { tokenizer: 0, fallback_estimate: 0, missing: 0 };
  const utilizationRatios: number[] = [];
  let with_dropped = 0;
  for (const event of seen.values()) {
    if (event.is_refused) continue;
    processCompiledEvent(event, estimator, utilizationRatios);
    if (event.meta.dropped_ids.length > 0) with_dropped++;
  }
  let token_utilization: TokenUtilization | null = null;
  if (utilizationRatios.length > 0) {
    const n = utilizationRatios.length;
    const sorted = utilizationRatios.toSorted((a, b) => a - b);
    const n2 = sorted.length;
    token_utilization = computeTokenUtilization(sorted, n, n2);
  }
  return { estimator, token_utilization, with_dropped };
}

function processCompiledEvent(
  event: ParsedShadowEvent,
  estimator: EstimatorCounts,
  utilizationRatios: number[],
): void {
  if (event.meta.token_report) {
    if (event.meta.token_report.estimator === "tokenizer") estimator.tokenizer++;
    else estimator.fallback_estimate++;
    utilizationRatios.push(event.meta.token_report.used / event.meta.token_report.limit);
  } else {
    estimator.missing++;
  }
}

function computeTokenUtilization(sorted: number[], n: number, n2: number): TokenUtilization {
  const med = computeMedian(sorted, n2);
  const min = sorted[0];
  const max = sorted[n - 1];
  return { n, min: min ?? 0, median: med, max: max ?? 0 };
}

function computeMedian(sorted: number[], n2: number): number {
  if (n2 === 0) return 0;
  if (n2 % 2 === 1) return sorted[(n2 - 1) / 2] ?? 0;
  const left = sorted[n2 / 2 - 1] ?? 0;
  const right = sorted[n2 / 2] ?? 0;
  return (left + right) / 2;
}

function buildSortedRecord(source: Record<string, number>): Record<string, number> {
  const sorted = Object.keys(source).toSorted();
  const result: Record<string, number> = {};
  for (const k of sorted) {
    const value = source[k];
    if (value !== undefined) {
      result[k] = value;
    }
  }
  return result;
}

function computeOutcomes(
  seen: Map<string, ParsedShadowEvent>,
  outcomesMap: ReadonlyMap<string, ShadowOutcome>,
): CapsuleShadowSummary["outcomes"] {
  let compiledTally: ShadowTally = { success: 0, failure: 0, unknown: 0 };
  let refusedTally: ShadowTally = { success: 0, failure: 0, unknown: 0 };
  let clean = 0;
  let flagged = 0;
  for (const event of seen.values()) {
    const outcome = outcomesMap.get(event.handoff_id);
    const tally = buildTally(outcome);
    if (event.is_refused) {
      refusedTally = mergeTally(refusedTally, tally);
    } else {
      compiledTally = mergeTally(compiledTally, tally);
    }
    if (event.meta.preflight_codes.every((code) => code === "worktree_deferred")) clean++;
    else flagged++;
  }
  return {
    by_status: { compiled: compiledTally, refused: refusedTally },
    by_preflight: { clean, flagged },
  };
}

function buildTally(outcome: ShadowOutcome | undefined): ShadowTally {
  if (outcome === "success") return { success: 1, failure: 0, unknown: 0 };
  if (outcome === "failure") return { success: 0, failure: 1, unknown: 0 };
  return { success: 0, failure: 0, unknown: 1 };
}

function mergeTally(a: ShadowTally, b: ShadowTally): ShadowTally {
  return {
    success: a.success + b.success,
    failure: a.failure + b.failure,
    unknown: a.unknown + b.unknown,
  };
}

export function summarizeCapsuleShadow(
  events: readonly { handoff_id: string; kind: string; meta: unknown }[],
  opts?: { outcomes?: ReadonlyMap<string, ShadowOutcome> },
): CapsuleShadowSummary {
  const { parsed, malformed } = parseShadowEvents(events);
  const { seen, duplicates } = deduplicateEvents(parsed);
  const { compiled, refused } = countCompiledAndRefused(seen);
  const events_total = parsed.length + malformed - duplicates;
  const { refusalCodes, preflightCodes } = aggregateCodes(seen);
  const { estimator, token_utilization, with_dropped } = computeEstimatorAndUtilization(seen);
  let outcomes: CapsuleShadowSummary["outcomes"] = null;
  if (opts?.outcomes) {
    outcomes = computeOutcomes(seen, opts.outcomes);
  }
  const refusal_codes = buildSortedRecord(refusalCodes);
  const preflight_codes = buildSortedRecord(preflightCodes);
  return {
    design: "observational_shadow",
    uplift: null,
    uplift_unavailable_reason: "shadow_untreated",
    events_total,
    duplicates,
    malformed,
    compiled,
    refused,
    refusal_codes,
    preflight_codes,
    estimator,
    token_utilization,
    with_dropped,
    outcomes,
  };
}

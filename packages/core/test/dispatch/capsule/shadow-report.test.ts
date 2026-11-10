import { describe, expect, test } from "bun:test";

import * as capsule from "@src/dispatch/capsule/index.js";

const CAPSULE_SHADOW_KIND = "dispatch.capsule_shadow";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);
const H4 = "d".repeat(64);
const H5 = "e".repeat(64);
const H6 = "f".repeat(64);

interface ShadowEvent {
  handoff_id: string;
  kind: string;
  meta: unknown;
}

interface ShadowEstimatorCounts {
  tokenizer: number;
  fallback_estimate: number;
  missing: number;
}

interface ShadowTokenUtilization {
  n: number;
  min: number;
  median: number;
  max: number;
}

interface ShadowOutcomeBucket {
  success: number;
  failure: number;
  unknown: number;
}

interface ShadowSummary {
  design: string;
  uplift: unknown;
  uplift_unavailable_reason: string;
  events_total: number;
  compiled: number;
  refused: number;
  malformed: number;
  duplicates: number;
  estimator: ShadowEstimatorCounts;
  token_utilization: ShadowTokenUtilization | null;
  with_dropped: number;
  refusal_codes: Record<string, number>;
  preflight_codes: Record<string, number>;
  outcomes: {
    by_status: { compiled: ShadowOutcomeBucket; refused: ShadowOutcomeBucket };
    by_preflight: { clean: number; flagged: number };
  } | null;
}

interface SummarizeOptions {
  outcomes?: ReadonlyMap<string, string>;
}

type SummarizeFn = (events: readonly ShadowEvent[], opts?: SummarizeOptions) => ShadowSummary;

function summarizer(): SummarizeFn {
  const fn = (capsule as Record<string, unknown>)["summarizeCapsuleShadow"];
  expect(typeof fn).toBe("function");
  return fn as SummarizeFn;
}

interface ShadowMetaSchema {
  safeParse: (value: unknown) => { success: boolean };
}

function metaSchema(): ShadowMetaSchema {
  const schema = (capsule as Record<string, unknown>)["CapsuleShadowMetaSchema"];
  expect(typeof schema).toBe("object");
  return schema as ShadowMetaSchema;
}

function compiledMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipe_hash: H1,
    input_hash: H2,
    output_hash: H3,
    token_report: { estimator: "tokenizer", used: 8000, limit: 32000 },
    dropped_ids: ["memory:auto_recall:0"],
    preflight_codes: ["worktree_deferred"],
    ...overrides,
  };
}

function refusedMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input_hash: H2,
    dropped_ids: [],
    preflight_codes: ["base_missing"],
    refusal_code: "stale_base",
    ...overrides,
  };
}

function trimmedMeta(): Record<string, unknown> {
  return {
    recipe_hash: H1,
    input_hash: H2,
    output_hash: H3,
    dropped_ids: [],
    preflight_codes: [],
  };
}

function shadowEvent(handoffId: string, meta: unknown): ShadowEvent {
  return { handoff_id: handoffId, kind: CAPSULE_SHADOW_KIND, meta };
}

describe("CapsuleShadowMetaSchema", () => {
  test("accepts the compiled, refused and trimmed producer metas", () => {
    const schema = metaSchema();
    expect(schema.safeParse(compiledMeta()).success).toBe(true);
    expect(schema.safeParse(refusedMeta()).success).toBe(true);
    expect(schema.safeParse(trimmedMeta()).success).toBe(true);
  });

  test("rejects a meta carrying both refusal_code and output_hash", () => {
    const schema = metaSchema();
    expect(schema.safeParse({ ...refusedMeta(), output_hash: H3 }).success).toBe(false);
    expect(schema.safeParse({ ...compiledMeta(), refusal_code: "stale_base" }).success).toBe(false);
  });

  test("rejects a meta carrying neither refusal_code nor output_hash", () => {
    const schema = metaSchema();
    expect(schema.safeParse({ input_hash: H2, dropped_ids: [], preflight_codes: [] }).success).toBe(
      false,
    );
  });

  test("rejects an unknown refusal_code", () => {
    const schema = metaSchema();
    expect(schema.safeParse({ ...refusedMeta(), refusal_code: "nope" }).success).toBe(false);
  });

  test("rejects a non-hex output_hash", () => {
    const schema = metaSchema();
    expect(schema.safeParse({ ...compiledMeta(), output_hash: "g".repeat(64) }).success).toBe(
      false,
    );
  });

  test("rejects a non-hex input_hash", () => {
    const schema = metaSchema();
    expect(schema.safeParse({ ...compiledMeta(), input_hash: "g".repeat(64) }).success).toBe(false);
  });

  test("rejects unknown keys", () => {
    const schema = metaSchema();
    expect(schema.safeParse({ ...compiledMeta(), surprise: true }).success).toBe(false);
    expect(schema.safeParse({ ...refusedMeta(), surprise: true }).success).toBe(false);
  });
});

describe("summarizeCapsuleShadow", () => {
  test("counts one compiled event with its estimator and token utilization", () => {
    const summarize = summarizer();
    const summary = summarize([shadowEvent("h1", compiledMeta())]);
    expect(summary.events_total).toBe(1);
    expect(summary.compiled).toBe(1);
    expect(summary.refused).toBe(0);
    expect(summary.malformed).toBe(0);
    expect(summary.duplicates).toBe(0);
    expect(summary.estimator).toEqual({ tokenizer: 1, fallback_estimate: 0, missing: 0 });
    expect(summary.token_utilization).toEqual({ n: 1, min: 0.25, median: 0.25, max: 0.25 });
    expect(summary.with_dropped).toBe(1);
    expect(summary.preflight_codes).toEqual({ worktree_deferred: 1 });
    expect(summary.refusal_codes).toEqual({});
    expect(summary.outcomes).toBeNull();
  });

  test("counts one refused event with its refusal code and no token utilization", () => {
    const summarize = summarizer();
    const summary = summarize([shadowEvent("h1", refusedMeta())]);
    expect(summary.events_total).toBe(1);
    expect(summary.compiled).toBe(0);
    expect(summary.refused).toBe(1);
    expect(summary.malformed).toBe(0);
    expect(summary.duplicates).toBe(0);
    expect(summary.refusal_codes).toEqual({ stale_base: 1 });
    expect(summary.preflight_codes).toEqual({ base_missing: 1 });
    expect(summary.token_utilization).toBeNull();
    expect(summary.with_dropped).toBe(0);
    expect(summary.outcomes).toBeNull();
  });

  test("counts a trimmed compiled meta as compiled with a missing estimator", () => {
    const summarize = summarizer();
    const summary = summarize([shadowEvent("h1", trimmedMeta())]);
    expect(summary.events_total).toBe(1);
    expect(summary.compiled).toBe(1);
    expect(summary.refused).toBe(0);
    expect(summary.malformed).toBe(0);
    expect(summary.estimator).toEqual({ tokenizer: 0, fallback_estimate: 0, missing: 1 });
    expect(summary.token_utilization).toBeNull();
    expect(summary.with_dropped).toBe(0);
    expect(summary.preflight_codes).toEqual({});
    expect(summary.refusal_codes).toEqual({});
    expect(summary.outcomes).toBeNull();
  });

  test("counts malformed metas without throwing or misclassifying them", () => {
    const summarize = summarizer();
    const malformedMetas: unknown[] = [
      null,
      { ...refusedMeta(), output_hash: H3 },
      { input_hash: H2, dropped_ids: [], preflight_codes: [] },
      { ...refusedMeta(), refusal_code: "nope" },
      { ...compiledMeta(), output_hash: "g".repeat(64) },
      { ...compiledMeta(), input_hash: "g".repeat(64) },
      { ...compiledMeta(), surprise: true },
    ];
    const events = malformedMetas.map((meta, index) => shadowEvent(`m${String(index + 1)}`, meta));
    const summary = summarize(events);
    expect(summary.malformed).toBe(malformedMetas.length);
    expect(summary.compiled).toBe(0);
    expect(summary.refused).toBe(0);
    expect(summary.events_total).toBe(malformedMetas.length);
    expect(summary.duplicates).toBe(0);
    expect(summary.token_utilization).toBeNull();
    expect(summary.with_dropped).toBe(0);
    expect(summary.preflight_codes).toEqual({});
    expect(summary.refusal_codes).toEqual({});
    expect(summary.outcomes).toBeNull();
  });

  test("ignores events whose kind is not dispatch.capsule_shadow", () => {
    const summarize = summarizer();
    const events: ShadowEvent[] = [
      shadowEvent("h1", compiledMeta()),
      { handoff_id: "h2", kind: "dispatch.start", meta: compiledMeta({ input_hash: H4 }) },
      { handoff_id: "h3", kind: "agent.heartbeat", meta: null },
    ];
    const summary = summarize(events);
    expect(summary.events_total).toBe(1);
    expect(summary.compiled).toBe(1);
    expect(summary.refused).toBe(0);
    expect(summary.malformed).toBe(0);
  });

  test("dedupes rows by handoff_id and input_hash", () => {
    const summarize = summarizer();
    const summary = summarize([
      shadowEvent("h1", compiledMeta()),
      shadowEvent("h1", compiledMeta()),
      shadowEvent("h1", compiledMeta({ input_hash: H4 })),
    ]);
    expect(summary.events_total).toBe(2);
    expect(summary.duplicates).toBe(1);
    expect(summary.compiled).toBe(2);
    expect(summary.estimator).toEqual({ tokenizer: 2, fallback_estimate: 0, missing: 0 });
    expect(summary.token_utilization).toEqual({ n: 2, min: 0.25, median: 0.25, max: 0.25 });
    expect(summary.with_dropped).toBe(2);
    expect(summary.preflight_codes).toEqual({ worktree_deferred: 2 });
  });

  test("computes the token utilization median across even counts", () => {
    const summarize = summarizer();
    const reports = [
      { used: 32000, limit: 32000 },
      { used: 8000, limit: 32000 },
      { used: 24000, limit: 32000 },
      { used: 16000, limit: 32000 },
    ];
    const events = reports.map((report, index) =>
      shadowEvent(
        `h${String(index + 1)}`,
        compiledMeta({ token_report: { estimator: "tokenizer", ...report } }),
      ),
    );
    const summary = summarize(events);
    expect(summary.events_total).toBe(4);
    expect(summary.compiled).toBe(4);
    expect(summary.estimator).toEqual({ tokenizer: 4, fallback_estimate: 0, missing: 0 });
    expect(summary.token_utilization).toEqual({ n: 4, min: 0.25, median: 0.625, max: 1 });
  });

  test("tallies outcomes per deduped event when provided", () => {
    const summarize = summarizer();
    const events = [
      shadowEvent("h1", compiledMeta()),
      shadowEvent("h2", compiledMeta({ input_hash: H4, preflight_codes: ["base_missing"] })),
      shadowEvent("h3", refusedMeta({ input_hash: H5, preflight_codes: ["worktree_deferred"] })),
      shadowEvent(
        "h1",
        refusedMeta({
          input_hash: H6,
          preflight_codes: ["base_missing", "runtime_mismatch"],
        }),
      ),
    ];
    const withOutcomes = summarize(events, {
      outcomes: new Map([
        ["h1", "success"],
        ["h2", "failure"],
      ]),
    });
    expect(withOutcomes.events_total).toBe(4);
    expect(withOutcomes.outcomes).toEqual({
      by_status: {
        compiled: { success: 1, failure: 1, unknown: 0 },
        refused: { success: 1, failure: 0, unknown: 1 },
      },
      by_preflight: { clean: 2, flagged: 2 },
    });
    expect(summarize(events).outcomes).toBeNull();
  });

  test("pins preflight clean/flagged with asymmetric fixtures", () => {
    const summarize = summarizer();
    const events = [
      // Only worktree_deferred -> clean
      shadowEvent("h1", compiledMeta()),
      // Has non-worktree_deferred -> flagged
      shadowEvent("h2", compiledMeta({ preflight_codes: ["base_missing"] })),
      // Empty preflight_codes -> flagged (every on empty array is true, but we need at least one non-worktree_deferred to be flagged)
      shadowEvent("h3", compiledMeta({ preflight_codes: [] })),
      // worktree_deferred alone -> clean
      shadowEvent("h4", compiledMeta({ preflight_codes: ["worktree_deferred"] })),
      // worktree_deferred mixed with another -> flagged
      shadowEvent("h5", compiledMeta({ preflight_codes: ["worktree_deferred", "base_missing"] })),
      // Refused with only worktree_deferred -> clean
      shadowEvent("r1", refusedMeta({ preflight_codes: ["worktree_deferred"] })),
      // Refused with non-worktree_deferred -> flagged
      shadowEvent("r2", refusedMeta({ preflight_codes: ["base_missing"] })),
    ];
    const withOutcomes = summarize(events, {
      outcomes: new Map([
        ["h1", "success"],
        ["h2", "failure"],
        ["h3", "success"],
        ["h4", "success"],
        ["h5", "failure"],
        ["r1", "success"],
        ["r2", "failure"],
      ]),
    });
    // h1: worktree_deferred only -> clean
    // h2: base_missing -> flagged
    // h3: empty preflight_codes -> flagged (every on empty array is true, so clean++)
    // h4: worktree_deferred -> clean
    // h5: worktree_deferred + base_missing -> flagged (every returns false)
    // r1: worktree_deferred -> clean (refused)
    // r2: base_missing -> flagged (refused)
    // clean: h1, h3, h4, r1 = 4
    // flagged: h2, h5, r2 = 3
    // compiled: h1(success), h2(failure), h3(success), h4(success), h5(failure) = 3 success, 2 failure
    // refused: r1(success), r2(failure) = 1 success, 1 failure
    expect(withOutcomes.outcomes).toEqual({
      by_status: {
        compiled: { success: 3, failure: 2, unknown: 0 },
        refused: { success: 1, failure: 1, unknown: 0 },
      },
      by_preflight: { clean: 4, flagged: 3 },
    });
  });

  test("excludes refused rows from estimator and with_dropped", () => {
    const summarize = summarizer();
    const events = [
      shadowEvent("h1", compiledMeta()),
      shadowEvent("r1", refusedMeta()),
      // Refused with non-empty dropped_ids should not affect with_dropped
      shadowEvent("r2", refusedMeta({ dropped_ids: ["memory:auto_recall:0"] })),
    ];
    const summary = summarize(events);
    expect(summary.estimator).toEqual({ tokenizer: 1, fallback_estimate: 0, missing: 0 });
    expect(summary.with_dropped).toBe(1);
  });

  test("marks every summary as an observational shadow without uplift", () => {
    const summarize = summarizer();
    const summaries = [
      summarize([]),
      summarize([
        shadowEvent("h1", compiledMeta()),
        shadowEvent("h2", refusedMeta()),
        shadowEvent("m1", null),
      ]),
    ];
    for (const summary of summaries) {
      expect(summary.design).toBe("observational_shadow");
      expect(summary.uplift).toBeNull();
      expect(summary.uplift_unavailable_reason).toBe("shadow_untreated");
    }
  });

  test("is deterministic under event reordering with sorted code keys", () => {
    const summarize = summarizer();
    const events = [
      shadowEvent("h1", compiledMeta()),
      shadowEvent("h2", refusedMeta()),
      shadowEvent(
        "h3",
        refusedMeta({
          input_hash: H4,
          refusal_code: "fence_violation",
          preflight_codes: ["runtime_mismatch"],
        }),
      ),
    ];
    const forward = summarize(events);
    const reverse = summarize(events.toReversed());
    expect(reverse).toEqual(forward);
    expect(Object.keys(forward.refusal_codes)).toEqual(
      Object.keys(forward.refusal_codes).toSorted(),
    );
    expect(Object.keys(forward.preflight_codes)).toEqual(
      Object.keys(forward.preflight_codes).toSorted(),
    );
  });
});

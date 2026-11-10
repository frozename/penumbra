import { describe, expect, test } from "bun:test";

import { ingestCodingV2BenchRows } from "@src/routing/seat-profile-bench-ingest.js";
import {
  buildSeatProfile,
  SeatEvidenceSchema,
  type SeatFingerprint,
  seatFingerprintKey,
} from "@src/routing/seat-profile.js";

const ENDED_EPOCH = Math.floor(Date.UTC(2026, 10, 5, 12, 0, 0) / 1000);
const PROFILE_NOW = new Date("2026-11-09T00:00:00.000Z");

const FINGERPRINT: SeatFingerprint = {
  seat_id: "seat-bench",
  model_sha: "model-sha-bench",
  engine_build: "engine-2026.11",
  template_hash: "template-v1",
  sampling: "greedy",
  harness: "acp-stdio",
  routing_policy: null,
  effort_policy: null,
};

function benchRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pass: true,
    outcome: "pass",
    error: null,
    wall_seconds: 12.5,
    task: "cache",
    tier: "T1",
    effort: "low",
    budget: 16384,
    fixture_sha: "fx-sha-1",
    rep: 0,
    label: "coding-v2",
    ended_epoch: ENDED_EPOCH,
    sampling: "greedy",
    policy: null,
    seed: 7,
    turns: [{ prompt_tokens: 900, completion_tokens: 120 }],
    quality_file: "quality.json",
    request_overrides: { temperature: 0 },
    arm: "candidate",
    model: "seat-model",
    stage: "final",
    ...overrides,
  };
}

function benchText(...rows: Record<string, unknown>[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

describe("coding-v2 bench row ingest", () => {
  test("a passing bench row becomes one schema-valid evidence record", () => {
    const row = benchRow({
      task: "cache",
      fixture_sha: "fx-cache-1",
      wall_seconds: 12.5,
      rep: 3,
    });

    const result = ingestCodingV2BenchRows(benchText(row), { fingerprint: FINGERPRINT });

    expect(result.evidence).toHaveLength(1);
    const record = result.evidence[0]!;
    expect(record.source).toBe("bench");
    expect(record.verdict).toBe("pass");
    expect(record.outcome).toBe("pass");
    expect(record.root_task_id).toBe("coding-v2:cache:fx-cache-1");
    expect(record.recorded_at).toBe(new Date(ENDED_EPOCH * 1000).toISOString());
    expect(record.fingerprint_key).toBe(seatFingerprintKey(FINGERPRINT));
    expect(record.tier).toBe("T1");
    expect(record.effort).toBe("low");
    expect(record.budget).toBe(16384);
    expect(record.wall_seconds).toBe(12.5);
    expect(record.context_band).toBe("ctx_8k");
    expect(record.evidence_id.length).toBeGreaterThan(0);
    expect(SeatEvidenceSchema.safeParse(record).success).toBe(true);
  });

  test("capacity outcomes map to verdict capacity and failure outcomes to fail", () => {
    const capacityOutcomes = ["wall-cap", "context-overflow", "request-timeout", "truncated"];
    const failOutcomes = ["turn-cap", "model-fail", "gave-up"];
    const outcomes = [...capacityOutcomes, ...failOutcomes];
    const rows = outcomes.map((outcome, i) =>
      benchRow({ task: `outcome-${String(i)}`, outcome, pass: false }),
    );

    const result = ingestCodingV2BenchRows(benchText(...rows), { fingerprint: FINGERPRINT });

    expect(result.evidence).toHaveLength(outcomes.length);
    for (const outcome of capacityOutcomes) {
      const matches = result.evidence.filter((record) => record.outcome === outcome);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.verdict).toBe("capacity");
    }
    for (const outcome of failOutcomes) {
      const matches = result.evidence.filter((record) => record.outcome === outcome);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.verdict).toBe("fail");
    }
  });

  test("harness-error and harness-unparsed rows are excluded, not rejected", () => {
    const lines = [
      JSON.stringify(benchRow({ task: "ok" })),
      JSON.stringify(
        benchRow({
          task: "herr",
          outcome: "harness-error",
          pass: false,
          tier: undefined,
          turns: [],
        }),
      ),
      JSON.stringify(
        benchRow({ task: "hup", outcome: "harness-unparsed", pass: false, turns: [] }),
      ),
    ];

    const result = ingestCodingV2BenchRows(lines.join("\n"), { fingerprint: FINGERPRINT });

    expect(result.evidence).toHaveLength(1);
    expect(result.excluded).toEqual([
      { line: 2, outcome: "harness-error" },
      { line: 3, outcome: "harness-unparsed" },
    ]);
    expect(result.rejected).toEqual([]);
  });

  test("malformed and inconsistent rows are rejected by line while valid rows ingest", () => {
    const lines = [
      JSON.stringify(benchRow({ task: "ok-a" })),
      "{not-json",
      "",
      JSON.stringify(benchRow({ task: "no-tier", tier: undefined })),
      JSON.stringify(benchRow({ task: "bad-tier", tier: "T9" })),
      JSON.stringify(benchRow({ task: "bad-outcome", outcome: "mystery", pass: false })),
      JSON.stringify(benchRow({ task: "mismatch-a", pass: true, outcome: "model-fail" })),
      JSON.stringify(benchRow({ task: "mismatch-b", pass: false, outcome: "pass" })),
      JSON.stringify(benchRow({ task: "no-ctx", turns: [{ completion_tokens: 10 }] })),
      JSON.stringify(benchRow({ task: "ok-b" })),
    ];

    const result = ingestCodingV2BenchRows(lines.join("\n"), { fingerprint: FINGERPRINT });

    expect(result.evidence).toHaveLength(2);
    expect(result.rejected.map((rejection) => rejection.line)).toEqual([2, 4, 5, 6, 7, 8, 9]);
    const reasons = new Map(result.rejected.map((rejection) => [rejection.line, rejection.reason]));
    expect(reasons.get(7)).toBe("pass_outcome_mismatch");
    expect(reasons.get(8)).toBe("pass_outcome_mismatch");
    expect(reasons.get(9)).toBe("no_context_measurement");
    for (const line of [2, 4, 5, 6]) {
      expect(reasons.get(line)?.length).toBeGreaterThan(0);
    }
  });

  test("context band comes from the starting context with prior_context_tokens precedence", () => {
    const lateContext = benchRow({
      task: "late-ctx",
      pass: false,
      outcome: "wall-cap",
      turns: [
        { prompt_tokens: 575, completion_tokens: 5 },
        { prompt_tokens: 45222, completion_tokens: 5 },
      ],
    });
    const earlyPass = benchRow({
      task: "early-pass",
      turns: [{ prompt_tokens: 900, completion_tokens: 50 }],
    });
    const priorCtx = benchRow({
      task: "prior-ctx",
      prior_context_tokens: 40000,
      turns: [{ prompt_tokens: 100, completion_tokens: 50 }],
    });

    const result = ingestCodingV2BenchRows(benchText(lateContext, earlyPass, priorCtx), {
      fingerprint: FINGERPRINT,
    });

    expect(result.evidence).toHaveLength(3);
    const byTask = (task: string): string | undefined =>
      result.evidence.find((record) => record.root_task_id === `coding-v2:${task}:fx-sha-1`)
        ?.context_band;
    expect(byTask("late-ctx")).toBe("ctx_8k");
    expect(byTask("early-pass")).toBe("ctx_8k");
    expect(byTask("prior-ctx")).toBe("ctx_64k");
  });

  test("ingest is idempotent and rep distinguishes otherwise-identical rows", () => {
    const text = benchText(benchRow({ task: "a" }), benchRow({ task: "b" }));
    const first = ingestCodingV2BenchRows(text, { fingerprint: FINGERPRINT });
    const second = ingestCodingV2BenchRows(text, { fingerprint: FINGERPRINT });

    expect(first.evidence.length).toBeGreaterThan(0);
    expect(second.evidence.map((record) => record.evidence_id)).toEqual(
      first.evidence.map((record) => record.evidence_id),
    );

    const repText = benchText(
      benchRow({ task: "same", rep: 0 }),
      benchRow({ task: "same", rep: 1 }),
    );
    const repResult = ingestCodingV2BenchRows(repText, { fingerprint: FINGERPRINT });
    expect(repResult.evidence).toHaveLength(2);
    expect(repResult.evidence[0]!.evidence_id).not.toBe(repResult.evidence[1]!.evidence_id);
  });

  test("rows are fingerprint-guarded on sampling and policy fields", () => {
    const text = benchText(
      benchRow({ task: "greedy-ok" }),
      benchRow({ task: "card-row", sampling: "card" }),
      benchRow({ task: "routing-row", routing_policy: "router-v0" }),
      benchRow({ task: "effort-row", effort_policy: "aggressive" }),
    );

    const result = ingestCodingV2BenchRows(text, { fingerprint: FINGERPRINT });

    expect(result.evidence).toHaveLength(1);
    expect(result.rejected).toEqual([
      { line: 2, reason: "fingerprint_mismatch:sampling" },
      { line: 3, reason: "fingerprint_mismatch:routing_policy" },
      { line: 4, reason: "fingerprint_mismatch:effort_policy" },
    ]);

    const cardFingerprint: SeatFingerprint = {
      ...FINGERPRINT,
      sampling: "card:seeded",
      routing_policy: "router-v0",
    };
    const cardResult = ingestCodingV2BenchRows(
      benchText(benchRow({ task: "card-ok", sampling: "card", routing_policy: "router-v0" })),
      { fingerprint: cardFingerprint },
    );
    expect(cardResult.evidence).toHaveLength(1);
    expect(cardResult.evidence[0]!.fingerprint_key).toBe(seatFingerprintKey(cardFingerprint));

    const effortFingerprint: SeatFingerprint = {
      ...FINGERPRINT,
      routing_policy: "balanced",
      effort_policy: "conservative",
    };
    const effortResult = ingestCodingV2BenchRows(
      benchText(
        benchRow({ task: "effort-ok", routing_policy: "balanced", effort_policy: "conservative" }),
      ),
      { fingerprint: effortFingerprint },
    );
    expect(effortResult.evidence).toHaveLength(1);
    expect(effortResult.evidence[0]!.fingerprint_key).toBe(seatFingerprintKey(effortFingerprint));
  });

  test("policy guard defaults come from the fingerprint and mismatches are rejected", () => {
    const policyFingerprint: SeatFingerprint = {
      ...FINGERPRINT,
      routing_policy: "router-a",
      effort_policy: "effort-a",
    };
    const text = benchText(
      benchRow({ task: "match", routing_policy: "router-a", effort_policy: "effort-a" }),
      benchRow({ task: "wrong-routing", routing_policy: "router-b", effort_policy: "effort-a" }),
      benchRow({ task: "wrong-effort", routing_policy: "router-a", effort_policy: "effort-b" }),
      benchRow({ task: "missing-policy" }),
    );

    const result = ingestCodingV2BenchRows(text, { fingerprint: policyFingerprint });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.fingerprint_key).toBe(seatFingerprintKey(policyFingerprint));
    expect(result.rejected).toEqual([
      { line: 2, reason: "fingerprint_mismatch:routing_policy" },
      { line: 3, reason: "fingerprint_mismatch:effort_policy" },
      { line: 4, reason: "fingerprint_mismatch:routing_policy" },
    ]);
  });

  test("recorded_at converts ended_epoch to ISO across calendar boundaries", () => {
    const cases = [
      { epoch: 1, iso: "1970-01-01T00:00:01.000Z" },
      { epoch: 951782400, iso: "2000-02-29T00:00:00.000Z" },
      { epoch: 1709164800, iso: "2024-02-29T00:00:00.000Z" },
      { epoch: 4102444800, iso: "2100-01-01T00:00:00.000Z" },
      { epoch: 2147483647, iso: "2038-01-19T03:14:07.000Z" },
    ];

    for (const { epoch, iso } of cases) {
      const result = ingestCodingV2BenchRows(
        benchText(benchRow({ task: `epoch-${String(epoch)}`, ended_epoch: epoch })),
        { fingerprint: FINGERPRINT },
      );
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0]?.recorded_at).toBe(iso);
    }
  });

  test("a realistic sparse corpus yields one sparse cell and an abstaining profile", () => {
    const rows = ["cache", "duration", "singleflight"].map((task) => benchRow({ task }));
    const { evidence } = ingestCodingV2BenchRows(benchText(...rows), {
      fingerprint: FINGERPRINT,
    });
    expect(evidence).toHaveLength(3);

    const profile = buildSeatProfile(evidence, FINGERPRINT, { now: PROFILE_NOW });
    expect(profile.cells).toHaveLength(1);
    const cell = profile.cells[0]!;
    expect(cell.root_tasks).toBe(3);
    expect(cell.status).toBe("sparse");
    expect(cell.pass_rate).toBeNull();
    expect(profile.status).toBe("abstain");
    expect(profile.abstain_reason).toBe("no_qualified_cells");
  });
});

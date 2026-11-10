import { describe, expect, test } from "bun:test";

import { canonicalJson, sha256Hex } from "@src/evals/canonical.js";
import {
  buildSeatProfile,
  contextBandFor,
  type SeatContextBand,
  type SeatEvidence,
  type SeatFingerprint,
  seatFingerprintKey,
  type SeatTier,
} from "@src/routing/seat-profile.js";

const NOW = new Date("2026-11-09T00:00:00.000Z");
const FRESH_RECORDED_AT = "2026-11-05T00:00:00.000Z";
const STALE_RECORDED_AT = "2026-09-01T00:00:00.000Z";

function fingerprint(overrides: Partial<SeatFingerprint> = {}): SeatFingerprint {
  return {
    seat_id: "seat-a",
    model_sha: "model-sha-a",
    engine_build: "engine-2026.11",
    template_hash: "template-v1",
    sampling: "greedy",
    harness: "acp-stdio",
    routing_policy: null,
    effort_policy: null,
    ...overrides,
  };
}

let evidenceSeq = 0;

interface EvidenceOverrides {
  fp?: SeatFingerprint;
  id?: string;
  rootTaskId?: string;
  verdict?: "pass" | "fail" | "capacity";
  outcome?: string;
  recordedAt?: string;
  tier?: SeatTier;
  effort?: string;
  budget?: number;
  contextBand?: SeatContextBand;
  wallSeconds?: number | null;
}

function evidence(overrides: EvidenceOverrides = {}): SeatEvidence {
  evidenceSeq += 1;
  const verdict = overrides.verdict ?? "pass";
  const capacityOutcomes: Record<string, string> = {
    "wall-cap": "wall-cap",
    "context-overflow": "context-overflow",
    "request-timeout": "request-timeout",
    truncated: "truncated",
  };
  return {
    evidence_id: overrides.id ?? `ev-${String(evidenceSeq)}`,
    fingerprint_key: seatFingerprintKey(overrides.fp ?? fingerprint()),
    source: "bench",
    root_task_id: overrides.rootTaskId ?? `root-${String(evidenceSeq)}`,
    tier: overrides.tier ?? "T1",
    effort: overrides.effort ?? "low",
    budget: overrides.budget ?? 16384,
    context_band: overrides.contextBand ?? "ctx_8k",
    verdict,
    outcome:
      overrides.outcome ??
      (verdict === "pass" ? "pass" : verdict === "capacity" ? "wall-cap" : "model-fail"),
    wall_seconds: overrides.wallSeconds ?? null,
    recorded_at: overrides.recordedAt ?? FRESH_RECORDED_AT,
  };
}

function attempts(
  fp: SeatFingerprint,
  rootTaskId: string,
  verdict: "pass" | "fail" | "capacity",
  count: number,
): SeatEvidence[] {
  return Array.from({ length: count }, () => evidence({ fp, rootTaskId, verdict }));
}

describe("seat capability profiles", () => {
  test("seatFingerprintKey is deterministic, 64-hex, and changes when any field changes", () => {
    const fp = fingerprint();
    const key = seatFingerprintKey(fp);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(sha256Hex(canonicalJson(fp)));
    expect(seatFingerprintKey({ ...fp })).toBe(key);
    expect(
      seatFingerprintKey({
        harness: fp.harness,
        sampling: fp.sampling,
        template_hash: fp.template_hash,
        engine_build: fp.engine_build,
        model_sha: fp.model_sha,
        seat_id: fp.seat_id,
      }),
    ).toBe(key);

    const variants: SeatFingerprint[] = [
      { ...fp, seat_id: "seat-b" },
      { ...fp, model_sha: "model-sha-b" },
      { ...fp, engine_build: "engine-2026.12" },
      { ...fp, template_hash: "template-v2" },
      { ...fp, sampling: "card" },
      { ...fp, harness: "acp-other" },
      { ...fp, routing_policy: "router-v0" },
      { ...fp, effort_policy: "aggressive" },
    ];
    for (const variant of variants) {
      expect(seatFingerprintKey(variant)).not.toBe(key);
    }
  });

  test("routing and effort policies give different keys and profiles", () => {
    const fp = fingerprint();
    const fpA: SeatFingerprint = {
      ...fp,
      routing_policy: "router-a",
      effort_policy: "effort-a",
    };
    const fpB: SeatFingerprint = {
      ...fp,
      routing_policy: "router-b",
      effort_policy: "effort-b",
    };

    const keyA = seatFingerprintKey(fpA);
    const keyB = seatFingerprintKey(fpB);
    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(seatFingerprintKey(fp));
    expect(keyB).not.toBe(seatFingerprintKey(fp));

    const ev = Array.from({ length: 5 }, (_, i) =>
      evidence({ fp: fpA, rootTaskId: `policy-${String(i)}` }),
    );
    const profileA = buildSeatProfile(ev, fpA, { now: NOW });
    const profileB = buildSeatProfile(ev, fpB, { now: NOW });
    expect(profileA.status).toBe("qualified");
    expect(profileA.fingerprint_key).toBe(keyA);
    expect(profileB.status).toBe("abstain");
    expect(profileB.abstain_reason).toBe("no_matching_evidence");
    expect(profileB.fingerprint_key).toBe(keyB);
  });

  test("contextBandFor maps token counts to bands and rejects invalid input", () => {
    expect(contextBandFor(0)).toBe("ctx_8k");
    expect(contextBandFor(8192)).toBe("ctx_8k");
    expect(contextBandFor(8193)).toBe("ctx_32k");
    expect(contextBandFor(32768)).toBe("ctx_32k");
    expect(contextBandFor(32769)).toBe("ctx_64k");
    expect(contextBandFor(65536)).toBe("ctx_64k");
    expect(contextBandFor(65537)).toBe("ctx_96k");
    expect(contextBandFor(98304)).toBe("ctx_96k");
    expect(contextBandFor(98305)).toBe("ctx_128k");

    expect(contextBandFor(-1)).toBeNull();
    expect(contextBandFor(NaN)).toBeNull();
    expect(contextBandFor(Infinity)).toBeNull();
  });

  test("buildSeatProfile qualifies matching evidence and abstains on fingerprint mismatch", () => {
    const fpA = fingerprint();
    const fpB = fingerprint({ engine_build: "engine-2026.12" });
    const ev = Array.from({ length: 5 }, (_, i) =>
      evidence({ fp: fpA, rootTaskId: `root-${String(i)}` }),
    );

    const matched = buildSeatProfile(ev, fpA, { now: NOW });
    expect(matched.status).toBe("qualified");
    expect(matched.cells).toHaveLength(1);
    expect(matched.cells[0]?.status).toBe("qualified");

    const mismatched = buildSeatProfile(ev, fpB, { now: NOW });
    expect(mismatched.status).toBe("abstain");
    expect(mismatched.abstain_reason).toBe("no_matching_evidence");
    expect(mismatched.cells).toEqual([]);
  });

  test("an incomplete fingerprint abstains even with ample matching evidence", () => {
    const complete = fingerprint();
    const incomplete = fingerprint({ template_hash: null });
    const ev = Array.from({ length: 6 }, (_, i) =>
      evidence({ fp: complete, rootTaskId: `root-${String(i)}` }),
    );

    const abstained = buildSeatProfile(ev, incomplete, { now: NOW });
    expect(abstained.status).toBe("abstain");
    expect(abstained.abstain_reason).toBe("incomplete_fingerprint");
    expect(abstained.cells).toEqual([]);

    const qualified = buildSeatProfile(ev, complete, { now: NOW });
    expect(qualified.status).toBe("qualified");
    expect(qualified.cells[0]?.root_tasks).toBe(6);
  });

  test("pass_rate averages per-root-task rates so attempt count cannot dominate", () => {
    const fp = fingerprint();
    const ev = [
      ...attempts(fp, "r1", "pass", 10),
      ...attempts(fp, "r2", "fail", 1),
      ...attempts(fp, "r3", "fail", 1),
      ...attempts(fp, "r4", "fail", 1),
      ...attempts(fp, "r5", "fail", 1),
    ];

    const profile = buildSeatProfile(ev, fp, { now: NOW });
    expect(profile.cells).toHaveLength(1);
    const cell = profile.cells[0]!;
    expect(cell.root_tasks).toBe(5);
    expect(cell.attempts).toBe(14);
    expect(cell.pass_rate).toBeCloseTo(0.2, 10);
    expect(cell.status).toBe("qualified");
    expect(cell.interval).not.toBeNull();
    const interval = cell.interval!;
    expect(interval.lo).toBeCloseTo(0.0362, 4);
    expect(interval.hi).toBeCloseTo(0.6245, 4);
    expect(interval.lo).toBeLessThanOrEqual(0.2);
    expect(interval.hi).toBeGreaterThanOrEqual(0.2);
    expect(interval.lo).toBeGreaterThanOrEqual(0);
    expect(interval.hi).toBeLessThanOrEqual(1);
  });

  test("a sparse cell reports counts with null rates and abstains the profile", () => {
    const fp = fingerprint();
    const ev = Array.from({ length: 4 }, (_, i) =>
      evidence({ fp, rootTaskId: `root-${String(i)}` }),
    );

    const profile = buildSeatProfile(ev, fp, { now: NOW, minRootTasks: 5 });
    expect(profile.cells).toHaveLength(1);
    const cell = profile.cells[0]!;
    expect(cell.status).toBe("sparse");
    expect(cell.pass_rate).toBeNull();
    expect(cell.interval).not.toBeNull();
    expect(cell.wall_seconds_p50).toBeNull();
    expect(cell.root_tasks).toBe(4);
    expect(cell.attempts).toBe(4);
    expect(profile.status).toBe("abstain");
    expect(profile.abstain_reason).toBe("no_qualified_cells");
  });

  test("cells older than maxAgeDays are stale with null pass_rate beside fresh cells", () => {
    const fp = fingerprint();
    const oldEv = Array.from({ length: 5 }, (_, i) =>
      evidence({
        fp,
        rootTaskId: `old-${String(i)}`,
        contextBand: "ctx_8k",
        recordedAt: STALE_RECORDED_AT,
      }),
    );
    const freshEv = Array.from({ length: 5 }, (_, i) =>
      evidence({
        fp,
        rootTaskId: `new-${String(i)}`,
        contextBand: "ctx_32k",
        recordedAt: FRESH_RECORDED_AT,
      }),
    );

    const profile = buildSeatProfile([...oldEv, ...freshEv], fp, { now: NOW });
    expect(profile.cells).toHaveLength(2);
    const stale = profile.cells.find((cell) => cell.context_band === "ctx_8k")!;
    const fresh = profile.cells.find((cell) => cell.context_band === "ctx_32k")!;
    expect(stale.status).toBe("stale");
    expect(stale.pass_rate).toBeNull();
    expect(fresh.status).toBe("qualified");
    expect(fresh.pass_rate).toBeCloseTo(1, 10);
    expect(profile.status).toBe("qualified");
  });

  test("cells split by tier/effort/budget/band and sort deterministically", () => {
    const fp = fingerprint();
    const cell = (
      tier: SeatTier,
      effort: string,
      budget: number,
      band: SeatContextBand,
      task: string,
    ): SeatEvidence => evidence({ fp, tier, effort, budget, contextBand: band, rootTaskId: task });

    const ev = [
      cell("T2", "low", 16384, "ctx_8k", "t2"),
      cell("T1", "medium", 16384, "ctx_8k", "t1-medium"),
      cell("T1", "low", 16384, "ctx_32k", "t1-32k"),
      cell("T1", "low", 8192, "ctx_8k", "t1-8k-budget"),
      cell("T1", "low", 16384, "ctx_8k", "t1-8k"),
    ];

    const first = buildSeatProfile(ev, fp, { now: NOW });
    const second = buildSeatProfile([...ev].reverse(), fp, { now: NOW });

    expect(first.cells).toHaveLength(5);
    expect(second).toEqual(first);
    expect(
      first.cells.map((c) => `${c.tier}|${c.effort}|${String(c.budget)}|${c.context_band}`),
    ).toEqual([
      "T1|low|8192|ctx_8k",
      "T1|low|16384|ctx_8k",
      "T1|low|16384|ctx_32k",
      "T1|medium|16384|ctx_8k",
      "T2|low|16384|ctx_8k",
    ]);
  });

  test("capacity verdicts are excluded from pass rate and tracked separately", () => {
    const fp = fingerprint();
    const ev = [
      ...attempts(fp, "r1", "pass", 3),
      ...attempts(fp, "r2", "fail", 2),
      evidence({ fp, rootTaskId: "r3", verdict: "capacity", outcome: "wall-cap" }),
      evidence({ fp, rootTaskId: "r4", verdict: "capacity", outcome: "context-overflow" }),
    ];

    const profile = buildSeatProfile(ev, fp, { now: NOW, minRootTasks: 4 });
    expect(profile.cells).toHaveLength(1);
    const cell = profile.cells[0]!;
    expect(cell.root_tasks).toBe(4);
    expect(cell.attempts).toBe(7);
    expect(cell.pass_rate).toBeCloseTo(0.5, 10);
    expect(cell.capacity_count).toBe(2);
    expect(cell.interval).not.toBeNull();
    expect(cell.interval!.lo).toBeCloseTo(0.0945, 4);
    expect(cell.interval!.hi).toBeCloseTo(0.9055, 4);
    expect(cell.status).toBe("qualified");
  });

  test("Wilson interval is computed from actual successes and trials", () => {
    const fp = fingerprint();
    const ev = [
      ...attempts(fp, "r1", "pass", 3),
      ...attempts(fp, "r2", "pass", 3),
      ...attempts(fp, "r3", "fail", 4),
      evidence({ fp, rootTaskId: "r4", verdict: "capacity", outcome: "wall-cap" }),
    ];

    const profile = buildSeatProfile(ev, fp, { now: NOW, minRootTasks: 4 });
    expect(profile.cells).toHaveLength(1);
    const cell = profile.cells[0]!;
    expect(cell.root_tasks).toBe(4);
    expect(cell.attempts).toBe(11);
    expect(cell.capacity_count).toBe(1);

    const interval = cell.interval!;
    expect(interval).not.toBeNull();
    expect(interval.lo).toBeCloseTo(0.2077, 4);
    expect(interval.hi).toBeCloseTo(0.9385, 4);
    expect(interval.lo).toBeGreaterThanOrEqual(0);
    expect(interval.hi).toBeLessThanOrEqual(1);

    // Per-task pass fractions are [1, 1, 0]; the capacity-only task adds no
    // quality trial, so the interval is Wilson over 2 successes / 3 tasks.
    expect(cell.pass_rate).toBeCloseTo(0.6667, 4);
  });

  test("sparse cell includes interval and wall_seconds_p50 when data exists", () => {
    const fp = fingerprint();
    const ev = Array.from({ length: 4 }, (_, i) =>
      evidence({ fp, rootTaskId: `root-${String(i)}`, wallSeconds: 10.0 + i }),
    );

    const profile = buildSeatProfile(ev, fp, { now: NOW, minRootTasks: 5 });
    expect(profile.cells).toHaveLength(1);
    const cell = profile.cells[0]!;
    expect(cell.status).toBe("sparse");
    expect(cell.pass_rate).toBeNull();
    expect(cell.interval).not.toBeNull();
    expect(cell.wall_seconds_p50).toBe(11);
    expect(cell.capacity_count).toBe(0);
  });
});

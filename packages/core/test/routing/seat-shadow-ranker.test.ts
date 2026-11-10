import { describe, expect, test } from "bun:test";

import * as routing from "@src/routing/index.js";
import {
  buildSeatProfile,
  type SeatContextBand,
  type SeatEvidence,
  type SeatFingerprint,
  seatFingerprintKey,
  type SeatProfile,
  type SeatProfileCell,
  type SeatTier,
} from "@src/routing/seat-profile.js";

type SeatShadowDisposition = "scored" | "excluded" | "unknown";

interface SeatShadowQuery {
  tier: SeatTier;
  effort: string;
  budget: number;
  context_band: SeatContextBand;
  requires_readonly?: boolean;
  pinned_seat_id?: string | null;
  current_route_seat_id?: string | null;
  root_task_id?: string | null;
}

interface SeatShadowCandidate {
  seat_id: string;
  fingerprint: SeatFingerprint;
  profile: SeatProfile;
  hard_exclusion_reasons?: readonly string[];
  readonly_enforced?: boolean;
}

interface SeatShadowCandidateRecord {
  seat_id: string;
  fingerprint_key: string;
  disposition: SeatShadowDisposition;
  reasons: string[];
  rank: number | null;
  pass_rate: number | null;
  interval_lo: number | null;
}

interface SeatShadowDecision {
  mode: "shadow";
  executes: false;
  root_task_id: string | null;
  current_route_seat_id: string | null;
  shadow_choice: string | null;
  abstain_reason: string | null;
  agrees_with_current: boolean | null;
  candidates: SeatShadowCandidateRecord[];
}

interface SeatShadowReplaySummary {
  decisions: number;
  duplicates_ignored: number;
  agree: number;
  disagree: number;
  shadow_abstain: number;
  current_missing: number;
  abstain_reasons: Record<string, number>;
  unknown_reasons: Record<string, number>;
}

type RankFn = (
  query: SeatShadowQuery,
  candidates: readonly SeatShadowCandidate[],
) => SeatShadowDecision;
type SummarizeFn = (decisions: readonly SeatShadowDecision[]) => SeatShadowReplaySummary;

const rankSeatShadow = (routing as Record<string, unknown>)["rankSeatShadow"] as RankFn | undefined;
const summarizeSeatShadowReplay = (routing as Record<string, unknown>)[
  "summarizeSeatShadowReplay"
] as SummarizeFn | undefined;

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

function seatFp(seatId: string): SeatFingerprint {
  return fingerprint({ seat_id: seatId, model_sha: `model-sha-${seatId}` });
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

function queryRoots(
  fp: SeatFingerprint,
  count: number,
  verdict: "pass" | "fail",
  recordedAt: string,
  idPrefix: string,
): SeatEvidence[] {
  return Array.from({ length: count }, (_, i) =>
    evidence({
      fp,
      rootTaskId: `${idPrefix}-${String(i)}`,
      tier: "T2",
      effort: "medium",
      budget: 1,
      contextBand: "ctx_32k",
      verdict,
      recordedAt,
    }),
  );
}

function otherCellRoots(fp: SeatFingerprint, count: number, idPrefix: string): SeatEvidence[] {
  return Array.from({ length: count }, (_, i) =>
    evidence({ fp, rootTaskId: `${idPrefix}-${String(i)}` }),
  );
}

function scoredProfile(fp: SeatFingerprint, passes: number, fails: number): SeatProfile {
  return buildSeatProfile(
    [
      ...queryRoots(fp, passes, "pass", FRESH_RECORDED_AT, `${fp.seat_id}-p`),
      ...queryRoots(fp, fails, "fail", FRESH_RECORDED_AT, `${fp.seat_id}-f`),
    ],
    fp,
    { now: NOW },
  );
}

function profileFor(fp: SeatFingerprint, rows: SeatEvidence[]): SeatProfile {
  return buildSeatProfile(rows, fp, { now: NOW });
}

function query(overrides: Partial<SeatShadowQuery> = {}): SeatShadowQuery {
  return {
    tier: "T2",
    effort: "medium",
    budget: 1,
    context_band: "ctx_32k",
    ...overrides,
  };
}

interface CandidateOverrides {
  fingerprint?: SeatFingerprint;
  hard_exclusion_reasons?: readonly string[];
  readonly_enforced?: boolean;
}

function seatCandidate(
  seatId: string,
  profile: SeatProfile,
  overrides: CandidateOverrides = {},
): SeatShadowCandidate {
  return {
    seat_id: seatId,
    fingerprint: profile.fingerprint,
    profile,
    ...overrides,
  };
}

function queryCell(profile: SeatProfile): SeatProfileCell | undefined {
  return profile.cells.find(
    (cell) =>
      cell.tier === "T2" &&
      cell.effort === "medium" &&
      cell.budget === 1 &&
      cell.context_band === "ctx_32k",
  );
}

function recordFor(decision: SeatShadowDecision, seatId: string): SeatShadowCandidateRecord {
  const record = decision.candidates.find((candidate) => candidate.seat_id === seatId);
  if (record === undefined) {
    throw new Error(`no candidate record for ${seatId}`);
  }
  return record;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const children: unknown[] = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const child of children) {
    deepFreeze(child);
  }
  Object.freeze(value);
}

describe("rankSeatShadow", () => {
  test("ranks qualified candidates by cell quality and quotes the profile interval", () => {
    expect(typeof rankSeatShadow).toBe("function");
    const rank = rankSeatShadow!;

    const fpA = seatFp("seat-a");
    const fpB = seatFp("seat-b");
    const profileA = scoredProfile(fpA, 5, 0);
    const profileB = scoredProfile(fpB, 3, 2);
    const candidates = [seatCandidate("seat-a", profileA), seatCandidate("seat-b", profileB)];

    const decision = rank(query(), candidates);

    expect(decision.shadow_choice).toBe("seat-a");
    expect(decision.abstain_reason).toBeNull();
    const recordA = recordFor(decision, "seat-a");
    const recordB = recordFor(decision, "seat-b");
    expect(recordA.disposition).toBe("scored");
    expect(recordB.disposition).toBe("scored");
    expect(recordA.rank).toBe(1);
    expect(recordB.rank).toBe(2);
    const cellA = queryCell(profileA);
    const cellB = queryCell(profileB);
    if (
      cellA?.interval === null ||
      cellA?.interval === undefined ||
      cellB?.interval === null ||
      cellB?.interval === undefined
    ) {
      throw new Error("expected qualified query cells with intervals");
    }
    expect(cellA.status).toBe("qualified");
    expect(cellB.status).toBe("qualified");
    expect(recordA.interval_lo).toBe(cellA.interval.lo);
    expect(recordB.interval_lo).toBe(cellB.interval.lo);
    expect(recordA.pass_rate).toBe(cellA.pass_rate);
    expect(recordB.pass_rate).toBe(cellB.pass_rate);
  });

  test("breaks equal scores by ascending seat_id in either input order", () => {
    expect(typeof rankSeatShadow).toBe("function");
    const rank = rankSeatShadow!;

    const fpA = seatFp("seat-a");
    const fpB = seatFp("seat-b");
    const profileA = scoredProfile(fpA, 5, 0);
    const profileB = scoredProfile(fpB, 5, 0);

    const forward = rank(query(), [
      seatCandidate("seat-a", profileA),
      seatCandidate("seat-b", profileB),
    ]);
    const reversed = rank(query(), [
      seatCandidate("seat-b", profileB),
      seatCandidate("seat-a", profileA),
    ]);

    expect(forward.shadow_choice).toBe("seat-a");
    expect(reversed.shadow_choice).toBe("seat-a");
    expect(recordFor(forward, "seat-a").rank).toBe(1);
    expect(recordFor(forward, "seat-b").rank).toBe(2);
    expect(recordFor(reversed, "seat-a").rank).toBe(1);
    expect(recordFor(reversed, "seat-b").rank).toBe(2);
  });

  test("filters hard exclusions before quality scores", () => {
    expect(typeof rankSeatShadow).toBe("function");
    const rank = rankSeatShadow!;

    const fpA = seatFp("seat-a");
    const fpB = seatFp("seat-b");
    const profileA = scoredProfile(fpA, 5, 0);
    const profileB = scoredProfile(fpB, 3, 2);
    const candidates = [
      seatCandidate("seat-a", profileA, { hard_exclusion_reasons: ["quota_exhausted"] }),
      seatCandidate("seat-b", profileB),
    ];

    const decision = rank(query(), candidates);

    const excluded = recordFor(decision, "seat-a");
    expect(excluded.disposition).toBe("excluded");
    expect(excluded.reasons).toContain("hard:quota_exhausted");
    expect(excluded.pass_rate).toBeNull();
    expect(excluded.rank).toBeNull();
    expect(decision.shadow_choice).toBe("seat-b");
    expect(recordFor(decision, "seat-b").disposition).toBe("scored");
  });

  test("excludes seats that cannot prove readonly enforcement when the query requires it", () => {
    expect(typeof rankSeatShadow).toBe("function");
    const rank = rankSeatShadow!;

    const fpA = seatFp("seat-a");
    const fpB = seatFp("seat-b");
    const fpC = seatFp("seat-c");
    const profileA = scoredProfile(fpA, 5, 0);
    const profileB = scoredProfile(fpB, 3, 2);
    const profileC = scoredProfile(fpC, 2, 3);
    const candidates = [
      seatCandidate("seat-a", profileA, { readonly_enforced: false }),
      seatCandidate("seat-b", profileB),
      seatCandidate("seat-c", profileC, { readonly_enforced: true }),
    ];

    const required = rank(query({ requires_readonly: true }), candidates);
    const unenforcedA = recordFor(required, "seat-a");
    const unenforcedB = recordFor(required, "seat-b");
    expect(unenforcedA.disposition).toBe("excluded");
    expect(unenforcedA.reasons).toContain("readonly_unenforced");
    expect(unenforcedB.disposition).toBe("excluded");
    expect(unenforcedB.reasons).toContain("readonly_unenforced");
    expect(recordFor(required, "seat-c").disposition).toBe("scored");
    expect(required.shadow_choice).toBe("seat-c");

    const optional = rank(query({ requires_readonly: false }), candidates);
    expect(optional.shadow_choice).toBe("seat-a");
  });

  test("does not let candidates inherit qualification across fingerprint changes", () => {
    expect(typeof rankSeatShadow).toBe("function");
    const rank = rankSeatShadow!;

    const fp = fingerprint();
    const profile = scoredProfile(fp, 5, 0);

    const harnessChanged = rank(query(), [
      seatCandidate("seat-a", profile, {
        fingerprint: { ...fp, harness: "acp-other" },
      }),
    ]);
    const harnessRecord = recordFor(harnessChanged, "seat-a");
    expect(harnessRecord.disposition).toBe("unknown");
    expect(harnessRecord.reasons).toContain("fingerprint_mismatch");
    expect(harnessRecord.rank).toBeNull();
    expect(harnessChanged.shadow_choice).toBeNull();

    const modelChanged = rank(query(), [
      seatCandidate("seat-a", profile, {
        fingerprint: { ...fp, model_sha: "model-sha-other" },
      }),
    ]);
    const modelRecord = recordFor(modelChanged, "seat-a");
    expect(modelRecord.disposition).toBe("unknown");
    expect(modelRecord.reasons).toContain("fingerprint_mismatch");
    expect(modelRecord.rank).toBeNull();
    expect(modelChanged.shadow_choice).toBeNull();

    const seatIdChanged = rank(query(), [seatCandidate("seat-b", profile)]);
    const seatRecord = recordFor(seatIdChanged, "seat-b");
    expect(seatRecord.disposition).toBe("unknown");
    expect(seatRecord.reasons).toContain("fingerprint_mismatch");
    expect(seatRecord.rank).toBeNull();
    expect(seatIdChanged.shadow_choice).toBeNull();
  });

  test("reports the precise unknown reason for each abstaining candidate", () => {
    expect(typeof rankSeatShadow).toBe("function");
    const rank = rankSeatShadow!;

    const fpIncomplete = fingerprint({ seat_id: "seat-inc", model_sha: null });
    const profileIncomplete = profileFor(fpIncomplete, []);
    expect(profileIncomplete.status).toBe("abstain");
    expect(profileIncomplete.abstain_reason).toBe("incomplete_fingerprint");

    const fpNoEvidence = seatFp("seat-noev");
    const profileNoEvidence = profileFor(fpNoEvidence, []);
    expect(profileNoEvidence.status).toBe("abstain");
    expect(profileNoEvidence.abstain_reason).toBe("no_matching_evidence");

    const fpMissing = seatFp("seat-missing");
    const profileMissing = profileFor(fpMissing, otherCellRoots(fpMissing, 5, "miss"));
    expect(profileMissing.status).toBe("qualified");
    expect(queryCell(profileMissing)).toBeUndefined();

    const fpSparse = seatFp("seat-sparse");
    const profileSparse = profileFor(fpSparse, [
      ...queryRoots(fpSparse, 4, "pass", FRESH_RECORDED_AT, "sparse-q"),
      ...otherCellRoots(fpSparse, 5, "sparse-o"),
    ]);
    expect(profileSparse.status).toBe("qualified");
    expect(queryCell(profileSparse)?.status).toBe("sparse");

    const fpStale = seatFp("seat-stale");
    const profileStale = profileFor(fpStale, [
      ...queryRoots(fpStale, 5, "pass", STALE_RECORDED_AT, "stale-q"),
      ...otherCellRoots(fpStale, 5, "stale-o"),
    ]);
    expect(profileStale.status).toBe("qualified");
    expect(queryCell(profileStale)?.status).toBe("stale");

    const candidates = [
      seatCandidate("seat-inc", profileIncomplete),
      seatCandidate("seat-noev", profileNoEvidence),
      seatCandidate("seat-missing", profileMissing),
      seatCandidate("seat-sparse", profileSparse),
      seatCandidate("seat-stale", profileStale),
    ];
    const decision = rank(query(), candidates);

    expect(decision.shadow_choice).toBeNull();
    expect(decision.abstain_reason).toBe("no_scored_candidates");
    const expectations: [string, string][] = [
      ["seat-inc", "profile_abstain:incomplete_fingerprint"],
      ["seat-noev", "profile_abstain:no_matching_evidence"],
      ["seat-missing", "cell_missing"],
      ["seat-sparse", "cell_sparse"],
      ["seat-stale", "cell_stale"],
    ];
    for (const [seatId, reason] of expectations) {
      const record = recordFor(decision, seatId);
      expect(record.disposition).toBe("unknown");
      expect(record.reasons).toContain(reason);
      expect(record.rank).toBeNull();
    }
  });

  test("abstains with no_scored_candidates when every candidate is excluded or unknown", () => {
    expect(typeof rankSeatShadow).toBe("function");
    const rank = rankSeatShadow!;

    const fpA = seatFp("seat-a");
    const fpB = seatFp("seat-b");
    const profileA = scoredProfile(fpA, 5, 0);
    const profileB = scoredProfile(fpB, 5, 0);
    const candidates = [
      seatCandidate("seat-a", profileA, { hard_exclusion_reasons: ["node_capacity"] }),
      seatCandidate("seat-b", profileB, {
        fingerprint: { ...fpB, harness: "acp-other" },
      }),
    ];

    const decision = rank(query(), candidates);

    expect(decision.shadow_choice).toBeNull();
    expect(decision.abstain_reason).toBe("no_scored_candidates");
  });

  test("honors eligible pins and abstains when the pin cannot be satisfied", () => {
    expect(typeof rankSeatShadow).toBe("function");
    const rank = rankSeatShadow!;

    const fpA = seatFp("seat-a");
    const fpB = seatFp("seat-b");
    const profileA = scoredProfile(fpA, 5, 0);
    const profileB = scoredProfile(fpB, 3, 2);
    const candidates = [seatCandidate("seat-a", profileA), seatCandidate("seat-b", profileB)];

    const pinned = rank(query({ pinned_seat_id: "seat-b" }), candidates);
    expect(pinned.shadow_choice).toBe("seat-b");
    expect(recordFor(pinned, "seat-b").reasons).toContain("pin_honored");
    expect(recordFor(pinned, "seat-a").disposition).toBe("scored");
    expect(recordFor(pinned, "seat-a").rank).toBe(1);
    expect(recordFor(pinned, "seat-b").rank).toBe(2);

    const excludedPin = rank(query({ pinned_seat_id: "seat-b" }), [
      seatCandidate("seat-a", profileA),
      seatCandidate("seat-b", profileB, { hard_exclusion_reasons: ["quota_exhausted"] }),
    ]);
    expect(excludedPin.shadow_choice).toBeNull();
    expect(excludedPin.abstain_reason).toBe("pinned_seat_ineligible");

    const unknownPin = rank(query({ pinned_seat_id: "seat-z" }), candidates);
    expect(unknownPin.shadow_choice).toBeNull();
    expect(unknownPin.abstain_reason).toBe("pinned_seat_unknown");

    const readonlyPin = rank(query({ pinned_seat_id: "seat-b", requires_readonly: true }), [
      seatCandidate("seat-a", profileA, { readonly_enforced: true }),
      seatCandidate("seat-b", profileB, { readonly_enforced: false }),
    ]);
    expect(readonlyPin.shadow_choice).toBeNull();
    expect(readonlyPin.abstain_reason).toBe("pinned_seat_ineligible");

    const mismatchedPin = rank(query({ pinned_seat_id: "seat-b" }), [
      seatCandidate("seat-a", profileA),
      seatCandidate("seat-b", profileB, {
        fingerprint: { ...fpB, harness: "acp-other" },
      }),
    ]);
    expect(mismatchedPin.shadow_choice).toBe("seat-b");
    expect(mismatchedPin.abstain_reason).toBeNull();
    const mismatchedRecord = recordFor(mismatchedPin, "seat-b");
    expect(mismatchedRecord.disposition).toBe("unknown");
    expect(mismatchedRecord.reasons).toContain("pin_honored");
    expect(mismatchedRecord.rank).toBeNull();
  });

  test("emits observational shadow decisions that preserve input order under frozen inputs", () => {
    expect(typeof rankSeatShadow).toBe("function");
    const rank = rankSeatShadow!;

    const fpA = seatFp("seat-a");
    const fpB = seatFp("seat-b");
    const profileA = scoredProfile(fpA, 5, 0);
    const profileB = scoredProfile(fpB, 3, 2);
    const candidates = [seatCandidate("seat-b", profileB), seatCandidate("seat-a", profileA)];
    const frozenQuery = query({ current_route_seat_id: "seat-a" });
    deepFreeze(frozenQuery);
    deepFreeze(candidates);

    const first = rank(frozenQuery, candidates);
    const second = rank(frozenQuery, candidates);
    expect(second).toEqual(first);

    expect(first.mode).toBe("shadow");
    expect(first.executes).toBe(false);
    expect(first.current_route_seat_id).toBe("seat-a");
    expect(first.shadow_choice).toBe("seat-a");
    expect(first.agrees_with_current).toBe(true);
    expect(first.candidates.map((record) => record.seat_id)).toEqual(["seat-b", "seat-a"]);
    expect(recordFor(first, "seat-b").rank).toBe(2);
    expect(recordFor(first, "seat-a").rank).toBe(1);
    for (const [index, record] of first.candidates.entries()) {
      expect(record.fingerprint_key).toBe(seatFingerprintKey(candidates[index]!.fingerprint));
    }

    const liveCandidates = [seatCandidate("seat-b", profileB), seatCandidate("seat-a", profileA)];
    const disagree = rank(query({ current_route_seat_id: "seat-b" }), liveCandidates);
    expect(disagree.agrees_with_current).toBe(false);
    const missingCurrent = rank(query({ current_route_seat_id: null }), liveCandidates);
    expect(missingCurrent.agrees_with_current).toBeNull();
    const abstaining = rank(query({ current_route_seat_id: "seat-a" }), [
      seatCandidate("seat-b", profileB, { fingerprint: { ...fpB, harness: "acp-other" } }),
      seatCandidate("seat-a", profileA, { fingerprint: { ...fpA, model_sha: "model-sha-other" } }),
    ]);
    expect(abstaining.shadow_choice).toBeNull();
    expect(abstaining.agrees_with_current).toBeNull();
  });

  test("ranks 9/10 above 5/5 when Wilson lower bound ordering diverges from pass_rate", () => {
    expect(typeof rankSeatShadow).toBe("function");
    const rank = rankSeatShadow!;

    const fpPerfect = seatFp("seat-perfect");
    const fpReliable = seatFp("seat-reliable");
    const profilePerfect = scoredProfile(fpPerfect, 5, 0);
    const profileReliable = scoredProfile(fpReliable, 9, 1);
    const candidates = [
      seatCandidate("seat-perfect", profilePerfect),
      seatCandidate("seat-reliable", profileReliable),
    ];

    const decision = rank(query(), candidates);

    const recordPerfect = recordFor(decision, "seat-perfect");
    const recordReliable = recordFor(decision, "seat-reliable");
    expect(recordPerfect.pass_rate).toBe(1);
    expect(recordReliable.pass_rate).toBe(0.9);
    expect(recordPerfect.rank).toBe(2);
    expect(recordReliable.rank).toBe(1);
    expect(decision.shadow_choice).toBe("seat-reliable");
  });

  test("marks qualified cells with null pass_rate or interval as cell_unscored", () => {
    expect(typeof rankSeatShadow).toBe("function");
    const rank = rankSeatShadow!;

    const fp = seatFp("seat-unscored");
    const capacityEvidence = [
      evidence({
        fp,
        rootTaskId: "root-cap",
        tier: "T2",
        effort: "medium",
        budget: 1,
        contextBand: "ctx_32k",
        verdict: "capacity",
      }),
    ];
    const profile = buildSeatProfile(capacityEvidence, fp, { now: NOW, minRootTasks: 0 });
    expect(profile.status).toBe("qualified");

    const cell = profile.cells.find(
      (cell) =>
        cell.tier === "T2" &&
        cell.effort === "medium" &&
        cell.budget === 1 &&
        cell.context_band === "ctx_32k",
    );
    expect(cell).toBeDefined();
    expect(cell!.status).toBe("qualified");
    expect(cell!.pass_rate).toBeNull();
    expect(cell!.interval).toBeNull();

    const decision = rank(query(), [seatCandidate("seat-unscored", profile)]);

    const record = recordFor(decision, "seat-unscored");
    expect(record.disposition).toBe("unknown");
    expect(record.reasons).toContain("cell_unscored");
    expect(record.rank).toBeNull();
    expect(decision.shadow_choice).toBeNull();
  });
});

describe("summarizeSeatShadowReplay", () => {
  test("keeps the first decision per root task and rolls up agreement", () => {
    expect(typeof summarizeSeatShadowReplay).toBe("function");
    const summarize = summarizeSeatShadowReplay!;
    const rank = rankSeatShadow!;

    const fpA = seatFp("seat-a");
    const fpB = seatFp("seat-b");
    const profileA = scoredProfile(fpA, 5, 0);
    const profileB = scoredProfile(fpB, 3, 2);

    const fpX = seatFp("seat-x");
    const profileX = profileFor(fpX, otherCellRoots(fpX, 5, "x"));
    const agreeCandidates = [seatCandidate("seat-a", profileA), seatCandidate("seat-x", profileX)];
    const firstR1 = rank(
      query({ root_task_id: "r1", current_route_seat_id: "seat-a" }),
      agreeCandidates,
    );
    const retryR1 = rank(
      query({ root_task_id: "r1", current_route_seat_id: "seat-b" }),
      agreeCandidates,
    );

    const fpY = seatFp("seat-y");
    const profileY = scoredProfile(fpY, 4, 1);
    const disagreeCandidates = [
      seatCandidate("seat-b", profileB),
      seatCandidate("seat-y", profileY, { fingerprint: { ...fpY, harness: "acp-other" } }),
    ];
    const second = rank(
      query({ root_task_id: "r2", current_route_seat_id: "seat-a" }),
      disagreeCandidates,
    );

    const fpZ = seatFp("seat-z");
    const profileZ = profileFor(fpZ, []);
    const abstainCandidates = [
      seatCandidate("seat-z", profileZ),
      seatCandidate("seat-a", profileA, { hard_exclusion_reasons: ["quota_exhausted"] }),
    ];
    const third = rank(
      query({ root_task_id: "r3", current_route_seat_id: "seat-a" }),
      abstainCandidates,
    );

    expect(summarize([firstR1, retryR1, second, third])).toEqual({
      decisions: 3,
      duplicates_ignored: 1,
      agree: 1,
      disagree: 1,
      shadow_abstain: 1,
      current_missing: 0,
      abstain_reasons: { no_scored_candidates: 1 },
      unknown_reasons: {
        cell_missing: 1,
        fingerprint_mismatch: 1,
        "profile_abstain:no_matching_evidence": 1,
      },
    });
  });

  test("counts current_missing when current_route_seat_id is null with a scored shadow choice", () => {
    expect(typeof summarizeSeatShadowReplay).toBe("function");
    const summarize = summarizeSeatShadowReplay!;
    const rank = rankSeatShadow!;

    const fpA = seatFp("seat-a");
    const fpB = seatFp("seat-b");
    const profileA = scoredProfile(fpA, 5, 0);
    const profileB = scoredProfile(fpB, 3, 2);
    const candidates = [seatCandidate("seat-a", profileA), seatCandidate("seat-b", profileB)];

    const missingCurrent = rank(
      query({ root_task_id: "r1", current_route_seat_id: null }),
      candidates,
    );

    const summary = summarize([missingCurrent]);
    expect(summary.current_missing).toBe(1);
    expect(summary.shadow_abstain).toBe(0);
    expect(summary.agree).toBe(0);
    expect(summary.disagree).toBe(0);
  });
});

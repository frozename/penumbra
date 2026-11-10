import {
  type SeatContextBand,
  type SeatFingerprint,
  seatFingerprintKey,
  type SeatProfile,
  type SeatProfileCell,
  type SeatTier,
} from "./seat-profile.js";

/**
 * Seat shadow ranker — SHADOW-ONLY: it reads verified-outcome seat profiles and
 * reports what a capability-ranked choice *would* have been. It never executes
 * a route and never changes the current route. Part of #395.
 */

export type SeatShadowDisposition = "scored" | "excluded" | "unknown";

export interface SeatShadowQuery {
  tier: SeatTier;
  effort: string;
  budget: number;
  context_band: SeatContextBand;
  requires_readonly?: boolean;
  pinned_seat_id?: string | null;
  current_route_seat_id?: string | null;
  root_task_id?: string | null;
}

export interface SeatShadowCandidate {
  seat_id: string;
  fingerprint: SeatFingerprint;
  profile: SeatProfile;
  hard_exclusion_reasons?: readonly string[];
  readonly_enforced?: boolean;
}

export interface SeatShadowCandidateRecord {
  seat_id: string;
  fingerprint_key: string;
  disposition: SeatShadowDisposition;
  reasons: string[];
  rank: number | null;
  pass_rate: number | null;
  interval_lo: number | null;
}

export interface SeatShadowDecision {
  mode: "shadow";
  executes: false;
  root_task_id: string | null;
  current_route_seat_id: string | null;
  shadow_choice: string | null;
  abstain_reason: string | null;
  agrees_with_current: boolean | null;
  candidates: SeatShadowCandidateRecord[];
}

export interface SeatShadowReplaySummary {
  decisions: number;
  duplicates_ignored: number;
  agree: number;
  disagree: number;
  shadow_abstain: number;
  current_missing: number;
  abstain_reasons: Record<string, number>;
  unknown_reasons: Record<string, number>;
}

interface ShadowChoice {
  shadowChoice: string | null;
  abstainReason: string | null;
}

function hardFilterReasons(query: SeatShadowQuery, candidate: SeatShadowCandidate): string[] {
  const reasons: string[] = [];
  for (const reason of candidate.hard_exclusion_reasons ?? []) {
    reasons.push(`hard:${reason}`);
  }
  if (query.requires_readonly === true && candidate.readonly_enforced !== true) {
    reasons.push("readonly_unenforced");
  }
  return reasons;
}

function findQueryCell(query: SeatShadowQuery, profile: SeatProfile): SeatProfileCell | undefined {
  return profile.cells.find(
    (cell) =>
      cell.tier === query.tier &&
      cell.effort === query.effort &&
      cell.budget === query.budget &&
      cell.context_band === query.context_band,
  );
}

function classifyCandidate(
  query: SeatShadowQuery,
  candidate: SeatShadowCandidate,
): SeatShadowCandidateRecord {
  const base = {
    seat_id: candidate.seat_id,
    fingerprint_key: seatFingerprintKey(candidate.fingerprint),
    rank: null,
    pass_rate: null,
    interval_lo: null,
  };
  const hardReasons = hardFilterReasons(query, candidate);
  if (hardReasons.length > 0) {
    return { ...base, disposition: "excluded", reasons: hardReasons };
  }
  if (
    candidate.fingerprint.seat_id !== candidate.seat_id ||
    base.fingerprint_key !== candidate.profile.fingerprint_key
  ) {
    return { ...base, disposition: "unknown", reasons: ["fingerprint_mismatch"] };
  }
  if (candidate.profile.status === "abstain") {
    const abstainReason = candidate.profile.abstain_reason ?? "unknown";
    return { ...base, disposition: "unknown", reasons: [`profile_abstain:${abstainReason}`] };
  }
  const cell = findQueryCell(query, candidate.profile);
  if (cell === undefined) {
    return { ...base, disposition: "unknown", reasons: ["cell_missing"] };
  }
  if (cell.status === "sparse") {
    return { ...base, disposition: "unknown", reasons: ["cell_sparse"] };
  }
  if (cell.status === "stale") {
    return { ...base, disposition: "unknown", reasons: ["cell_stale"] };
  }
  if (cell.pass_rate === null || cell.interval === null) {
    return { ...base, disposition: "unknown", reasons: ["cell_unscored"] };
  }
  return {
    ...base,
    disposition: "scored",
    reasons: [],
    pass_rate: cell.pass_rate,
    interval_lo: cell.interval.lo,
  };
}

function compareSeatIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareScored(a: SeatShadowCandidateRecord, b: SeatShadowCandidateRecord): number {
  const loDiff = (b.interval_lo ?? 0) - (a.interval_lo ?? 0);
  if (loDiff !== 0) return loDiff;
  const rateDiff = (b.pass_rate ?? 0) - (a.pass_rate ?? 0);
  if (rateDiff !== 0) return rateDiff;
  return compareSeatIds(a.seat_id, b.seat_id);
}

function assignRanks(records: SeatShadowCandidateRecord[]): void {
  const scored = records.filter((record) => record.disposition === "scored");
  scored.sort(compareScored);
  let rank = 0;
  for (const record of scored) {
    rank += 1;
    record.rank = rank;
  }
}

function choosePinned(records: SeatShadowCandidateRecord[], pinnedSeatId: string): ShadowChoice {
  const record = records.find((candidate) => candidate.seat_id === pinnedSeatId);
  if (record === undefined) {
    return { shadowChoice: null, abstainReason: "pinned_seat_unknown" };
  }
  if (record.disposition === "excluded") {
    return { shadowChoice: null, abstainReason: "pinned_seat_ineligible" };
  }
  record.reasons.push("pin_honored");
  return { shadowChoice: record.seat_id, abstainReason: null };
}

function chooseBest(records: SeatShadowCandidateRecord[]): ShadowChoice {
  const best = records.find((record) => record.rank === 1);
  if (best === undefined) {
    return { shadowChoice: null, abstainReason: "no_scored_candidates" };
  }
  return { shadowChoice: best.seat_id, abstainReason: null };
}

export function rankSeatShadow(
  query: SeatShadowQuery,
  candidates: readonly SeatShadowCandidate[],
): SeatShadowDecision {
  const records = candidates.map((candidate) => classifyCandidate(query, candidate));
  assignRanks(records);
  const pinnedSeatId = query.pinned_seat_id ?? null;
  const choice = pinnedSeatId !== null ? choosePinned(records, pinnedSeatId) : chooseBest(records);
  const currentRouteSeatId = query.current_route_seat_id ?? null;
  const agreesWithCurrent =
    currentRouteSeatId === null || choice.shadowChoice === null
      ? null
      : currentRouteSeatId === choice.shadowChoice;
  return {
    mode: "shadow",
    executes: false,
    root_task_id: query.root_task_id ?? null,
    current_route_seat_id: currentRouteSeatId,
    shadow_choice: choice.shadowChoice,
    abstain_reason: choice.abstainReason,
    agrees_with_current: agreesWithCurrent,
    candidates: records,
  };
}

function increment(counters: Record<string, number>, key: string): void {
  counters[key] = (counters[key] ?? 0) + 1;
}

function isDuplicate(seenRootTaskIds: Set<string>, rootTaskId: string | null): boolean {
  if (rootTaskId === null) return false;
  if (seenRootTaskIds.has(rootTaskId)) return true;
  seenRootTaskIds.add(rootTaskId);
  return false;
}

function applyDecision(summary: SeatShadowReplaySummary, decision: SeatShadowDecision): void {
  if (decision.shadow_choice === null) {
    summary.shadow_abstain += 1;
    increment(summary.abstain_reasons, decision.abstain_reason ?? "unknown");
    return;
  }
  if (decision.current_route_seat_id === null) {
    summary.current_missing += 1;
    return;
  }
  if (decision.agrees_with_current === true) {
    summary.agree += 1;
  } else {
    summary.disagree += 1;
  }
}

function applyUnknownReasons(summary: SeatShadowReplaySummary, decision: SeatShadowDecision): void {
  for (const record of decision.candidates) {
    if (record.disposition !== "unknown") continue;
    for (const reason of record.reasons) {
      if (reason === "pin_honored") continue;
      increment(summary.unknown_reasons, reason);
    }
  }
}

export function summarizeSeatShadowReplay(
  decisions: readonly SeatShadowDecision[],
): SeatShadowReplaySummary {
  const summary: SeatShadowReplaySummary = {
    decisions: 0,
    duplicates_ignored: 0,
    agree: 0,
    disagree: 0,
    shadow_abstain: 0,
    current_missing: 0,
    abstain_reasons: {},
    unknown_reasons: {},
  };
  const seenRootTaskIds = new Set<string>();
  for (const decision of decisions) {
    if (isDuplicate(seenRootTaskIds, decision.root_task_id)) {
      summary.duplicates_ignored += 1;
      continue;
    }
    summary.decisions += 1;
    applyDecision(summary, decision);
    applyUnknownReasons(summary, decision);
  }
  return summary;
}

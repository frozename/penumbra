import type { FanoutTaskResult } from "../_shared/fanout.js";

export type CandidateRef = {
  branch: string;
  handoffId: string;
};

export type CandidateResolution =
  | { ok: true; candidate: CandidateRef }
  | { ok: false; reason: string };

export function resolveAuthoritativeCandidate(
  result: FanoutTaskResult | null,
): CandidateResolution {
  if (!result) return { ok: false, reason: "candidate_result_missing" };
  if (result.hops_incomplete !== false) {
    return { ok: false, reason: "candidate_hops_incomplete" };
  }
  if (!Array.isArray(result.hops) || result.hops.length === 0) {
    return { ok: false, reason: "candidate_hops_missing" };
  }
  if (result.hop_count !== result.hops.length) {
    return { ok: false, reason: "candidate_hop_count_mismatch" };
  }
  if (typeof result.latest_handoff_id !== "string" || result.latest_handoff_id.length === 0) {
    return { ok: false, reason: "candidate_latest_handoff_missing" };
  }
  if (result.latest_reliability_trustworthy !== true) {
    return {
      ok: false,
      reason:
        result.latest_reliability_trustworthy === false
          ? "candidate_latest_reliability_untrustworthy"
          : "candidate_latest_reliability_unverified",
    };
  }

  const matches = result.hops.filter((hop) => hop.handoff_id === result.latest_handoff_id);
  if (matches.length !== 1) {
    return { ok: false, reason: "candidate_latest_handoff_ambiguous" };
  }
  const latest = matches[0];
  if (latest?.status !== "completed") {
    return { ok: false, reason: "candidate_latest_handoff_not_completed" };
  }
  if (typeof latest.branch_name !== "string" || latest.branch_name.length === 0) {
    return { ok: false, reason: "candidate_latest_branch_missing" };
  }
  return {
    ok: true,
    candidate: { branch: latest.branch_name, handoffId: latest.handoff_id },
  };
}

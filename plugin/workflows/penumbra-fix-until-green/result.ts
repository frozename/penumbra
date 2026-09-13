import type { FanoutHop } from "../_shared/fanout-hop-evidence.js";
import type { FanoutTaskResult } from "../_shared/fanout.js";
export type HopFields = {
  root_handoff_id: string | null;
  latest_handoff_id: string | null;
  hop_count: number | null;
  extra_hops: number | null;
  retry_prompt_count: number | null;
  hops_incomplete: boolean | null;
  branch_base: string | null;
  parent_handoff_id: string | null;
  hops: FanoutHop[] | null;
};

export function hopFields(result: FanoutTaskResult | null): HopFields {
  if (!result) {
    return {
      root_handoff_id: null,
      latest_handoff_id: null,
      hop_count: null,
      extra_hops: null,
      retry_prompt_count: null,
      hops_incomplete: null,
      branch_base: null,
      parent_handoff_id: null,
      hops: null,
    };
  }
  return {
    root_handoff_id: result.root_handoff_id ?? null,
    latest_handoff_id: result.latest_handoff_id ?? null,
    hop_count: result.hop_count,
    extra_hops: result.extra_hops,
    retry_prompt_count: result.retry_prompt_count,
    hops_incomplete: result.hops_incomplete,
    branch_base: result.branch_base ?? null,
    parent_handoff_id: result.parent_handoff_id ?? null,
    hops: result.hops,
  };
}

export type CheckVerifyStatus = "skipped" | "passed" | "failed" | "unavailable" | "not_run";

export type RoundRecord = {
  round: number;
  agent: string;
  dispatch_ok: boolean;
  reason: string;
  candidate_branch: string | null;
  candidate_handoff_id: string | null;
  verifier_handoff_id: string | null;
  verifier_branch: string | null;
  grader_handoff_id: string | null;
  grader_branch: string | null;
  check_passed: boolean;
  check_verify_status: CheckVerifyStatus;
  check_exit: number | null;
  rubric_status: string | null;
  rubric_grade: unknown;
  verified: boolean;
  passed: boolean;
  hops: HopFields;
};

export type FixUntilGreenResult = {
  ok: boolean;
  green: boolean;
  rounds_used: number;
  final_branch: string | null;
  last_output: string | null;
  rounds: RoundRecord[];
  check: string;
  rubric: string[];
};

export function makeRoundRecord(opts: {
  round: number;
  agent: string;
  result: FanoutTaskResult | null;
  dispatchOk: boolean;
  reason: string;
  checkPassed: boolean;
  checkVerifyStatus: CheckVerifyStatus;
  checkExit?: number | null;
  rubricStatus?: string | null;
  rubricGrade?: unknown;
  verifierHandoffId?: string | null;
  verifierBranch?: string | null;
  graderHandoffId?: string | null;
  graderBranch?: string | null;
  candidateBranch?: string | null;
  candidateHandoffId?: string | null;
  verified?: boolean;
  passed: boolean;
}): RoundRecord {
  return {
    round: opts.round,
    agent: opts.agent,
    dispatch_ok: opts.dispatchOk,
    reason: opts.reason,
    candidate_branch: opts.candidateBranch ?? null,
    candidate_handoff_id: opts.candidateHandoffId ?? null,
    verifier_handoff_id: opts.verifierHandoffId ?? null,
    verifier_branch: opts.verifierBranch ?? null,
    grader_handoff_id: opts.graderHandoffId ?? null,
    grader_branch: opts.graderBranch ?? null,
    check_passed: opts.checkPassed,
    check_verify_status: opts.checkVerifyStatus,
    check_exit: opts.checkExit ?? null,
    rubric_status: opts.rubricStatus ?? null,
    rubric_grade: opts.rubricGrade ?? null,
    verified: opts.verified ?? false,
    passed: opts.passed,
    hops: hopFields(opts.result),
  };
}

import type { FanoutHop } from "../_shared/fanout-hop-evidence.js";
import type { FanoutTaskResult } from "../_shared/fanout.js";
import type { VerifyReport } from "./verify-command.js";

export type DispatchSummary = {
  ok: boolean;
  handoff_id: string | null;
  latest_handoff_id: string | null;
  conversation_id: string | null;
  status: string;
  branch_name: string | null;
  branch_base: string | null;
  root_branch_name: string | null;
  root_branch_base: string | null;
  latest_branch_name: string | null;
  latest_branch_base: string | null;
  hop_count: number | null;
  hops_incomplete: boolean | null;
  reliability_trustworthy: boolean | null;
  reliability_status: string | null;
  reliability_action: string | null;
  latest_reliability_trustworthy: boolean | null;
  latest_reliability_status: string | null;
  latest_reliability_action: string | null;
  error_summary: string | null;
};

export type InspectionTruncation = {
  diff_against_main: boolean;
  branch_log: boolean;
  total: boolean;
};

export type InspectionSummary = {
  handoff_id: string;
  head_sha: string;
  branch_name: string;
  project_id: string | null;
  dirty: boolean;
  truncation: InspectionTruncation;
};

export type VerifyExecution = "completed" | "unavailable" | "not_run";

export type VerifySummary = {
  ok: boolean;
  handoff_id: string | null;
  latest_handoff_id: string | null;
  conversation_id: string | null;
  status: string;
  branch_name: string | null;
  branch_base: string | null;
  root_branch_name: string | null;
  root_branch_base: string | null;
  latest_branch_name: string | null;
  latest_branch_base: string | null;
  hops_incomplete: boolean | null;
  reliability_trustworthy: boolean | null;
  reliability_status: string | null;
  reliability_action: string | null;
  latest_reliability_trustworthy: boolean | null;
  latest_reliability_status: string | null;
  latest_reliability_action: string | null;
  execution: VerifyExecution;
  error_summary: string | null;
  response_handoff_id: string | null;
  inspection: InspectionSummary | null;
  inspection_error: string | null;
  report: VerifyReport | null;
  parse_error: string | null;
  validation_errors: string[];
};

export type FleetVerifyTaskResult = {
  name: string;
  index: number;
  dispatch: DispatchSummary;
  candidate_before: InspectionSummary | null;
  candidate_before_error: string | null;
  candidate_after: InspectionSummary | null;
  candidate_after_error: string | null;
  verify: VerifySummary | null;
  skipped: string | null;
  artifact_receipt: string | null;
  artifact_error: string | null;
  landable: boolean;
};

export type LandableEntry = {
  name: string;
  dispatch_handoff_id: string;
  verify_handoff_id: string;
  branch: string;
  head_sha: string;
};

export type FleetVerifyResult = {
  ranNothingToMain: true;
  ok: boolean;
  total: number;
  landable_count: number;
  failed_count: number;
  skipped_count: number;
  results: FleetVerifyTaskResult[];
  landable: LandableEntry[];
  artifacts: string[];
};

export function latestMatchingHop(r: FanoutTaskResult): FanoutHop | null {
  if (!r.latest_handoff_id || !r.hops) return null;
  const matches = r.hops.filter((hop) => hop.handoff_id === r.latest_handoff_id);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function summarizeDispatch(r: FanoutTaskResult): DispatchSummary {
  const latest = latestMatchingHop(r);
  return {
    ok: r.ok,
    handoff_id: r.handoff_id,
    latest_handoff_id: latest?.handoff_id ?? r.latest_handoff_id,
    conversation_id: r.conversation_id,
    status: r.status,
    branch_name: latest?.branch_name ?? null,
    branch_base: latest?.branch_base ?? null,
    root_branch_name: r.branch_name,
    root_branch_base: r.branch_base,
    latest_branch_name: latest?.branch_name ?? null,
    latest_branch_base: latest?.branch_base ?? null,
    hop_count: r.hop_count,
    hops_incomplete: r.hops_incomplete,
    reliability_trustworthy: r.reliability_trustworthy,
    reliability_status: r.reliability_status,
    reliability_action: r.reliability_action,
    latest_reliability_trustworthy: r.latest_reliability_trustworthy,
    latest_reliability_status: r.latest_reliability_status,
    latest_reliability_action: r.latest_reliability_action,
    error_summary: r.error_summary,
  };
}

export function summarizeVerify(r: FanoutTaskResult): VerifySummary {
  const latest = latestMatchingHop(r);
  const notRun = r.handoff_id === null || r.conversation_id === null;
  return {
    ok: r.ok,
    handoff_id: r.handoff_id,
    latest_handoff_id: latest?.handoff_id ?? r.latest_handoff_id,
    conversation_id: r.conversation_id,
    status: r.status,
    branch_name: latest?.branch_name ?? null,
    branch_base: latest?.branch_base ?? null,
    root_branch_name: r.branch_name,
    root_branch_base: r.branch_base,
    latest_branch_name: latest?.branch_name ?? null,
    latest_branch_base: latest?.branch_base ?? null,
    hops_incomplete: r.hops_incomplete,
    reliability_trustworthy: r.reliability_trustworthy,
    reliability_status: r.reliability_status,
    reliability_action: r.reliability_action,
    latest_reliability_trustworthy: r.latest_reliability_trustworthy,
    latest_reliability_status: r.latest_reliability_status,
    latest_reliability_action: r.latest_reliability_action,
    execution: notRun ? "not_run" : isReliableCandidate(r) ? "completed" : "unavailable",
    error_summary: r.error_summary,
    response_handoff_id: typeof r.response_text === "string" ? r.handoff_id : null,
    inspection: null,
    inspection_error: null,
    report: null,
    parse_error: null,
    validation_errors: [],
  };
}

export function isReliableCandidate(r: FanoutTaskResult): boolean {
  const latest = latestMatchingHop(r);
  return (
    r.status === "completed" &&
    r.hops_incomplete === false &&
    r.latest_reliability_trustworthy === true &&
    latest?.status === "completed" &&
    typeof latest.branch_name === "string" &&
    latest.branch_name.length > 0
  );
}

function inspectionStable(result: FleetVerifyTaskResult): boolean {
  const before = result.candidate_before;
  const after = result.candidate_after;
  return (
    before !== null &&
    after !== null &&
    !before.dirty &&
    !after.dirty &&
    !before.truncation.diff_against_main &&
    !before.truncation.branch_log &&
    !before.truncation.total &&
    !after.truncation.diff_against_main &&
    !after.truncation.branch_log &&
    !after.truncation.total &&
    before.handoff_id === result.dispatch.latest_handoff_id &&
    after.handoff_id === before.handoff_id &&
    before.head_sha === after.head_sha &&
    before.branch_name === after.branch_name
  );
}

export function isLandable(result: FleetVerifyTaskResult): boolean {
  if (result.skipped !== null || result.artifact_error !== null) return false;
  if (result.dispatch.status !== "completed" || result.dispatch.hops_incomplete !== false) {
    return false;
  }
  if (result.dispatch.latest_reliability_trustworthy !== true || !inspectionStable(result)) {
    return false;
  }
  const verify = result.verify;
  const candidate = result.candidate_before;
  if (verify?.execution !== "completed" || candidate === null) return false;
  if (verify.status !== "completed" || verify.hops_incomplete !== false) return false;
  if (verify.latest_reliability_trustworthy !== true || !verify.report) return false;
  if (!verify.inspection || verify.inspection_error !== null) return false;
  if (verify.root_branch_base !== candidate.head_sha) return false;
  if (verify.inspection.head_sha !== candidate.head_sha) return false;
  if (verify.inspection.handoff_id !== verify.latest_handoff_id) return false;
  if (verify.inspection.branch_name !== verify.latest_branch_name) return false;
  if (verify.report.verdict !== "pass") return false;
  return verify.validation_errors.length === 0;
}

export function buildLandableEntry(result: FleetVerifyTaskResult): LandableEntry {
  return {
    name: result.name,
    dispatch_handoff_id: result.dispatch.latest_handoff_id ?? "",
    verify_handoff_id: result.verify?.latest_handoff_id ?? "",
    branch: result.dispatch.branch_name ?? "",
    head_sha: result.candidate_before?.head_sha ?? "",
  };
}

export function buildFinalResult(results: FleetVerifyTaskResult[]): FleetVerifyResult {
  const landableResults = results.filter(isLandable);
  const skipped = results.filter((result) => result.skipped !== null);
  const failed = results.filter((result) => !isLandable(result) && result.skipped === null);
  return {
    ranNothingToMain: true,
    ok: landableResults.length === results.length && skipped.length === 0,
    total: results.length,
    landable_count: landableResults.length,
    failed_count: failed.length,
    skipped_count: skipped.length,
    results,
    landable: landableResults.map(buildLandableEntry),
    artifacts: results.flatMap((result) =>
      result.artifact_receipt === null ? [] : [result.artifact_receipt],
    ),
  };
}

import { expect, test } from "bun:test";

import type { FanoutTaskResult } from "../_shared/fanout.js";

import { hopFields, makeRoundRecord, type RoundRecord } from "./result.js";

function fakeFanoutResult(overrides: Partial<FanoutTaskResult> = {}): FanoutTaskResult {
  return {
    ok: true,
    status: "completed",
    label: "task-0",
    index: 0,
    initial_agent: "executor",
    conversation_id: "conv-1",
    handoff_id: "handoff-1",
    root_handoff_id: "handoff-1",
    latest_handoff_id: "handoff-1",
    hop_count: 1,
    extra_hops: 0,
    retry_prompt_count: 0,
    hops_incomplete: false,
    hops: [],
    branch_name: "feature/branch-1",
    branch_base: "main",
    parent_handoff_id: null,
    response_text: "response",
    final_agent: "executor",
    reliability_status: "complete",
    reliability_trustworthy: true,
    reliability_action: "accept",
    latest_reliability_status: "complete",
    latest_reliability_trustworthy: true,
    latest_reliability_action: "accept",
    retry_count: 0,
    error_code: null,
    error_summary: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hopFields
// ---------------------------------------------------------------------------

test("hopFields returns null fields for null result", () => {
  const fields = hopFields(null);
  expect(fields.root_handoff_id).toBeNull();
  expect(fields.latest_handoff_id).toBeNull();
  expect(fields.hop_count).toBeNull();
  expect(fields.extra_hops).toBeNull();
  expect(fields.retry_prompt_count).toBeNull();
  expect(fields.hops_incomplete).toBeNull();
  expect(fields.branch_base).toBeNull();
  expect(fields.parent_handoff_id).toBeNull();
  expect(fields.hops).toBeNull();
});

test("hopFields extracts fields from FanoutTaskResult", () => {
  const result = fakeFanoutResult({
    root_handoff_id: "root-h",
    latest_handoff_id: "latest-h",
    hop_count: 2,
    extra_hops: 1,
    retry_prompt_count: 1,
    hops_incomplete: true,
    branch_base: "feature/base",
    parent_handoff_id: "parent-h",
    hops: [
      {
        handoff_id: "h1",
        status: "completed",
        branch_name: "b1",
        to_agent: "a",
        branch_base: null,
        parent_handoff_id: null,
        created_ts: "ts",
        is_retry: false,
      },
    ],
  });
  const fields = hopFields(result);
  expect(fields.root_handoff_id).toBe("root-h");
  expect(fields.latest_handoff_id).toBe("latest-h");
  expect(fields.hop_count).toBe(2);
  expect(fields.extra_hops).toBe(1);
  expect(fields.retry_prompt_count).toBe(1);
  expect(fields.hops_incomplete).toBe(true);
  expect(fields.branch_base).toBe("feature/base");
  expect(fields.parent_handoff_id).toBe("parent-h");
  expect(fields.hops).toHaveLength(1);
});

test("hopFields handles null fields in result", () => {
  const result = fakeFanoutResult({
    root_handoff_id: null,
    latest_handoff_id: null,
    hop_count: null,
    extra_hops: null,
    retry_prompt_count: null,
    hops_incomplete: null,
    hops: null,
  });
  const fields = hopFields(result);
  expect(fields.root_handoff_id).toBeNull();
  expect(fields.latest_handoff_id).toBeNull();
  expect(fields.hop_count).toBeNull();
  expect(fields.extra_hops).toBeNull();
  expect(fields.retry_prompt_count).toBeNull();
  expect(fields.hops_incomplete).toBeNull();
  expect(fields.hops).toBeNull();
});

// ---------------------------------------------------------------------------
// makeRoundRecord
// ---------------------------------------------------------------------------

test("makeRoundRecord builds a dispatch failure record", () => {
  const record = makeRoundRecord({
    round: 1,
    agent: "executor",
    result: null,
    dispatchOk: false,
    reason: "chain_failed",
    checkPassed: false,
    checkVerifyStatus: "skipped",
    passed: false,
  });
  expect(record.round).toBe(1);
  expect(record.dispatch_ok).toBe(false);
  expect(record.reason).toBe("chain_failed");
  expect(record.candidate_branch).toBeNull();
  expect(record.candidate_handoff_id).toBeNull();
  expect(record.passed).toBe(false);
  expect(record.check_verify_status).toBe("skipped");
});

test("makeRoundRecord builds a check FAIL record", () => {
  const result = fakeFanoutResult();
  const record = makeRoundRecord({
    round: 1,
    agent: "executor",
    result,
    candidateBranch: "feature/branch-1",
    candidateHandoffId: "handoff-1",
    dispatchOk: true,
    reason: "check_failed",
    checkPassed: false,
    checkVerifyStatus: "skipped",
    passed: false,
  });
  expect(record.dispatch_ok).toBe(true);
  expect(record.candidate_branch).toBe("feature/branch-1");
  expect(record.candidate_handoff_id).toBe("handoff-1");
  expect(record.check_passed).toBe(false);
  expect(record.passed).toBe(false);
});

test("makeRoundRecord builds a verify passed record", () => {
  const result = fakeFanoutResult();
  const record = makeRoundRecord({
    round: 1,
    agent: "executor",
    result,
    candidateBranch: "feature/branch-1",
    candidateHandoffId: "handoff-1",
    dispatchOk: true,
    reason: "check_passed_verified",
    checkPassed: true,
    checkVerifyStatus: "passed",
    verifierHandoffId: "verifier-h",
    verifierBranch: "feature/verifier",
    verified: true,
    passed: true,
  });
  expect(record.check_verify_status).toBe("passed");
  expect(record.verifier_handoff_id).toBe("verifier-h");
  expect(record.verifier_branch).toBe("feature/verifier");
  expect(record.verified).toBe(true);
  expect(record.passed).toBe(true);
});

test("makeRoundRecord builds a rubric record", () => {
  const result = fakeFanoutResult();
  const grade = { overall_pass: true, criteria: [] };
  const record = makeRoundRecord({
    round: 1,
    agent: "executor",
    result,
    candidateBranch: "feature/branch-1",
    candidateHandoffId: "handoff-1",
    dispatchOk: true,
    reason: "rubric_passed",
    checkPassed: true,
    checkVerifyStatus: "passed",
    rubricStatus: "PASSED",
    rubricGrade: grade,
    graderHandoffId: "grader-h",
    graderBranch: "feature/grader",
    verified: true,
    passed: true,
  });
  expect(record.rubric_status).toBe("PASSED");
  expect(record.rubric_grade).toEqual(grade);
  expect(record.grader_handoff_id).toBe("grader-h");
  expect(record.grader_branch).toBe("feature/grader");
  expect(record.passed).toBe(true);
});

test("makeRoundRecord does not leak response body", () => {
  const result = fakeFanoutResult({ response_text: "secret response body" });
  const record: RoundRecord = makeRoundRecord({
    round: 1,
    agent: "executor",
    result,
    candidateBranch: "feature/branch-1",
    candidateHandoffId: "handoff-1",
    dispatchOk: true,
    reason: "ok",
    checkPassed: true,
    checkVerifyStatus: "passed",
    passed: true,
  });
  const serialized = JSON.stringify(record);
  expect(serialized).not.toContain("secret response body");
});

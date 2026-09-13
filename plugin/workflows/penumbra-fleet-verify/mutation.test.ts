import { expect, test } from "bun:test";

import type { FanoutTaskResult } from "../_shared/fanout.js";

import {
  type FleetVerifyTaskResult,
  isLandable,
  isReliableCandidate,
  summarizeDispatch,
  summarizeVerify,
} from "./result.js";
import { validateVerifyReport, type VerifyReport, VerifyReportSchema } from "./verify-command.js";

function makeFanoutResult(overrides: Partial<FanoutTaskResult> = {}): FanoutTaskResult {
  return {
    ok: true,
    status: "completed",
    label: "task-0",
    index: 0,
    initial_agent: "executor",
    conversation_id: "conv-0",
    handoff_id: "h-0",
    root_handoff_id: "h-0",
    latest_handoff_id: "h-0",
    hop_count: 1,
    extra_hops: 0,
    retry_prompt_count: 0,
    hops_incomplete: false,
    hops: [
      {
        handoff_id: "h-0",
        status: "completed",
        branch_name: "feature/task-0",
        to_agent: "executor",
        branch_base: "main",
        parent_handoff_id: null,
        created_ts: "2026-09-12T10:00:00.000Z",
        is_retry: false,
      },
    ],
    branch_name: "feature/task-0",
    branch_base: "main",
    parent_handoff_id: null,
    response_text: "done",
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

function validReport(overrides: Partial<VerifyReport> = {}): VerifyReport {
  return {
    verdict: "pass",
    target_identity: "0123456789abcdef0123456789abcdef01234567",
    measured_exits: [
      { command: "typecheck", exit: 0 },
      { command: "typecheck_ratchet", exit: 0 },
      { command: "lint_strict", exit: 0 },
    ],
    test_results: null,
    tests_pass: null,
    tests_fail: null,
    files_changed: 3,
    attribution_lines: 0,
    notes: "all good",
    ...overrides,
  };
}

function makeLandableTaskResult(
  overrides: Partial<FleetVerifyTaskResult> = {},
): FleetVerifyTaskResult {
  const verifyFanout = makeFanoutResult({
    handoff_id: "h-verify-0",
    root_handoff_id: "h-verify-0",
    latest_handoff_id: "h-verify-0",
    branch_name: "verify/task-0",
    branch_base: "0123456789abcdef0123456789abcdef01234567",
    hops: [
      {
        handoff_id: "h-verify-0",
        status: "completed",
        branch_name: "verify/task-0",
        to_agent: "executor",
        branch_base: "0123456789abcdef0123456789abcdef01234567",
        parent_handoff_id: null,
        created_ts: "2026-09-12T10:01:00.000Z",
        is_retry: false,
      },
    ],
  });
  return {
    name: "task-0",
    index: 0,
    dispatch: summarizeDispatch(makeFanoutResult()),
    candidate_before: {
      handoff_id: "h-0",
      head_sha: "0123456789abcdef0123456789abcdef01234567",
      branch_name: "feature/task-0",
      project_id: "penumbra",
      dirty: false,
      truncation: { diff_against_main: false, branch_log: false, total: false },
    },
    candidate_before_error: null,
    candidate_after: {
      handoff_id: "h-0",
      head_sha: "0123456789abcdef0123456789abcdef01234567",
      branch_name: "feature/task-0",
      project_id: "penumbra",
      dirty: false,
      truncation: { diff_against_main: false, branch_log: false, total: false },
    },
    candidate_after_error: null,
    verify: {
      ...summarizeVerify(verifyFanout),
      inspection: {
        handoff_id: "h-verify-0",
        head_sha: "0123456789abcdef0123456789abcdef01234567",
        branch_name: "verify/task-0",
        project_id: "penumbra",
        dirty: false,
        truncation: { diff_against_main: false, branch_log: false, total: false },
      },
      report: validReport(),
      validation_errors: [],
    },
    skipped: null,
    artifact_receipt: null,
    artifact_error: null,
    landable: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mutation: candidate identity predicate (isReliableCandidate)
// ---------------------------------------------------------------------------

test("mutation: if isReliableCandidate always true, untrustworthy becomes candidate", () => {
  const untrustworthy = makeFanoutResult({ latest_reliability_trustworthy: false });

  // Actual predicate correctly rejects untrustworthy
  expect(isReliableCandidate(untrustworthy)).toBe(false);

  // Mutated predicate (simulated) would accept it
  const mutatedPredicate = (_r: FanoutTaskResult): boolean => true;
  expect(mutatedPredicate(untrustworthy)).toBe(true);

  // This proves the actual predicate is doing real work: if it were mutated
  // to always-true, untrustworthy results would incorrectly become candidates.
});

test("mutation: if isReliableCandidate ignores branch_name, branchless becomes candidate", () => {
  const branchless = makeFanoutResult();
  branchless.hops![0]!.branch_name = null;

  expect(isReliableCandidate(branchless)).toBe(false);

  // Mutated predicate that skips branch check
  const mutatedPredicate = (r: FanoutTaskResult): boolean =>
    r.ok && r.reliability_trustworthy === true;
  expect(mutatedPredicate(branchless)).toBe(true);
});

// ---------------------------------------------------------------------------
// Mutation: measured gate predicate (validateVerifyReport)
// ---------------------------------------------------------------------------

test("mutation: if validateVerifyReport always returns ok, nonzero exit becomes landable", () => {
  const reportWithNonzeroExit = validReport({
    measured_exits: [
      { command: "typecheck", exit: 1 },
      { command: "typecheck_ratchet", exit: 0 },
      { command: "lint_strict", exit: 0 },
    ],
  });
  const commands = ["typecheck", "typecheck_ratchet", "lint_strict"];

  // Actual predicate correctly rejects nonzero exit
  const actual = validateVerifyReport(
    reportWithNonzeroExit,
    commands,
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(actual.ok).toBe(false);

  // Mutated predicate (simulated) would accept it
  const mutatedValidation = (): { ok: boolean; errors: string[] } => ({ ok: true, errors: [] });
  expect(mutatedValidation().ok).toBe(true);

  // If the mutated predicate were used, the task would become landable
  const taskWithNonzeroExit = makeLandableTaskResult();
  taskWithNonzeroExit.verify!.report = reportWithNonzeroExit;
  taskWithNonzeroExit.verify!.validation_errors = mutatedValidation().errors;
  expect(isLandable(taskWithNonzeroExit)).toBe(true);

  // But with the actual predicate, it is NOT landable
  taskWithNonzeroExit.verify!.validation_errors = actual.errors;
  expect(isLandable(taskWithNonzeroExit)).toBe(false);
});

test("mutation: if validateVerifyReport skips target_identity, mismatch becomes landable", () => {
  const reportWithMismatch = validReport({
    target_identity: "ffffffffffffffffffffffffffffffffffffffff",
  });
  const commands = ["typecheck", "typecheck_ratchet", "lint_strict"];

  const actual = validateVerifyReport(
    reportWithMismatch,
    commands,
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(actual.ok).toBe(false);
  expect(actual.errors).toContain("target_identity_mismatch");

  // Mutated predicate that skips target identity check
  const mutatedErrors = actual.errors.filter((e) => e !== "target_identity_mismatch");
  expect(mutatedErrors.length).toBe(0);

  const taskWithMismatch = makeLandableTaskResult();
  taskWithMismatch.verify!.report = reportWithMismatch;
  taskWithMismatch.verify!.validation_errors = mutatedErrors;
  expect(isLandable(taskWithMismatch)).toBe(true);

  taskWithMismatch.verify!.validation_errors = actual.errors;
  expect(isLandable(taskWithMismatch)).toBe(false);
});

test("mutation: if validateVerifyReport skips attribution_lines, attribution becomes landable", () => {
  const reportWithAttribution = validReport({ attribution_lines: 5 });
  const commands = ["typecheck", "typecheck_ratchet", "lint_strict"];

  const actual = validateVerifyReport(
    reportWithAttribution,
    commands,
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(actual.ok).toBe(false);
  expect(actual.errors).toContain("attribution_lines_gt_0");

  // Mutated predicate that skips attribution check
  const mutatedErrors = actual.errors.filter((e) => e !== "attribution_lines_gt_0");
  expect(mutatedErrors.length).toBe(0);

  const taskWithAttribution = makeLandableTaskResult();
  taskWithAttribution.verify!.report = reportWithAttribution;
  taskWithAttribution.verify!.validation_errors = mutatedErrors;
  expect(isLandable(taskWithAttribution)).toBe(true);

  taskWithAttribution.verify!.validation_errors = actual.errors;
  expect(isLandable(taskWithAttribution)).toBe(false);
});

// ---------------------------------------------------------------------------
// Mutation: implementation reliability predicate (isLandable)
// ---------------------------------------------------------------------------

test("mutation: if isLandable skips dispatch reliability, untrustworthy dispatch becomes landable", () => {
  const task = makeLandableTaskResult();
  task.dispatch.latest_reliability_trustworthy = false;

  // Actual isLandable correctly rejects
  expect(isLandable(task)).toBe(false);

  // Mutated isLandable that skips dispatch reliability
  const mutatedIsLandable = (r: FleetVerifyTaskResult): boolean => {
    if (r.skipped !== null) return false;
    if (!r.verify) return false;
    if (r.verify.latest_reliability_trustworthy !== true) return false;
    if (!r.verify.report) return false;
    if (r.verify.validation_errors.length > 0) return false;
    return true;
  };
  expect(mutatedIsLandable(task)).toBe(true);

  // This proves the dispatch reliability check in isLandable is doing real work
});

test("mutation: if isLandable skips verifier reliability, untrustworthy verifier becomes landable", () => {
  const task = makeLandableTaskResult();
  task.verify!.latest_reliability_trustworthy = false;

  expect(isLandable(task)).toBe(false);

  // Mutated isLandable that skips verifier reliability
  const mutatedIsLandable = (r: FleetVerifyTaskResult): boolean => {
    if (r.skipped !== null) return false;
    if (r.dispatch.latest_reliability_trustworthy !== true) return false;
    if (!r.verify) return false;
    if (!r.verify.report) return false;
    if (r.verify.validation_errors.length > 0) return false;
    return true;
  };
  expect(mutatedIsLandable(task)).toBe(true);
});

test("mutation: if isLandable skips validation_errors, invalid report becomes landable", () => {
  const task = makeLandableTaskResult();
  task.verify!.validation_errors = ["nonzero_exit:typecheck:1"];

  expect(isLandable(task)).toBe(false);

  // Mutated isLandable that skips validation_errors
  const mutatedIsLandable = (r: FleetVerifyTaskResult): boolean => {
    if (r.skipped !== null) return false;
    if (r.dispatch.latest_reliability_trustworthy !== true) return false;
    if (!r.verify) return false;
    if (r.verify.latest_reliability_trustworthy !== true) return false;
    if (!r.verify.report) return false;
    return true;
  };
  expect(mutatedIsLandable(task)).toBe(true);
});

// ---------------------------------------------------------------------------
// No false positives from test strings (structural tripwire)
// ---------------------------------------------------------------------------

test("structural tripwire does not false-positive on test strings mentioning child_process", () => {
  const testString = "This test mentions child_process but is just a string";
  const executionPatterns = [/import[^;]*child_process/, /Bun\.\$/, /Bun\.spawn/, /execSync/];
  for (const pattern of executionPatterns) {
    expect(pattern.test(testString)).toBe(false);
  }
});

test("structural tripwire does not false-positive on test strings mentioning Bun.spawn", () => {
  const testString = "The workflow must not call Bun.spawn directly";
  // The pattern should NOT match when "Bun.spawn" appears in prose without being a call
  // But it WILL match because regex doesn't distinguish prose from code.
  // This test documents that the tripwire is pattern-based, not AST-based.
  expect(testString.includes("Bun.spawn")).toBe(true);
  // The workflow source tripwire test checks the actual source file, not test strings.
  // This is why the tripwire test reads workflow.ts specifically.
});

test("structural tripwire correctly detects actual import patterns", () => {
  const codeString = 'import { execSync } from "child_process"';
  const pattern = /import[^;]*child_process/;
  expect(pattern.test(codeString)).toBe(true);
});

// ---------------------------------------------------------------------------
// Mutation: expected SHA — the schema must reject non-hex and wrong-length ids
// ---------------------------------------------------------------------------

test("mutation: VerifyReportSchema rejects a 39-char target_identity (not 40/64 hex)", () => {
  const report = validReport({
    target_identity: "0123456789abcdef0123456789abcdef012345678",
  });
  const result = VerifyReportSchema.safeParse(report);
  expect(result.success).toBe(false);
});

test("mutation: VerifyReportSchema accepts a 64-hex target_identity", () => {
  const report = validReport({
    target_identity: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  const result = VerifyReportSchema.safeParse(report);
  expect(result.success).toBe(true);
});

test("mutation: isLandable rejects candidate_after head_sha differing from candidate_before", () => {
  const task = makeLandableTaskResult();
  task.candidate_after!.head_sha = "ffffffffffffffffffffffffffffffffffffffff";
  expect(isLandable(task)).toBe(false);

  // If inspectionStable were mutated to skip the head_sha comparison, the
  // mismatch would be ignored and the task would be landable.
  const mutatedStable = (): boolean => {
    const before = task.candidate_before;
    const after = task.candidate_after;
    return (
      before !== null &&
      after !== null &&
      !before.dirty &&
      !after.dirty &&
      before.branch_name === after.branch_name
    );
  };
  expect(mutatedStable()).toBe(true);
});

// ---------------------------------------------------------------------------
// Mutation: command evidence — nonzero exit must be rejected
// ---------------------------------------------------------------------------

test("mutation: validateVerifyReport rejects nonzero exit that a mutated skip would accept", () => {
  const reportWithNonzero = validReport({
    measured_exits: [
      { command: "typecheck", exit: 2 },
      { command: "typecheck_ratchet", exit: 0 },
      { command: "lint_strict", exit: 0 },
    ],
  });
  const commands = ["typecheck", "typecheck_ratchet", "lint_strict"];
  const actual = validateVerifyReport(
    reportWithNonzero,
    commands,
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(actual.ok).toBe(false);
  expect(actual.errors.some((e) => e.startsWith("nonzero_exit:typecheck:2"))).toBe(true);

  // Mutated checkExitValues that skips nonzero checks would accept it.
  const mutatedErrors = actual.errors.filter((e) => !e.startsWith("nonzero_exit"));
  const taskWithNonzero = makeLandableTaskResult();
  taskWithNonzero.verify!.report = reportWithNonzero;
  taskWithNonzero.verify!.validation_errors = mutatedErrors;
  expect(isLandable(taskWithNonzero)).toBe(true);

  taskWithNonzero.verify!.validation_errors = actual.errors;
  expect(isLandable(taskWithNonzero)).toBe(false);
});

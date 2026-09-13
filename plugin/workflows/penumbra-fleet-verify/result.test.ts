import { expect, test } from "bun:test";

import type { FanoutTaskResult } from "../_shared/fanout.js";
import type { VerifyReport } from "./verify-command.js";

import {
  buildFinalResult,
  type FleetVerifyTaskResult,
  isLandable,
  isReliableCandidate,
  summarizeDispatch,
  summarizeVerify,
} from "./result.js";

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

function makeTaskResult(overrides: Partial<FleetVerifyTaskResult> = {}): FleetVerifyTaskResult {
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
// summarizeDispatch
// ---------------------------------------------------------------------------

test("summarizeDispatch extracts key fields from FanoutTaskResult", () => {
  const s = summarizeDispatch(makeFanoutResult());
  expect(s).toEqual(expect.objectContaining({ ok: true, status: "completed" }));
  expect(s.handoff_id).toBe("h-0");
  expect(s.branch_name).toBe("feature/task-0");
  expect(s.reliability_trustworthy).toBe(true);
  expect(s.reliability_status).toBe("complete");
});

// ---------------------------------------------------------------------------
// isReliableCandidate
// ---------------------------------------------------------------------------

test("isReliableCandidate accepts ok trustworthy with branch", () => {
  expect(isReliableCandidate(makeFanoutResult())).toBe(true);
});

test("isReliableCandidate rejects untrustworthy result", () => {
  expect(isReliableCandidate(makeFanoutResult({ latest_reliability_trustworthy: false }))).toBe(
    false,
  );
});

test("isReliableCandidate rejects null trustworthy", () => {
  expect(isReliableCandidate(makeFanoutResult({ latest_reliability_trustworthy: null }))).toBe(
    false,
  );
});

test("isReliableCandidate rejects missing branch_name", () => {
  const result = makeFanoutResult();
  result.hops![0]!.branch_name = null;
  expect(isReliableCandidate(result)).toBe(false);
});

test("isReliableCandidate rejects empty branch_name", () => {
  const result = makeFanoutResult();
  result.hops![0]!.branch_name = "";
  expect(isReliableCandidate(result)).toBe(false);
});

test("isReliableCandidate rejects failed result", () => {
  expect(isReliableCandidate(makeFanoutResult({ status: "failed" }))).toBe(false);
});

test("isReliableCandidate rejects an untrustworthy latest hop despite trustworthy root evidence", () => {
  expect(
    isReliableCandidate(
      makeFanoutResult({
        reliability_trustworthy: true,
        latest_reliability_trustworthy: false,
      }),
    ),
  ).toBe(false);
});

test("isReliableCandidate qualifies trustworthy latest evidence independently of the root", () => {
  expect(
    isReliableCandidate(
      makeFanoutResult({
        ok: false,
        reliability_status: "no_worktree_activity",
        reliability_trustworthy: false,
        reliability_action: "review_manually",
        latest_reliability_status: "complete",
        latest_reliability_trustworthy: true,
        latest_reliability_action: "accept",
        error_summary: "reliability_untrustworthy",
      }),
    ),
  ).toBe(true);
});

test("isReliableCandidate rejects duplicate matches for latest_handoff_id", () => {
  const result = makeFanoutResult();
  result.hops = [...result.hops!, { ...result.hops![0]! }];
  expect(isReliableCandidate(result)).toBe(false);
});

test("summaries preserve root and latest reliability as separate evidence", () => {
  const summary = summarizeDispatch(
    makeFanoutResult({
      reliability_status: "no_worktree_activity",
      reliability_trustworthy: false,
      reliability_action: "review_manually",
      latest_reliability_status: "complete",
      latest_reliability_trustworthy: true,
      latest_reliability_action: "accept",
    }),
  );
  expect(summary.reliability_trustworthy).toBe(false);
  expect(summary.latest_reliability_trustworthy).toBe(true);
  expect(summary.branch_name).toBe("feature/task-0");
  expect(summary.latest_branch_name).toBe("feature/task-0");
});

// ---------------------------------------------------------------------------
// isLandable
// ---------------------------------------------------------------------------

test("isLandable accepts fully trustworthy verified result", () => {
  expect(isLandable(makeTaskResult())).toBe(true);
});

test("isLandable rejects skipped result", () => {
  expect(isLandable(makeTaskResult({ skipped: "no-branch" }))).toBe(false);
});

test("isLandable rejects untrustworthy dispatch", () => {
  const r = makeTaskResult();
  r.dispatch.latest_reliability_trustworthy = false;
  expect(isLandable(r)).toBe(false);
});

test("isLandable rejects failed implementation lifecycle despite trustworthy evidence", () => {
  const r = makeTaskResult();
  Object.assign(r.dispatch, { ok: false, status: "failed" });
  expect(isLandable(r)).toBe(false);
});

test("isLandable rejects null verify", () => {
  expect(isLandable(makeTaskResult({ verify: null }))).toBe(false);
});

test("isLandable rejects untrustworthy verifier", () => {
  const r = makeTaskResult();
  r.verify!.latest_reliability_trustworthy = false;
  expect(isLandable(r)).toBe(false);
});

test("isLandable rejects failed verifier lifecycle despite trustworthy PASS", () => {
  const r = makeTaskResult();
  Object.assign(r.verify!, { ok: false, status: "failed" });
  expect(isLandable(r)).toBe(false);
});

test("isLandable rejects missing report", () => {
  const r = makeTaskResult();
  r.verify!.report = null;
  expect(isLandable(r)).toBe(false);
});

test("isLandable rejects validation errors", () => {
  const r = makeTaskResult();
  r.verify!.validation_errors = ["nonzero_exit:typecheck:1"];
  expect(isLandable(r)).toBe(false);
});

test("isLandable rejects explicit fail verdict", () => {
  const r = makeTaskResult();
  r.verify!.report = validReport({ verdict: "fail" });
  expect(isLandable(r)).toBe(false);
});

test("schema-valid PASS from untrustworthy verifier is not landable", () => {
  const r = makeTaskResult();
  r.verify!.latest_reliability_trustworthy = false;
  r.verify!.report = validReport({ verdict: "pass" });
  r.verify!.validation_errors = [];
  expect(isLandable(r)).toBe(false);
});

test("schema-valid PASS from an untrustworthy latest verifier hop is not landable", () => {
  const r = makeTaskResult();
  r.verify!.reliability_trustworthy = true;
  r.verify!.latest_reliability_trustworthy = false;
  expect(isLandable(r)).toBe(false);
});

// ---------------------------------------------------------------------------
// buildFinalResult
// ---------------------------------------------------------------------------

test("buildFinalResult produces ranNothingToMain literal true", () => {
  const result = buildFinalResult([makeTaskResult()]);
  expect(result.ranNothingToMain).toBe(true);
  expect(result.ranNothingToMain).toStrictEqual(true);
});

test("buildFinalResult counts landable, failed, skipped correctly", () => {
  const results = [
    makeTaskResult({ name: "pass-1", index: 0 }),
    makeTaskResult({
      name: "skip-1",
      index: 1,
      skipped: "no-branch",
      verify: null,
      landable: false,
    }),
    makeTaskResult({
      name: "fail-1",
      index: 2,
      verify: {
        ...summarizeVerify(makeFanoutResult()),
        report: null,
        parse_error: "no_json_block",
        validation_errors: [],
      },
      landable: false,
    }),
  ];
  const result = buildFinalResult(results);
  expect(result.total).toBe(3);
  expect(result.landable_count).toBe(1);
  expect(result.skipped_count).toBe(1);
  expect(result.failed_count).toBe(1);
});

test("buildFinalResult ok is true only when all landable and none skipped", () => {
  const allLandable = buildFinalResult([
    makeTaskResult({ index: 0 }),
    makeTaskResult({ name: "task-1", index: 1 }),
  ]);
  expect(allLandable.ok).toBe(true);

  const hasFailure = buildFinalResult([
    makeTaskResult({ index: 0 }),
    makeTaskResult({
      name: "task-1",
      index: 1,
      verify: null,
      skipped: "no-branch",
      landable: false,
    }),
  ]);
  expect(hasFailure.ok).toBe(false);
});

test("buildFinalResult preserves input order in results", () => {
  const results = [
    makeTaskResult({ name: "z-task", index: 0 }),
    makeTaskResult({ name: "a-task", index: 1 }),
    makeTaskResult({ name: "m-task", index: 2 }),
  ];
  const result = buildFinalResult(results);
  expect(result.results.map((r) => r.name)).toEqual(["z-task", "a-task", "m-task"]);
  expect(result.results.map((r) => r.index)).toEqual([0, 1, 2]);
});

test("buildFinalResult includes landable entries with both handoff IDs", () => {
  const results = [
    makeTaskResult({
      name: "task-0",
      index: 0,
      dispatch: summarizeDispatch(
        makeFanoutResult({
          handoff_id: "h-dispatch-0",
          latest_handoff_id: "h-dispatch-0",
          hops: [
            {
              handoff_id: "h-dispatch-0",
              status: "completed",
              branch_name: "feature/task-0",
              to_agent: "executor",
              branch_base: "main",
              parent_handoff_id: null,
              created_ts: "2026-09-12T10:00:00.000Z",
              is_retry: false,
            },
          ],
        }),
      ),
      candidate_before: {
        handoff_id: "h-dispatch-0",
        head_sha: "0123456789abcdef0123456789abcdef01234567",
        branch_name: "feature/task-0",
        project_id: "penumbra",
        dirty: false,
        truncation: { diff_against_main: false, branch_log: false, total: false },
      },
      candidate_after: {
        handoff_id: "h-dispatch-0",
        head_sha: "0123456789abcdef0123456789abcdef01234567",
        branch_name: "feature/task-0",
        project_id: "penumbra",
        dirty: false,
        truncation: { diff_against_main: false, branch_log: false, total: false },
      },
      verify: {
        ...summarizeVerify(
          makeFanoutResult({
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
          }),
        ),
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
    }),
  ];
  const result = buildFinalResult(results);
  expect(result.landable).toHaveLength(1);
  expect(result.landable[0]?.dispatch_handoff_id).toBe("h-dispatch-0");
  expect(result.landable[0]?.verify_handoff_id).toBe("h-verify-0");
  expect(result.landable[0]?.branch).toBe("feature/task-0");
});

test("buildFinalResult includes artifacts list", () => {
  const result = buildFinalResult([makeTaskResult({ artifact_receipt: "/tmp/report-0.json" })]);
  expect(result.artifacts).toEqual(["/tmp/report-0.json"]);
});

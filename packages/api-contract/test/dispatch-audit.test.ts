import { expect, test } from "bun:test";

import {
  CommitIntegrityEvidenceSchema,
  DispatchAuditResponseSchema,
  DispatchRecommendedActionSchema,
  DispatchReliabilityReportSchema,
  DispatchReliabilityStatusSchema,
} from "../src/index.js";

const EVIDENCE = {
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  base_is_ancestor: false,
  identity: { name: "Penumbra Worker", email: "worker@example.com" },
  mismatched_commits: ["c".repeat(40)],
};

test("DispatchReliabilityStatusSchema enumerates exactly 16 statuses in order", () => {
  expect(DispatchReliabilityStatusSchema.options).toEqual([
    "complete",
    "missing_dispatch_start",
    "missing_adapter_lifecycle",
    "missing_dispatch_end",
    "non_terminal_stale",
    "cancel_completed",
    "watchdog_only",
    "base_not_ancestor",
    "commit_identity_mismatch",
    "no_agent_output",
    "no_worktree_activity",
    "tool_failure_with_end_turn",
    "end_turn_without_return_block",
    "reconcile_missing",
    "agent_declared_done_unverified",
    "timeline_inconsistent",
  ]);
});

test("DispatchReliabilityStatusSchema rejects a 17th status", () => {
  expect(DispatchReliabilityStatusSchema.safeParse("unknown_status").success).toBe(false);
});

test("DispatchRecommendedActionSchema enumerates exactly 6 actions in order", () => {
  expect(DispatchRecommendedActionSchema.options).toEqual([
    "wait",
    "inspect_worktree",
    "cancel",
    "retry",
    "review_manually",
    "accept",
  ]);
});

test("DispatchRecommendedActionSchema rejects a 7th action", () => {
  expect(DispatchRecommendedActionSchema.safeParse("force").success).toBe(false);
});

test("DispatchReliabilityReportSchema is loose and validates a complete report", () => {
  const report = {
    handoff_id: "h1",
    status: "complete",
    terminal: true,
    trustworthy: true,
    summary: "all good",
    missing_events: [],
    evidence: {
      handoff_status: "completed",
      event_count: 5,
      response_count: 1,
      worktree_changed: true,
      dispatch_end_committed: true,
      reconciled: null,
      watchdog_failed: false,
      cancel_requested: false,
      adapter_streaming: null,
    },
    recommended_action: "accept",
    extra_field: "allowed because loose",
  };
  expect(DispatchReliabilityReportSchema.safeParse(report).success).toBe(true);
});

test("DispatchReliabilityReportSchema accepts optional classifier_decline", () => {
  const report = {
    handoff_id: "h1",
    status: "no_agent_output",
    terminal: true,
    trustworthy: false,
    summary: "no output",
    missing_events: [],
    evidence: {
      handoff_status: "completed",
      event_count: 3,
      response_count: 0,
      worktree_changed: null,
      dispatch_end_committed: null,
      reconciled: null,
      watchdog_failed: false,
      cancel_requested: false,
      adapter_streaming: null,
    },
    recommended_action: "retry",
    classifier_decline: {
      classifier_declined: true,
      decline_reason: "timeout",
    },
  };
  expect(DispatchReliabilityReportSchema.safeParse(report).success).toBe(true);
});

test("DispatchReliabilityReportSchema evidence is loose", () => {
  const report = {
    handoff_id: "h1",
    status: "complete",
    terminal: true,
    trustworthy: true,
    summary: "ok",
    missing_events: [],
    evidence: {
      handoff_status: "completed",
      event_count: 1,
      response_count: 0,
      worktree_changed: null,
      dispatch_end_committed: null,
      reconciled: null,
      watchdog_failed: false,
      cancel_requested: false,
      adapter_streaming: null,
      extra_evidence: "allowed",
    },
    recommended_action: "accept",
  };
  expect(DispatchReliabilityReportSchema.safeParse(report).success).toBe(true);
});

test("DispatchAuditResponseSchema is loose {report}", () => {
  const response = {
    report: {
      handoff_id: "h1",
      status: "complete",
      terminal: true,
      trustworthy: true,
      summary: "ok",
      missing_events: [],
      evidence: {
        handoff_status: "completed",
        event_count: 1,
        response_count: 1,
        worktree_changed: true,
        dispatch_end_committed: true,
        reconciled: null,
        watchdog_failed: false,
        cancel_requested: false,
        adapter_streaming: null,
      },
      recommended_action: "accept",
    },
    extra: "allowed",
  };
  expect(Reflect.get(DispatchAuditResponseSchema.parse(response), "extra")).toBe("allowed");
});

test("DispatchAuditResponseSchema rejects missing report", () => {
  expect(DispatchAuditResponseSchema.safeParse({}).success).toBe(false);
});

test("CommitIntegrityEvidenceSchema accepts complete evidence", () => {
  expect(CommitIntegrityEvidenceSchema.safeParse(EVIDENCE).success).toBe(true);
});

test("CommitIntegrityEvidenceSchema accepts a mismatched_total count or null", () => {
  expect(
    CommitIntegrityEvidenceSchema.safeParse({ ...EVIDENCE, mismatched_total: 12 }).success,
  ).toBe(true);
  expect(
    CommitIntegrityEvidenceSchema.safeParse({ ...EVIDENCE, mismatched_total: null }).success,
  ).toBe(true);
});

test("CommitIntegrityEvidenceSchema rejects a negative or fractional mismatched_total", () => {
  expect(
    CommitIntegrityEvidenceSchema.safeParse({ ...EVIDENCE, mismatched_total: -1 }).success,
  ).toBe(false);
  expect(
    CommitIntegrityEvidenceSchema.safeParse({ ...EVIDENCE, mismatched_total: 1.5 }).success,
  ).toBe(false);
});

test("CommitIntegrityEvidenceSchema rejects non-boolean base_is_ancestor", () => {
  expect(
    CommitIntegrityEvidenceSchema.safeParse({ ...EVIDENCE, base_is_ancestor: "no" }).success,
  ).toBe(false);
});

test("CommitIntegrityEvidenceSchema rejects malformed mismatched commit sha", () => {
  expect(
    CommitIntegrityEvidenceSchema.safeParse({ ...EVIDENCE, mismatched_commits: ["not-a-sha"] })
      .success,
  ).toBe(false);
});

test("DispatchReliabilityReportSchema accepts evidence with commit_integrity", () => {
  const report = {
    handoff_id: "h1",
    status: "complete",
    terminal: true,
    trustworthy: true,
    summary: "all good",
    missing_events: [],
    evidence: {
      handoff_status: "completed",
      event_count: 5,
      response_count: 1,
      worktree_changed: true,
      dispatch_end_committed: true,
      reconciled: null,
      watchdog_failed: false,
      cancel_requested: false,
      adapter_streaming: null,
      commit_integrity: EVIDENCE,
    },
    recommended_action: "accept",
    extra_field: "allowed because loose",
  };
  expect(DispatchReliabilityReportSchema.safeParse(report).success).toBe(true);
});

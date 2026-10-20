import { expect, test } from "bun:test";

import {
  DispatchAuditResponseSchema,
  DispatchRecommendedActionSchema,
  DispatchReliabilityReportSchema,
  DispatchReliabilityStatusSchema,
} from "../src/index.js";

test("DispatchReliabilityStatusSchema enumerates exactly 14 statuses in order", () => {
  expect(DispatchReliabilityStatusSchema.options).toEqual([
    "complete",
    "missing_dispatch_start",
    "missing_adapter_lifecycle",
    "missing_dispatch_end",
    "non_terminal_stale",
    "cancel_completed",
    "watchdog_only",
    "no_agent_output",
    "no_worktree_activity",
    "tool_failure_with_end_turn",
    "end_turn_without_return_block",
    "reconcile_missing",
    "agent_declared_done_unverified",
    "timeline_inconsistent",
  ]);
});

test("DispatchReliabilityStatusSchema rejects a 15th status", () => {
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

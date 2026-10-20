import { describe, expect, test } from "bun:test";

import {
  classifyDispatchReliability,
  type DispatchReliabilityInput,
} from "@src/services/dispatch-reliability.js";

function baseInput(overrides: Partial<DispatchReliabilityInput> = {}): DispatchReliabilityInput {
  return {
    handoff: {
      handoff_id: "h-1",
      status: "completed",
      ts: "2026-05-01T00:00:00.000Z",
      resolved_at: "2026-05-01T00:00:10.000Z",
      cancel_requested_at: null,
      chain_task_type: "implement_small",
      use_worktree: 1,
    },
    events: [
      { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
      { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
      { kind: "proc.exited.resolved", ts: "2026-05-01T00:00:08.000Z" },
      { kind: "dispatch.end", ts: "2026-05-01T00:00:09.000Z", meta: { status: "ok" } },
    ],
    responseCount: 1,
    finalResponseText: "DONE",
    worktreeChanged: true,
    dispatchEndCommitted: true,
    reconciled: true,
    adapterStreaming: true,
    now: new Date("2026-05-01T00:00:20.000Z"),
    staleAfterMs: 120_000,
    ...overrides,
  };
}

function nonMutatingInput(
  taskType: string,
  extra: Partial<DispatchReliabilityInput> = {},
): DispatchReliabilityInput {
  return baseInput({
    handoff: {
      handoff_id: "h-1",
      status: "completed",
      ts: "2026-05-01T00:00:00.000Z",
      resolved_at: "2026-05-01T00:00:10.000Z",
      cancel_requested_at: null,
      chain_task_type: taskType,
      use_worktree: 1,
    },
    ...extra,
  });
}

describe("classifyDispatchReliability", () => {
  test("returns complete for a terminal handoff with lifecycle and artifact evidence", () => {
    const report = classifyDispatchReliability(baseInput());
    expect(report.status).toBe("complete");
    expect(report.trustworthy).toBe(true);
    expect(report.recommended_action).toBe("accept");
    expect(report.missing_events).toEqual([]);
  });

  test("detects missing dispatch.start", () => {
    const report = classifyDispatchReliability(
      baseInput({
        events: [
          { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
          { kind: "dispatch.end", ts: "2026-05-01T00:00:09.000Z" },
        ],
      }),
    );
    expect(report.status).toBe("missing_dispatch_start");
    expect(report.trustworthy).toBe(false);
    expect(report.missing_events).toEqual(["dispatch.start"]);
  });

  test("detects missing adapter lifecycle", () => {
    const report = classifyDispatchReliability(
      baseInput({
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "dispatch.end", ts: "2026-05-01T00:00:09.000Z" },
        ],
      }),
    );
    expect(report.status).toBe("missing_adapter_lifecycle");
    expect(report.missing_events).toContain("adapter.lifecycle");
  });

  test("detects missing dispatch.end", () => {
    const report = classifyDispatchReliability(
      baseInput({
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
          { kind: "proc.exited.resolved", ts: "2026-05-01T00:00:08.000Z" },
        ],
      }),
    );
    expect(report.status).toBe("missing_dispatch_end");
    expect(report.missing_events).toEqual(["dispatch.end"]);
  });

  test("detects stale non-terminal handoff", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: {
          handoff_id: "h-1",
          status: "dispatched",
          ts: "2026-05-01T00:00:00.000Z",
          resolved_at: null,
          cancel_requested_at: null,
          chain_task_type: "implement_small",
          use_worktree: 1,
        },
        events: [{ kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" }],
        now: new Date("2026-05-01T00:10:00.000Z"),
      }),
    );
    expect(report.status).toBe("non_terminal_stale");
    expect(report.recommended_action).toBe("inspect_worktree");
  });

  test("detects cancel-requested handoff that completed", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: {
          handoff_id: "h-1",
          status: "completed",
          ts: "2026-05-01T00:00:00.000Z",
          resolved_at: "2026-05-01T00:00:10.000Z",
          cancel_requested_at: "2026-05-01T00:00:05.000Z",
          chain_task_type: "implement_small",
          use_worktree: 1,
        },
      }),
    );
    expect(report.status).toBe("cancel_completed");
    expect(report.trustworthy).toBe(false);
  });

  test("detects watchdog-only failure", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: {
          handoff_id: "h-1",
          status: "failed",
          ts: "2026-05-01T00:00:00.000Z",
          resolved_at: "2026-05-01T00:01:00.000Z",
          cancel_requested_at: null,
          chain_task_type: "implement_small",
          use_worktree: 1,
        },
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
          { kind: "watchdog.auto_fail", ts: "2026-05-01T00:01:00.000Z" },
        ],
      }),
    );
    expect(report.status).toBe("watchdog_only");
    expect(report.recommended_action).toBe("retry");
  });

  test("detects empty agent output", () => {
    const report = classifyDispatchReliability(
      baseInput({
        responseCount: 0,
        finalResponseText: "",
      }),
    );
    expect(report.status).toBe("no_agent_output");
    expect(report.recommended_action).toBe("retry");
  });

  test("detects implementation completion without artifact evidence", () => {
    const report = classifyDispatchReliability(
      baseInput({
        worktreeChanged: false,
        reconciled: false,
      }),
    );
    expect(report.status).toBe("no_worktree_activity");
    expect(report.recommended_action).toBe("review_manually");
  });

  test("detects changed worktree with missing reconciliation", () => {
    const report = classifyDispatchReliability(
      baseInput({
        worktreeChanged: true,
        reconciled: false,
      }),
    );
    expect(report.status).toBe("reconcile_missing");
  });

  test("detects tool failure with end_turn and worktree changed (silent commit pattern)", () => {
    const report = classifyDispatchReliability(
      baseInput({
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
          { kind: "agent.tool_call.failed", ts: "2026-05-01T00:00:05.000Z" },
          {
            kind: "acp.session.end",
            ts: "2026-05-01T00:00:08.000Z",
            meta: { stop_reason: "end_turn" },
          },
          { kind: "proc.exited.resolved", ts: "2026-05-01T00:00:08.500Z" },
          { kind: "dispatch.end", ts: "2026-05-01T00:00:09.000Z", meta: { status: "ok" } },
        ],
        worktreeChanged: true,
        dispatchEndCommitted: false,
        reconciled: true,
      }),
    );
    expect(report.status).toBe("tool_failure_with_end_turn");
    expect(report.trustworthy).toBe(false);
    expect(report.recommended_action).toBe("retry");
  });

  test("tool failure with end_turn and committed dispatch is recovered", () => {
    const report = classifyDispatchReliability(
      baseInput({
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
          { kind: "agent.tool_call.failed", ts: "2026-05-01T00:00:05.000Z" },
          {
            kind: "acp.session.end",
            ts: "2026-05-01T00:00:08.000Z",
            meta: { stop_reason: "end_turn" },
          },
          { kind: "proc.exited.resolved", ts: "2026-05-01T00:00:08.500Z" },
          {
            kind: "dispatch.end",
            ts: "2026-05-01T00:00:09.000Z",
            meta: { status: "ok", committed: true },
          },
        ],
        worktreeChanged: true,
        dispatchEndCommitted: true,
        reconciled: true,
      }),
    );
    expect(report.status).toBe("complete");
    expect(report.trustworthy).toBe(true);
  });

  test("tool failure with end_turn and unknown commit remains unrecovered", () => {
    const report = classifyDispatchReliability(
      baseInput({
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
          { kind: "agent.tool_call.failed", ts: "2026-05-01T00:00:05.000Z" },
          {
            kind: "acp.session.end",
            ts: "2026-05-01T00:00:08.000Z",
            meta: { stop_reason: "end_turn" },
          },
          { kind: "proc.exited.resolved", ts: "2026-05-01T00:00:08.500Z" },
          { kind: "dispatch.end", ts: "2026-05-01T00:00:09.000Z", meta: { status: "ok" } },
        ],
        worktreeChanged: true,
        dispatchEndCommitted: null,
        reconciled: true,
      }),
    );
    expect(report.status).toBe("tool_failure_with_end_turn");
    expect(report.trustworthy).toBe(false);
  });

  test("no tool failure with worktree changed still classifies as complete", () => {
    const report = classifyDispatchReliability(
      baseInput({
        worktreeChanged: true,
        reconciled: true,
      }),
    );
    expect(report.status).toBe("complete");
    expect(report.trustworthy).toBe(true);
  });

  test("tool failure with worktree NOT changed yields no_worktree_activity (precedence)", () => {
    const report = classifyDispatchReliability(
      baseInput({
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
          { kind: "agent.tool_call.failed", ts: "2026-05-01T00:00:05.000Z" },
          {
            kind: "acp.session.end",
            ts: "2026-05-01T00:00:08.000Z",
            meta: { stop_reason: "end_turn" },
          },
          { kind: "proc.exited.resolved", ts: "2026-05-01T00:00:08.500Z" },
          { kind: "dispatch.end", ts: "2026-05-01T00:00:09.000Z" },
        ],
        worktreeChanged: false,
        dispatchEndCommitted: false,
        reconciled: false,
      }),
    );
    expect(report.status).toBe("no_worktree_activity");
  });

  test("non-terminal handoff past stale threshold but with recent activity is NOT stale", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: {
          handoff_id: "h-1",
          status: "dispatched",
          ts: "2026-05-01T00:00:00.000Z",
          resolved_at: null,
          cancel_requested_at: null,
          chain_task_type: "implement_small",
          use_worktree: 1,
        },
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
          { kind: "agent.thought", ts: "2026-05-01T00:09:30.000Z" },
        ],
        now: new Date("2026-05-01T00:10:00.000Z"),
        staleAfterMs: 300_000,
        activityIdleMs: 90_000,
      }),
    );
    expect(report.status).not.toBe("non_terminal_stale");
  });

  test("non-terminal handoff past stale threshold with no recent activity is stale", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: {
          handoff_id: "h-1",
          status: "dispatched",
          ts: "2026-05-01T00:00:00.000Z",
          resolved_at: null,
          cancel_requested_at: null,
          chain_task_type: "implement_small",
          use_worktree: 1,
        },
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
          { kind: "agent.thought", ts: "2026-05-01T00:05:00.000Z" },
        ],
        now: new Date("2026-05-01T00:10:00.000Z"),
        staleAfterMs: 300_000,
        activityIdleMs: 90_000,
      }),
    );
    expect(report.status).toBe("non_terminal_stale");
  });

  test("non-terminal handoff under handoff threshold with recent activity is not stale (short-circuits)", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: {
          handoff_id: "h-1",
          status: "dispatched",
          ts: "2026-05-01T00:00:00.000Z",
          resolved_at: null,
          cancel_requested_at: null,
          chain_task_type: "implement_small",
          use_worktree: 1,
        },
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "agent.thought", ts: "2026-05-01T00:01:30.000Z" },
        ],
        now: new Date("2026-05-01T00:02:00.000Z"),
        staleAfterMs: 300_000,
        activityIdleMs: 90_000,
      }),
    );
    expect(report.status).not.toBe("non_terminal_stale");
  });

  test("non-terminal handoff past stale threshold with zero events is stale (falls back to handoff.ts)", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: {
          handoff_id: "h-1",
          status: "dispatched",
          ts: "2026-05-01T00:00:00.000Z",
          resolved_at: null,
          cancel_requested_at: null,
          chain_task_type: "implement_small",
          use_worktree: 1,
        },
        events: [],
        now: new Date("2026-05-01T00:10:00.000Z"),
        staleAfterMs: 300_000,
        activityIdleMs: 90_000,
      }),
    );
    expect(report.status).toBe("non_terminal_stale");
  });

  test("review task in clean worktree is complete", () => {
    const report = classifyDispatchReliability(
      nonMutatingInput("review_adversarial", { worktreeChanged: false, reconciled: false }),
    );
    expect(report.status).toBe("complete");
    expect(report.trustworthy).toBe(true);
    expect(report.recommended_action).toBe("accept");
    expect(report.missing_events).toEqual([]);
  });

  test("smoke_test task in clean worktree is complete", () => {
    const report = classifyDispatchReliability(
      nonMutatingInput("smoke_test", { worktreeChanged: false, reconciled: false }),
    );
    expect(report.status).toBe("complete");
    expect(report.trustworthy).toBe(true);
    expect(report.recommended_action).toBe("accept");
  });

  test("health_check task in clean worktree is complete", () => {
    const report = classifyDispatchReliability(
      nonMutatingInput("health_check", { worktreeChanged: false, reconciled: false }),
    );
    expect(report.status).toBe("complete");
    expect(report.trustworthy).toBe(true);
    expect(report.recommended_action).toBe("accept");
  });

  test("review task missing adapter lifecycle is still missing_adapter_lifecycle", () => {
    const report = classifyDispatchReliability(
      nonMutatingInput("review_adversarial", {
        worktreeChanged: false,
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "dispatch.end", ts: "2026-05-01T00:00:09.000Z" },
        ],
      }),
    );
    expect(report.status).toBe("missing_adapter_lifecycle");
    expect(report.trustworthy).toBe(false);
    expect(report.missing_events).toContain("adapter.lifecycle");
  });

  test("review task with dirty worktree and failed tool is still tool_failure_with_end_turn", () => {
    const report = classifyDispatchReliability(
      nonMutatingInput("review_adversarial", {
        worktreeChanged: true,
        dispatchEndCommitted: false,
        reconciled: true,
        events: [
          { kind: "dispatch.start", ts: "2026-05-01T00:00:01.000Z" },
          { kind: "proc.spawn", ts: "2026-05-01T00:00:02.000Z" },
          { kind: "agent.tool_call.failed", ts: "2026-05-01T00:00:05.000Z" },
          {
            kind: "acp.session.end",
            ts: "2026-05-01T00:00:08.000Z",
            meta: { stop_reason: "end_turn" },
          },
          { kind: "proc.exited.resolved", ts: "2026-05-01T00:00:08.500Z" },
          { kind: "dispatch.end", ts: "2026-05-01T00:00:09.000Z", meta: { status: "ok" } },
        ],
      }),
    );
    expect(report.status).toBe("tool_failure_with_end_turn");
    expect(report.trustworthy).toBe(false);
  });

  test("implement_small with use_worktree=false still requires worktree activity", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: {
          handoff_id: "h-1",
          status: "completed",
          ts: "2026-05-01T00:00:00.000Z",
          resolved_at: "2026-05-01T00:00:10.000Z",
          cancel_requested_at: null,
          chain_task_type: "implement_small",
          use_worktree: 0,
        },
        worktreeChanged: false,
        reconciled: false,
      }),
    );
    expect(report.status).toBe("no_worktree_activity");
    expect(report.recommended_action).toBe("review_manually");
  });

  test("implement_substantial with use_worktree=false still requires worktree activity", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: {
          handoff_id: "h-1",
          status: "completed",
          ts: "2026-05-01T00:00:00.000Z",
          resolved_at: "2026-05-01T00:00:10.000Z",
          cancel_requested_at: null,
          chain_task_type: "implement_substantial",
          use_worktree: 0,
        },
        worktreeChanged: false,
        reconciled: false,
      }),
    );
    expect(report.status).toBe("no_worktree_activity");
    expect(report.recommended_action).toBe("review_manually");
  });

  test("unknown task with use_worktree falls back to worktree semantics", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: {
          handoff_id: "h-1",
          status: "completed",
          ts: "2026-05-01T00:00:00.000Z",
          resolved_at: "2026-05-01T00:00:10.000Z",
          cancel_requested_at: null,
          chain_task_type: "unknown",
          use_worktree: 1,
        },
        worktreeChanged: false,
        reconciled: false,
      }),
    );
    expect(report.status).toBe("no_worktree_activity");
    expect(report.recommended_action).toBe("review_manually");
  });

  test("legacy unknown task type with use_worktree falls back to worktree semantics", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: {
          handoff_id: "h-1",
          status: "completed",
          ts: "2026-05-01T00:00:00.000Z",
          resolved_at: "2026-05-01T00:00:10.000Z",
          cancel_requested_at: null,
          chain_task_type: "legacy_unknown_type",
          use_worktree: 1,
        },
        worktreeChanged: false,
        reconciled: false,
      }),
    );
    expect(report.status).toBe("no_worktree_activity");
    expect(report.recommended_action).toBe("review_manually");
  });

  test("unknown task with use_worktree=false and no changes is complete", () => {
    const report = classifyDispatchReliability(
      baseInput({
        handoff: {
          handoff_id: "h-1",
          status: "completed",
          ts: "2026-05-01T00:00:00.000Z",
          resolved_at: "2026-05-01T00:00:10.000Z",
          cancel_requested_at: null,
          chain_task_type: "unknown",
          use_worktree: 0,
        },
        worktreeChanged: false,
        reconciled: false,
      }),
    );
    expect(report.status).toBe("complete");
    expect(report.trustworthy).toBe(true);
  });
});

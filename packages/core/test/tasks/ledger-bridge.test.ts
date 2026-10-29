import { describe, expect, test } from "bun:test";

import type { TaskEvent } from "@src/tasks/event-bus.js";
import {
  type LedgerWrite,
  ledgerWriteToPerformanceRow,
  mapTaskEventToLedger,
} from "@src/tasks/ledger-bridge.js";
import type { TaskRecord } from "@src/tasks/schema.js";
import type { TaskLeaseRow } from "@src/tasks/writer.js";

// #342: pin how task-board events become agent_performance rows. These tests
// pin current behaviour, including two choices that may look odd: a null
// result_artifacts counts as implement_substantial, and review_passed uses the
// size task type even for a review task. Every input is a fixed literal.
const TASK_ID = "task-ledger-1";
const AGENT = "agent-a";
const EVENT_AT = 5_000;
const FIXED_ISO = "2026-01-02T03:04:05.000Z";
const HANDOFF_ID_SHAPE = /^task:[0-9a-f]{20}$/;

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: TASK_ID,
    created_at: 1,
    updated_at: 1,
    created_by_kind: "workflow",
    created_by_id: "workflow-1",
    project_id: null,
    parent_task_id: null,
    kind: "work",
    priority: "normal",
    prompt: "Pin the ledger bridge",
    acceptance_criteria: null,
    expected_artifacts: null,
    eligibility: {},
    review_eligibility: null,
    requires_review: false,
    bounds_wall_clock_ms: null,
    bounds_cost_cents: null,
    bounds_max_sub_dispatches: null,
    bounds_started_at: null,
    status: "done",
    result_summary: null,
    result_artifacts: [],
    failure_reason: null,
    chain_id: null,
    origin: null,
    ...overrides,
  };
}

function lease(agentId: string): TaskLeaseRow {
  return {
    id: "lease-1",
    task_id: TASK_ID,
    agent_id: agentId,
    claimed_at: 1_000,
    expires_at: 61_000,
    released_at: null,
    release_reason: null,
    auction_score: null,
  };
}

function taskEvent(kind: TaskEvent["kind"], overrides: Partial<TaskEvent> = {}): TaskEvent {
  return { task_id: TASK_ID, at: EVENT_AT, kind, actor: null, payload: null, ...overrides };
}

function fixedClock(): Date {
  return new Date(FIXED_ISO);
}

const ONE_ARTIFACT: TaskRecord["result_artifacts"] = [{ type: "commit", ref: "abc123" }];
const TWO_ARTIFACTS: TaskRecord["result_artifacts"] = [
  { type: "commit", ref: "abc123" },
  { type: "file", ref: "packages/core/src/tasks/ledger-bridge.ts" },
];

describe("mapTaskEventToLedger", () => {
  test("returns null when there is no lease or the lease agent_id is empty", () => {
    expect(mapTaskEventToLedger(taskEvent("completed"), baseTask())).toBeNull();
    expect(mapTaskEventToLedger(taskEvent("completed"), baseTask(), lease(""))).toBeNull();
    expect(mapTaskEventToLedger(taskEvent("completed"), baseTask(), lease(AGENT))).not.toBeNull();
  });

  test("a completed done work task with no result artifacts is an implement_small success", () => {
    expect(
      mapTaskEventToLedger(
        taskEvent("completed"),
        baseTask({ result_artifacts: [] }),
        lease(AGENT),
      ),
    ).toEqual({
      agent_name: AGENT,
      task_type: "implement_small",
      success: true,
      failure_reason: null,
    });
  });

  test("a completed done work task with one result artifact is an implement_small success", () => {
    expect(
      mapTaskEventToLedger(
        taskEvent("completed"),
        baseTask({ result_artifacts: ONE_ARTIFACT }),
        lease(AGENT),
      ),
    ).toEqual({
      agent_name: AGENT,
      task_type: "implement_small",
      success: true,
      failure_reason: null,
    });
  });

  test("a completed done work task with two result artifacts is implement_substantial", () => {
    expect(
      mapTaskEventToLedger(
        taskEvent("completed"),
        baseTask({ result_artifacts: TWO_ARTIFACTS }),
        lease(AGENT),
      ),
    ).toEqual({
      agent_name: AGENT,
      task_type: "implement_substantial",
      success: true,
      failure_reason: null,
    });
  });

  test("a completed done work task with result_artifacts null is implement_substantial", () => {
    expect(
      mapTaskEventToLedger(
        taskEvent("completed"),
        baseTask({ result_artifacts: null }),
        lease(AGENT),
      ),
    ).toEqual({
      agent_name: AGENT,
      task_type: "implement_substantial",
      success: true,
      failure_reason: null,
    });
  });

  test("a completed work task still in done_pending_review writes nothing", () => {
    expect(
      mapTaskEventToLedger(
        taskEvent("completed"),
        baseTask({ status: "done_pending_review" }),
        lease(AGENT),
      ),
    ).toBeNull();
  });

  test("a completed done review task is a review_adversarial success", () => {
    expect(
      mapTaskEventToLedger(
        taskEvent("completed"),
        baseTask({ kind: "review", result_artifacts: null }),
        lease(AGENT),
      ),
    ).toEqual({
      agent_name: AGENT,
      task_type: "review_adversarial",
      success: true,
      failure_reason: null,
    });
  });

  test("review_passed is a success typed by result artifact count, even for a review task", () => {
    expect(
      mapTaskEventToLedger(
        taskEvent("review_passed"),
        baseTask({ status: "done_pending_review", result_artifacts: ONE_ARTIFACT }),
        lease(AGENT),
      ),
    ).toEqual({
      agent_name: AGENT,
      task_type: "implement_small",
      success: true,
      failure_reason: null,
    });
    expect(
      mapTaskEventToLedger(
        taskEvent("review_passed"),
        baseTask({ kind: "review", result_artifacts: null }),
        lease(AGENT),
      ),
    ).toEqual({
      agent_name: AGENT,
      task_type: "implement_substantial",
      success: true,
      failure_reason: null,
    });
  });

  test("review_failed is a failure that copies the task failure_reason, including null", () => {
    expect(
      mapTaskEventToLedger(
        taskEvent("review_failed"),
        baseTask({ status: "failed", failure_reason: "tests red" }),
        lease(AGENT),
      ),
    ).toEqual({
      agent_name: AGENT,
      task_type: "implement_small",
      success: false,
      failure_reason: "tests red",
    });
    expect(
      mapTaskEventToLedger(
        taskEvent("review_failed"),
        baseTask({ status: "failed", failure_reason: null }),
        lease(AGENT),
      ),
    ).toEqual({
      agent_name: AGENT,
      task_type: "implement_small",
      success: false,
      failure_reason: null,
    });
  });

  test("a released event with reason expired is a lease expired failure", () => {
    const expired = taskEvent("released", { payload: { reason: "expired" } });
    expect(
      mapTaskEventToLedger(expired, baseTask({ kind: "review", status: "leased" }), lease(AGENT)),
    ).toEqual({
      agent_name: AGENT,
      task_type: "review_adversarial",
      success: false,
      failure_reason: "lease expired",
    });
    expect(
      mapTaskEventToLedger(
        expired,
        baseTask({ status: "leased", result_artifacts: TWO_ARTIFACTS }),
        lease(AGENT),
      ),
    ).toEqual({
      agent_name: AGENT,
      task_type: "implement_substantial",
      success: false,
      failure_reason: "lease expired",
    });
  });

  test("a released event for any other reason, or with no payload, writes nothing", () => {
    expect(
      mapTaskEventToLedger(
        taskEvent("released", { payload: { reason: "manual" } }),
        baseTask({ status: "leased" }),
        lease(AGENT),
      ),
    ).toBeNull();
    expect(
      mapTaskEventToLedger(
        taskEvent("released", { payload: null }),
        baseTask({ status: "leased" }),
        lease(AGENT),
      ),
    ).toBeNull();
  });

  test("a heartbeat event writes nothing", () => {
    expect(
      mapTaskEventToLedger(taskEvent("heartbeat"), baseTask({ status: "leased" }), lease(AGENT)),
    ).toBeNull();
  });
});

describe("ledgerWriteToPerformanceRow", () => {
  const success: LedgerWrite = {
    agent_name: AGENT,
    task_type: "implement_small",
    success: true,
    failure_reason: null,
  };

  test("a success write becomes a merged operator row with every metric null", () => {
    const row = ledgerWriteToPerformanceRow({
      write: success,
      taskEvent: taskEvent("completed"),
      clock: fixedClock,
      uuid: (): string => "perf-1",
    });
    expect(row.handoff_id).toMatch(HANDOFF_ID_SHAPE);
    expect(row).toEqual({
      performance_id: "perf-1",
      ts: FIXED_ISO,
      handoff_id: row.handoff_id,
      conversation_id: null,
      project_id: null,
      agent_name: AGENT,
      task_type: "implement_small",
      outcome: "merged",
      rounds: null,
      smoke_pass: null,
      reviewer_findings: null,
      maestro_score: null,
      cost_usd: null,
      tokens_used: null,
      latency_ms: null,
      source: "operator",
      notes: null,
      metadata_json: JSON.stringify({
        source: "task_board_ledger",
        task_id: TASK_ID,
        event_kind: "completed",
        event_at: EVENT_AT,
      }),
    });
  });

  test("a failure write becomes a failed row whose notes are the failure_reason", () => {
    const row = ledgerWriteToPerformanceRow({
      write: {
        agent_name: AGENT,
        task_type: "review_adversarial",
        success: false,
        failure_reason: "lease expired",
      },
      taskEvent: taskEvent("released", { payload: { reason: "expired" } }),
      project_id: "proj-1",
      clock: fixedClock,
      uuid: (): string => "perf-2",
    });
    expect(row.outcome).toBe("failed");
    expect(row.notes).toBe("lease expired");
    expect(row.project_id).toBe("proj-1");
    expect(row.task_type).toBe("review_adversarial");
    expect(row.metadata_json).toBe(
      JSON.stringify({
        source: "task_board_ledger",
        task_id: TASK_ID,
        event_kind: "released",
        event_at: EVENT_AT,
      }),
    );
  });

  test("handoff_id depends on the event and the write, not on the uuid or the clock", () => {
    const first = ledgerWriteToPerformanceRow({
      write: success,
      taskEvent: taskEvent("completed"),
      clock: fixedClock,
      uuid: (): string => "perf-1",
    });
    const again = ledgerWriteToPerformanceRow({
      write: success,
      taskEvent: taskEvent("completed"),
      clock: (): Date => new Date("2027-05-06T07:08:09.000Z"),
      uuid: (): string => "perf-9",
    });
    const laterEvent = ledgerWriteToPerformanceRow({
      write: success,
      taskEvent: taskEvent("completed", { at: EVENT_AT + 1 }),
      clock: fixedClock,
      uuid: (): string => "perf-1",
    });
    const failedWrite = ledgerWriteToPerformanceRow({
      write: { ...success, success: false },
      taskEvent: taskEvent("completed"),
      clock: fixedClock,
      uuid: (): string => "perf-1",
    });
    expect(first.handoff_id).toMatch(HANDOFF_ID_SHAPE);
    expect(again.handoff_id).toBe(first.handoff_id);
    expect(again.performance_id).toBe("perf-9");
    expect(laterEvent.handoff_id).toMatch(HANDOFF_ID_SHAPE);
    expect(laterEvent.handoff_id).not.toBe(first.handoff_id);
    expect(failedWrite.handoff_id).not.toBe(first.handoff_id);
  });
});

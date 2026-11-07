import { describe, expect, test } from "bun:test";

import {
  AgentTaskTypeSchema,
  DispatchEventSchema,
  DispatchEventsStreamPayloadSchema,
  HandoffsEventsPayloadSchema,
  HealthResponseSchema,
  HealthReviewBacklogSchema,
  TasksEventsPayloadSchema,
} from "../src/index.js";

const taskEventBase = {
  task_id: "t1",
  at: 1,
  kind: "created",
  actor: null,
  payload: null,
};

const handoffRow = {
  handoff_id: "h1",
  ts: "2026-01-01T00:00:00.000Z",
  project_id: null,
  conversation_id: "c1",
  from_agent: "claude",
  to_agent: "gemini",
  to_role: null,
  message: "go",
  status: "pending",
  resolved_by: null,
  resolved_at: null,
  redirected_to: null,
  resolution_reason: null,
  triggered_by_event_id: null,
  chain_max_hops: null,
  chain_trust_mode: null,
  chain_task_type: null,
  use_worktree: 1,
  error_message: null,
  cancel_requested_at: null,
  worker_id: null,
  parent_handoff_id: null,
};

const backlogBase = {
  open_lanes_count: 0,
  open_boundary_lanes_count: 0,
  oldest_open_lane_age_ms: 0,
};

describe("TasksEventsPayloadSchema", () => {
  test("base payload parses and null actor/payload round-trip as null", () => {
    const parsed = TasksEventsPayloadSchema.parse(taskEventBase);
    expect(parsed.task_id).toBe("t1");
    expect(parsed.actor).toBe(null);
    expect(parsed.payload).toBe(null);
  });

  test("actor is required (nullable, not optional)", () => {
    const { actor: _omittedActor, ...withoutActor } = taskEventBase;
    expect(TasksEventsPayloadSchema.safeParse(withoutActor).success).toBe(false);
  });

  test("payload is required (nullable, not optional)", () => {
    const { payload: _omittedPayload, ...withoutPayload } = taskEventBase;
    expect(TasksEventsPayloadSchema.safeParse(withoutPayload).success).toBe(false);
  });

  test("payload must be a string-keyed record, so an array is rejected", () => {
    expect(TasksEventsPayloadSchema.safeParse({ ...taskEventBase, payload: ["x"] }).success).toBe(
      false,
    );
  });

  test("at must be a number, so a numeric string is rejected", () => {
    expect(TasksEventsPayloadSchema.safeParse({ ...taskEventBase, at: "1" }).success).toBe(false);
  });

  test("schema is loose: unknown keys are preserved", () => {
    const parsed = TasksEventsPayloadSchema.parse({ ...taskEventBase, extra: 7 });
    expect(Reflect.get(parsed, "extra")).toBe(7);
  });
});

describe("HandoffsEventsPayloadSchema", () => {
  test("empty payload parses (handoff and kind are both optional)", () => {
    expect(HandoffsEventsPayloadSchema.safeParse({}).success).toBe(true);
  });

  test("kind must be a string, so a number is rejected", () => {
    expect(HandoffsEventsPayloadSchema.safeParse({ kind: 5 }).success).toBe(false);
  });

  test("nested HandoffRowSchema validation rejects an unknown status", () => {
    expect(
      HandoffsEventsPayloadSchema.safeParse({
        handoff: { ...handoffRow, status: "bogus" },
      }).success,
    ).toBe(false);
  });

  test("nested NumericBoolean transform maps use_worktree 1 to true", () => {
    const parsed = HandoffsEventsPayloadSchema.parse({ handoff: handoffRow });
    expect(parsed.handoff?.use_worktree).toBe(true);
  });

  test("schema is loose: unknown top-level keys are preserved", () => {
    const parsed = HandoffsEventsPayloadSchema.parse({ extra: "kept" });
    expect(Reflect.get(parsed, "extra")).toBe("kept");
  });
});

describe("DispatchEventsStreamPayloadSchema", () => {
  test("is the same schema instance as DispatchEventSchema", () => {
    expect(Object.is(DispatchEventsStreamPayloadSchema, DispatchEventSchema)).toBe(true);
  });
});

describe("HealthReviewBacklogSchema", () => {
  test("zero counts parse", () => {
    expect(HealthReviewBacklogSchema.safeParse(backlogBase).success).toBe(true);
  });

  test("open_lanes_count is nonnegative, so -1 is rejected", () => {
    expect(
      HealthReviewBacklogSchema.safeParse({ ...backlogBase, open_lanes_count: -1 }).success,
    ).toBe(false);
  });

  test("oldest_open_lane_age_ms is an int, so a fraction is rejected", () => {
    expect(
      HealthReviewBacklogSchema.safeParse({ ...backlogBase, oldest_open_lane_age_ms: 1.5 }).success,
    ).toBe(false);
  });

  test("open_boundary_lanes_count is required", () => {
    const { open_boundary_lanes_count: _omitted, ...withoutBoundary } = backlogBase;
    expect(HealthReviewBacklogSchema.safeParse(withoutBoundary).success).toBe(false);
  });

  test("schema is loose: unknown keys are preserved", () => {
    const parsed = HealthReviewBacklogSchema.parse({ ...backlogBase, extra: "kept" });
    expect(Reflect.get(parsed, "extra")).toBe("kept");
  });

  test("HealthResponseSchema propagates nested backlog validation", () => {
    expect(
      HealthResponseSchema.safeParse({
        status: "ok",
        reviewBacklog: { ...backlogBase, open_boundary_lanes_count: -1 },
      }).success,
    ).toBe(false);
  });
});

describe("AgentTaskTypeSchema", () => {
  test("enum options are the exact ordered task-type list", () => {
    expect(AgentTaskTypeSchema.options).toEqual([
      "plan_refine",
      "implement_small",
      "implement_substantial",
      "review_adversarial",
      "docs_mechanical",
      "debug_diagnose",
      "smoke_test",
      "health_check",
      "unknown",
    ]);
  });
});

import { expect, test } from "bun:test";

import {
  CloseLaneRequestSchema,
  LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES,
  LaneCloseMetadataSchema,
  LanesRecentResponseSchema,
  OpenLaneRequestSchema,
  RecentLaneQuerySchema,
  TaskClassSchema,
} from "../src/index.js";

test("TaskClassSchema enumerates exactly BOUNDARY, STANDARD, TRIVIAL", () => {
  expect(TaskClassSchema.options).toEqual(["BOUNDARY", "STANDARD", "TRIVIAL"]);
  expect(TaskClassSchema.safeParse("BOUNDARY").success).toBe(true);
  expect(TaskClassSchema.safeParse("STANDARD").success).toBe(true);
  expect(TaskClassSchema.safeParse("TRIVIAL").success).toBe(true);
  expect(TaskClassSchema.safeParse("OTHER").success).toBe(false);
});

test("LaneCloseMetadataSchema is strict and rejects unknown keys", () => {
  expect(LaneCloseMetadataSchema.safeParse({}).success).toBe(true);
  expect(LaneCloseMetadataSchema.safeParse({ round_count: 1, high_findings: 2 }).success).toBe(
    true,
  );
  expect(LaneCloseMetadataSchema.safeParse({ invented: 1 }).success).toBe(false);
});

test("LaneCloseMetadataSchema accepts all optional fields within bounds", () => {
  const valid = {
    round_count: 0,
    high_findings: 1000,
    medium_findings: 0,
    low_findings: 500,
    implementer_duration_ms: 86_400_000,
    reviewer_agent: "codex",
    review_synth_dir: "forward",
    notes: "x",
  };
  expect(LaneCloseMetadataSchema.safeParse(valid).success).toBe(true);
});

test("LaneCloseMetadataSchema rejects out-of-bounds values", () => {
  expect(LaneCloseMetadataSchema.safeParse({ round_count: 101 }).success).toBe(false);
  expect(LaneCloseMetadataSchema.safeParse({ notes: "" }).success).toBe(false);
  expect(LaneCloseMetadataSchema.safeParse({ reviewer_agent: "" }).success).toBe(false);
});

test("LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES is 4096", () => {
  expect(LANE_CLOSE_METADATA_MAX_SERIALIZED_BYTES).toBe(4096);
});

test("OpenLaneRequestSchema is plain (strips unknown keys, not strict)", () => {
  expect(
    OpenLaneRequestSchema.safeParse({
      lane_id: "l1",
      implementer_handoff: "h1",
      task_class: "STANDARD",
    }).success,
  ).toBe(true);
  expect(
    OpenLaneRequestSchema.safeParse({
      lane_id: "l1",
      implementer_handoff: "h1",
      task_class: "STANDARD",
      extra: "stripped",
    }).success,
  ).toBe(true);
  expect(OpenLaneRequestSchema.safeParse({ lane_id: "l1" }).success).toBe(false);
  expect(OpenLaneRequestSchema.safeParse({ task_class: "BAD" }).success).toBe(false);
});

test("CloseLaneRequestSchema gate_status excludes open", () => {
  expect(CloseLaneRequestSchema.safeParse({ lane_id: "l1", gate_status: "passed" }).success).toBe(
    true,
  );
  expect(CloseLaneRequestSchema.safeParse({ lane_id: "l1", gate_status: "open" }).success).toBe(
    false,
  );
  expect(
    CloseLaneRequestSchema.safeParse({
      lane_id: "l1",
      gate_status: "review_debt",
      metadata: { round_count: 1 },
    }).success,
  ).toBe(true);
});

test("RecentLaneQuerySchema defaults limit to 50 and coerces string", () => {
  const parsed = RecentLaneQuerySchema.safeParse({ limit: "10" });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.limit).toBe(10);
  }
  const defaulted = RecentLaneQuerySchema.safeParse({});
  expect(defaulted.success).toBe(true);
  if (defaulted.success) {
    expect(defaulted.data.limit).toBe(50);
  }
});

test("RecentLaneQuerySchema status enum includes all five gate statuses", () => {
  for (const s of ["open", "passed", "failed", "skipped", "review_debt"]) {
    expect(RecentLaneQuerySchema.safeParse({ status: s }).success).toBe(true);
  }
  expect(RecentLaneQuerySchema.safeParse({ status: "other" }).success).toBe(false);
});

test("LanesRecentResponseSchema is loose and validates a full LaneRow", () => {
  const laneRow = {
    lane_id: "l1",
    ts_opened: "2026-01-01T00:00:00.000Z",
    ts_closed: null,
    task_class: "STANDARD",
    implementer_handoff: "h1",
    reviewer_handoff: null,
    gate_status: "open",
    recalled_memory_ids: ["m1", "m2"],
    recalled_query: null,
    override_reason: null,
    metadata_json: "{}",
  };
  const parsed = LanesRecentResponseSchema.safeParse({
    lanes: [laneRow],
    extra_field: "allowed because loose",
  });
  expect(parsed.success).toBe(true);
  expect(parsed.success && Reflect.get(parsed.data, "extra_field")).toBe("allowed because loose");
});

test("LanesRecentResponseSchema rejects non-array lanes", () => {
  expect(LanesRecentResponseSchema.safeParse({ lanes: "not-array" }).success).toBe(false);
});

test("lane request objects strip unknown keys and preserve exact status options", () => {
  expect(
    OpenLaneRequestSchema.parse({
      lane_id: "l",
      implementer_handoff: "h",
      task_class: "STANDARD",
      extra: true,
    }),
  ).toEqual({ lane_id: "l", implementer_handoff: "h", task_class: "STANDARD" });
  expect(
    CloseLaneRequestSchema.parse({ lane_id: "l", gate_status: "passed", extra: true }),
  ).toEqual({ lane_id: "l", gate_status: "passed" });
  expect(LanesRecentResponseSchema.shape.lanes.element.shape.gate_status.options).toEqual([
    "open",
    "passed",
    "failed",
    "skipped",
    "review_debt",
  ]);
});

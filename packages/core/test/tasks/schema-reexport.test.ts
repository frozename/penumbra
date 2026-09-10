import * as Api from "@penumbra/api-contract";
import { expect, test } from "bun:test";

import * as Core from "@src/tasks/schema.js";

const validRecord = {
  id: "task-1",
  created_at: 1,
  updated_at: 2,
  created_by_kind: "workflow" as const,
  created_by_id: "workflow-1",
  project_id: null,
  parent_task_id: null,
  kind: "work" as const,
  priority: "normal" as const,
  prompt: "Do the thing",
  acceptance_criteria: null,
  expected_artifacts: [{ type: "commit" as const, ref: "abc123" }],
  eligibility: { min_tier: "standard" as const },
  review_eligibility: null,
  requires_review: false,
  bounds_wall_clock_ms: 1000,
  bounds_cost_cents: null,
  bounds_max_sub_dispatches: 3,
  bounds_started_at: null,
  branch_base: null,
  status: "pending" as const,
  result_summary: null,
  result_artifacts: null,
  failure_reason: null,
  chain_id: null,
  origin: null,
  gh_issue_number: null,
  gh_issue_repo: null,
};

test("core reexports the five lifted input schemas by reference", () => {
  expect(Object.is(Core.FileTaskInputSchema, Api.FileTaskInputSchema)).toBe(true);
  expect(Object.is(Core.CompleteTaskInputSchema, Api.CompleteTaskInputSchema)).toBe(true);
  expect(Object.is(Core.CompleteWithoutLeaseInputSchema, Api.CompleteWithoutLeaseInputSchema)).toBe(
    true,
  );
  expect(Object.is(Core.FailTaskInputSchema, Api.FailTaskInputSchema)).toBe(true);
  expect(Object.is(Core.CancelTaskInputSchema, Api.CancelTaskInputSchema)).toBe(true);
});

test("core reexports the lifted helpers and constants by reference", () => {
  expect(Object.is(Core.BoundsInputSchema, Api.BoundsInputSchema)).toBe(true);
  expect(Object.is(Core.EligibilitySchema, Api.EligibilitySchema)).toBe(true);
  expect(Object.is(Core.ExpectedArtifactSchema, Api.ExpectedArtifactSchema)).toBe(true);
  expect(Object.is(Core.ReviewVerdictSchema, Api.ReviewVerdictSchema)).toBe(true);
  expect(Object.is(Core.TaskPrioritySchema, Api.TaskPrioritySchema)).toBe(true);
  expect(Core.TIER_ORDER).toBe(Api.TIER_ORDER);
});

test("retained TaskRecordSchema still consumes the lifted helpers", () => {
  expect(() => Core.TaskRecordSchema.parse(validRecord)).not.toThrow();

  const invalidTier = { ...validRecord, eligibility: { min_tier: "platinum" } };
  expect(() => Core.TaskRecordSchema.parse(invalidTier)).toThrow();

  const invalidPriority = { ...validRecord, priority: "later" };
  expect(() => Core.TaskRecordSchema.parse(invalidPriority)).toThrow();
});

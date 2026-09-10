import { expect, test } from "bun:test";

import * as Tasks from "../src/tasks.js";

const fullFileTask = {
  prompt: "Do the thing",
  project_id: "penumbra",
  acceptance_criteria: "It works",
  gh_create: {
    repo: "frozename/penumbra",
    title: "Task-backed issue",
    body: "Issue body",
    labels: ["tasks", "automation"],
    assignees: ["frozename"],
  },
  expected_artifacts: [{ type: "commit" as const, ref: "abc123" }],
  eligibility: {
    required_tags: ["foo"],
    min_tier: "premium" as const,
    max_cost_cents: 100,
    deny_agents: ["agent-a"],
    allow_agents: ["agent-b"],
    heartbeat_ttl_ms: 120000,
    preference_window_ms: 30000,
    max_attempts: 3,
  },
  review_eligibility: {
    required_tags: ["review"],
    min_tier: "premium" as const,
    max_cost_cents: 250,
    deny_agents: ["agent-c"],
    allow_agents: ["agent-d"],
    heartbeat_ttl_ms: 90000,
    preference_window_ms: 45000,
    max_attempts: 2,
  },
  bounds: {
    wall_clock_ms: 300000,
    cost_cents: 50,
    max_sub_dispatches: 5,
  },
  branch_base: "main",
  priority: "urgent" as const,
  kind: "review" as const,
  requires_review: true,
  parent_task_id: "task-1",
  origin: "workflow:test",
  created_by_kind: "agent" as const,
  created_by_id: "agent-1",
};

test("exports the lifted task input schemas and helpers", () => {
  expect(Tasks.FileTaskInputSchema).toBeDefined();
  expect(Tasks.CompleteTaskInputSchema).toBeDefined();
  expect(Tasks.CompleteWithoutLeaseInputSchema).toBeDefined();
  expect(Tasks.FailTaskInputSchema).toBeDefined();
  expect(Tasks.CancelTaskInputSchema).toBeDefined();
  expect(Tasks.BoundsInputSchema).toBeDefined();
  expect(Tasks.TaskPrioritySchema).toBeDefined();
  expect(Tasks.ExpectedArtifactSchema).toBeDefined();
  expect(Tasks.EligibilitySchema).toBeDefined();
  expect(Tasks.ReviewVerdictSchema).toBeDefined();
  expect(Tasks.TIER_ORDER).toEqual(["economy", "standard", "premium"]);
});

test("FileTaskInputSchema rejects unknown keys", () => {
  expect(
    Tasks.FileTaskInputSchema.safeParse({
      prompt: "x",
      created_by_kind: "human",
      created_by_id: "cli",
      unknown_probe: "should fail",
    }).success,
  ).toBe(false);
});

test("FileTaskInputSchema rejects missing or invalid created_by_kind and missing created_by_id", () => {
  expect(Tasks.FileTaskInputSchema.safeParse({ prompt: "x", created_by_id: "cli" }).success).toBe(
    false,
  );
  expect(
    Tasks.FileTaskInputSchema.safeParse({
      prompt: "x",
      created_by_kind: "bot",
      created_by_id: "cli",
    }).success,
  ).toBe(false);
  expect(
    Tasks.FileTaskInputSchema.safeParse({ prompt: "x", created_by_kind: "human" }).success,
  ).toBe(false);
});

test("FileTaskInputSchema accepts empty created_by_id", () => {
  const parsed = Tasks.FileTaskInputSchema.safeParse({
    prompt: "x",
    created_by_kind: "human",
    created_by_id: "",
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.created_by_id).toBe("");
  }
});

test("FileTaskInputSchema accepts complete payload retaining every field", () => {
  const parsed = Tasks.FileTaskInputSchema.safeParse(fullFileTask);
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data).toEqual(fullFileTask);
  }
});

test("FileTaskInputSchema rejects nested unknown keys", () => {
  expect(
    Tasks.FileTaskInputSchema.safeParse({
      prompt: "x",
      created_by_kind: "human",
      created_by_id: "cli",
      gh_create: { unknown: true },
    }).success,
  ).toBe(false);

  expect(
    Tasks.FileTaskInputSchema.safeParse({
      prompt: "x",
      created_by_kind: "human",
      created_by_id: "cli",
      eligibility: { unknown: true },
    }).success,
  ).toBe(false);
});

test("CancelTaskInputSchema rejects unknown keys and accepts minimal payload", () => {
  expect(Tasks.CancelTaskInputSchema.safeParse({ task_id: "task-1" }).success).toBe(true);
  expect(Tasks.CancelTaskInputSchema.safeParse({ task_id: "task-1", reason: "nope" }).success).toBe(
    true,
  );
  expect(Tasks.CancelTaskInputSchema.safeParse({ task_id: "task-1", unknown: true }).success).toBe(
    false,
  );
});

test("CompleteWithoutLeaseInputSchema rejects lease_id but accepts task_id and result_summary", () => {
  expect(
    Tasks.CompleteWithoutLeaseInputSchema.safeParse({
      task_id: "task-1",
      result_summary: "done",
    }).success,
  ).toBe(true);
  expect(
    Tasks.CompleteWithoutLeaseInputSchema.safeParse({
      task_id: "task-1",
      lease_id: "lease-1",
      result_summary: "done",
    }).success,
  ).toBe(false);
});

test("CompleteTaskInputSchema preserves requirements and bounds", () => {
  expect(
    Tasks.CompleteTaskInputSchema.safeParse({
      task_id: "task-1",
      lease_id: "lease-1",
      result_summary: "done",
      result_artifacts: [{ type: "file", ref: "packages/api-contract/src/tasks.ts" }],
      chain_id: "chain-1",
      review_verdict: { passed: true, notes: "looks good" },
    }).success,
  ).toBe(true);

  expect(
    Tasks.CompleteTaskInputSchema.safeParse({ task_id: "task-1", result_summary: "done" }).success,
  ).toBe(false);

  expect(
    Tasks.CompleteTaskInputSchema.safeParse({
      task_id: "task-1",
      lease_id: "lease-1",
      result_summary: "x".repeat(16_001),
    }).success,
  ).toBe(false);

  expect(
    Tasks.CompleteTaskInputSchema.safeParse({
      task_id: "task-1",
      lease_id: "lease-1",
      result_summary: "done",
      result_artifacts: Array.from({ length: 51 }, (_, index) => ({
        type: "file" as const,
        ref: `file-${String(index)}`,
      })),
    }).success,
  ).toBe(false);
});

test("CompleteTaskInputSchema preserves review_verdict dependency", () => {
  expect(
    Tasks.CompleteTaskInputSchema.safeParse({
      task_id: "task-1",
      lease_id: "lease-1",
      result_summary: "done",
      review_verdict: { passed: true },
    }).success,
  ).toBe(false);

  expect(
    Tasks.CompleteTaskInputSchema.safeParse({
      task_id: "task-1",
      lease_id: "lease-1",
      result_summary: "done",
      review_verdict: { notes: "ok" },
    }).success,
  ).toBe(false);
});

test("FailTaskInputSchema preserves requirements", () => {
  expect(
    Tasks.FailTaskInputSchema.safeParse({
      task_id: "task-1",
      lease_id: "lease-1",
      reason: "broken",
    }).success,
  ).toBe(true);
  expect(
    Tasks.FailTaskInputSchema.safeParse({ task_id: "task-1", lease_id: "lease-1" }).success,
  ).toBe(false);
  expect(
    Tasks.FailTaskInputSchema.safeParse({
      task_id: "task-1",
      lease_id: "lease-1",
      reason: "",
    }).success,
  ).toBe(false);
});

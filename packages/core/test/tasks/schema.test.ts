import { describe, expect, test } from "bun:test";

import {
  CancelTaskInputSchema,
  CompleteTaskInputSchema,
  ExpectedArtifactSchema,
  FailTaskInputSchema,
  FileTaskInputSchema,
  HeartbeatTaskInputSchema,
  LeaseTaskInputSchema,
  ReviewVerdictSchema,
  TaskKindSchema,
  TaskPrioritySchema,
  TaskRecordSchema,
  TaskStatusSchema,
} from "../../src/tasks/schema.js";

describe("task board schemas", () => {
  test("TaskKindSchema accepts lifecycle kinds", () => {
    expect(() => TaskKindSchema.parse("work")).not.toThrow();
    expect(() => TaskKindSchema.parse("review")).not.toThrow();
  });

  test("TaskPrioritySchema rejects unknown values", () => {
    expect(() => TaskPrioritySchema.parse("later")).toThrow();
  });

  test("ExpectedArtifactSchema parses a minimal artifact", () => {
    expect(() => ExpectedArtifactSchema.parse({ type: "commit" })).not.toThrow();
  });

  test("ReviewVerdictSchema rejects missing notes or passed", () => {
    expect(() => ReviewVerdictSchema.parse({ passed: true })).toThrow();
    expect(() => ReviewVerdictSchema.parse({ notes: "ok" })).toThrow();
  });

  test("FileTaskInputSchema parses minimal and full payloads", () => {
    const minimal = {
      prompt: "Do the thing",
      created_by_kind: "human",
      created_by_id: "cli",
    };
    const ghCreateWithoutRepo = {
      prompt: "Do the thing",
      gh_create: {
        title: "Task-backed issue",
      },
      created_by_kind: "human",
      created_by_id: "cli",
    };
    const full = {
      prompt: "Do the thing",
      acceptance_criteria: "It works",
      expected_artifacts: [{ type: "commit", ref: "abc123" }],
      gh_create: {
        repo: "acordeiro/penumbra",
        title: "Task-backed issue",
        body: "Issue body",
        labels: ["tasks", "automation"],
        assignees: ["acordeiro"],
      },
      eligibility: {
        required_tags: ["foo"],
        min_tier: "premium",
        max_cost_cents: 100,
        deny_agents: ["agent-a"],
        allow_agents: ["agent-b"],
        heartbeat_ttl_ms: 120000,
        preference_window_ms: 30000,
        max_attempts: 3,
      },
      review_eligibility: {
        required_tags: ["review"],
        min_tier: "premium",
        max_cost_cents: 250,
        deny_agents: ["agent-c"],
        allow_agents: ["agent-d"],
        heartbeat_ttl_ms: 90000,
        preference_window_ms: 45000,
        max_attempts: 2,
      },
      priority: "urgent",
      kind: "review",
      requires_review: true,
      parent_task_id: "task-1",
      origin: "workflow:test",
      created_by_kind: "agent",
      created_by_id: "agent-1",
    };

    expect(() => FileTaskInputSchema.parse(minimal)).not.toThrow();
    expect(() => FileTaskInputSchema.parse(ghCreateWithoutRepo)).not.toThrow();
    expect(() => FileTaskInputSchema.parse(full)).not.toThrow();
  });

  test("FileTaskInputSchema rejects empty prompt", () => {
    expect(() =>
      FileTaskInputSchema.parse({
        prompt: "",
        created_by_kind: "human",
        created_by_id: "cli",
      }),
    ).toThrow();
  });

  test("FileTaskInputSchema rejects invalid created_by_kind", () => {
    expect(() =>
      FileTaskInputSchema.parse({
        prompt: "x",
        created_by_kind: "bot",
        created_by_id: "cli",
      }),
    ).toThrow();
  });

  test("FileTaskInputSchema rejects malformed eligibility arrays", () => {
    expect(() =>
      FileTaskInputSchema.parse({
        prompt: "x",
        created_by_kind: "human",
        created_by_id: "cli",
        eligibility: { deny_agents: [1] },
      }),
    ).toThrow();
  });

  test("FileTaskInputSchema rejects unknown min_tier values", () => {
    expect(() =>
      FileTaskInputSchema.parse({
        prompt: "x",
        created_by_kind: "human",
        created_by_id: "cli",
        eligibility: { min_tier: "platinum" },
      }),
    ).toThrow();
    expect(() =>
      FileTaskInputSchema.parse({
        prompt: "x",
        created_by_kind: "human",
        created_by_id: "cli",
        review_eligibility: { min_tier: "vip" },
      }),
    ).toThrow();
  });

  test("LeaseTaskInputSchema parses minimal payload", () => {
    expect(() =>
      LeaseTaskInputSchema.parse({
        task_id: "task-1",
        agent_id: "agent-1",
      }),
    ).not.toThrow();
  });

  test("HeartbeatTaskInputSchema parses minimal payload", () => {
    expect(() =>
      HeartbeatTaskInputSchema.parse({
        task_id: "task-1",
        lease_id: "lease-1",
      }),
    ).not.toThrow();
  });

  test("CompleteTaskInputSchema parses minimal and full payloads", () => {
    const minimal = {
      task_id: "task-1",
      lease_id: "lease-1",
      result_summary: "done",
    };
    const full = {
      task_id: "task-1",
      lease_id: "lease-1",
      result_summary: "done",
      result_artifacts: [{ type: "file", ref: "packages/core/src/tasks/schema.ts" }],
      chain_id: "chain-1",
      review_verdict: { passed: true, notes: "looks good" },
    };

    expect(() => CompleteTaskInputSchema.parse(minimal)).not.toThrow();
    expect(() => CompleteTaskInputSchema.parse(full)).not.toThrow();

    // lease_id is required
    expect(() =>
      CompleteTaskInputSchema.parse({ task_id: "task-1", result_summary: "done" }),
    ).toThrow();
  });

  test("CompleteTaskInputSchema bounds result payload sizes", () => {
    expect(() =>
      CompleteTaskInputSchema.parse({
        task_id: "task-1",
        lease_id: "lease-1",
        result_summary: "x".repeat(16_001),
      }),
    ).toThrow();

    expect(() =>
      CompleteTaskInputSchema.parse({
        task_id: "task-1",
        lease_id: "lease-1",
        result_summary: "done",
        result_artifacts: Array.from({ length: 51 }, (_, index) => ({
          type: "file",
          ref: `file-${String(index)}`,
        })),
      }),
    ).toThrow();
  });

  test("FailTaskInputSchema parses minimal payload", () => {
    expect(() =>
      FailTaskInputSchema.parse({
        task_id: "task-1",
        lease_id: "lease-1",
        reason: "broken",
      }),
    ).not.toThrow();
  });

  test("CancelTaskInputSchema parses minimal and optional reason", () => {
    expect(() => CancelTaskInputSchema.parse({ task_id: "task-1" })).not.toThrow();
    expect(() =>
      CancelTaskInputSchema.parse({ task_id: "task-1", reason: "cancelled" }),
    ).not.toThrow();
  });

  test("TaskRecordSchema parses hydrated row objects", () => {
    expect(() =>
      TaskRecordSchema.parse({
        id: "task-1",
        created_at: 1,
        updated_at: 2,
        created_by_kind: "workflow",
        created_by_id: "workflow-1",
        project_id: null,
        parent_task_id: null,
        kind: "work",
        priority: "normal",
        prompt: "Do the thing",
        acceptance_criteria: null,
        expected_artifacts: [{ type: "commit", ref: "abc123" }],
        eligibility: { min_tier: "standard" },
        review_eligibility: null,
        requires_review: false,
        bounds_wall_clock_ms: 1000,
        bounds_cost_cents: null,
        bounds_max_sub_dispatches: 3,
        bounds_started_at: null,
        branch_base: null,
        status: "pending",
        result_summary: null,
        result_artifacts: null,
        failure_reason: null,
        chain_id: null,
        origin: null,
        gh_issue_number: null,
        gh_issue_repo: null,
      }),
    ).not.toThrow();
  });

  test("TaskStatusSchema accepts all lifecycle states", () => {
    for (const status of [
      "pending",
      "leased",
      "done_pending_review",
      "done",
      "failed",
      "cancelled",
    ] as const) {
      expect(() => TaskStatusSchema.parse(status)).not.toThrow();
    }
  });
});

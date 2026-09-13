import { expect, test } from "bun:test";

import { inputSchema } from "./schema.js";

// ---------------------------------------------------------------------------
// Top-level validation
// ---------------------------------------------------------------------------

test("accepts minimal valid input with defaults", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "task-1", dispatch_prompt: "do work" }],
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.verify_agent).toBe("executor");
    expect(result.data.verify_commands).toEqual(["typecheck", "typecheck_ratchet", "lint_strict"]);
    expect(result.data.timeout_ms).toBe(1_800_000);
  }
});

test("rejects unknown top-level keys", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t", dispatch_prompt: "d" }],
    extra: "bad",
  });
  expect(result.success).toBe(false);
});

test("rejects empty tasks array", () => {
  const result = inputSchema.safeParse({ tasks: [] });
  expect(result.success).toBe(false);
});

test("rejects more than 16 tasks", () => {
  const tasks = Array.from({ length: 17 }, (_, i) => ({
    name: `task-${i}`,
    dispatch_prompt: "d",
  }));
  const result = inputSchema.safeParse({ tasks });
  expect(result.success).toBe(false);
});

test("rejects tasks without name", () => {
  const result = inputSchema.safeParse({
    tasks: [{ dispatch_prompt: "d" }],
  });
  expect(result.success).toBe(false);
});

test("rejects tasks without dispatch_prompt", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t" }],
  });
  expect(result.success).toBe(false);
});

test("rejects name longer than 120 chars", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "x".repeat(121), dispatch_prompt: "d" }],
  });
  expect(result.success).toBe(false);
});

test("bounds all caller-provided prose and identifiers", () => {
  for (const task of [
    { name: "t", dispatch_prompt: "x".repeat(100_001) },
    { name: "t", dispatch_prompt: "d", verify_checklist: "x".repeat(10_001) },
    { name: "t", dispatch_prompt: "d", agent: "x".repeat(121) },
    { name: "t", dispatch_prompt: "d", branch_base: "x".repeat(513) },
    { name: "t", dispatch_prompt: "d", branch_type: "x".repeat(121) },
  ]) {
    expect(inputSchema.safeParse({ tasks: [task] }).success).toBe(false);
  }
  expect(
    inputSchema.safeParse({
      tasks: [{ name: "t", dispatch_prompt: "d" }],
      verify_agent: "x".repeat(121),
    }).success,
  ).toBe(false);
  expect(
    inputSchema.safeParse({
      tasks: [{ name: "t", dispatch_prompt: "d" }],
      project_id: "x".repeat(201),
    }).success,
  ).toBe(false);
  expect(
    inputSchema.safeParse({
      tasks: [{ name: "t", dispatch_prompt: "d" }],
      out_dir: "x".repeat(4_097),
    }).success,
  ).toBe(false);
});

test("rejects unknown task keys", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t", dispatch_prompt: "d", camelCase: "bad" }],
  });
  expect(result.success).toBe(false);
});

test("accepts all supported task fields including explicit false", () => {
  const result = inputSchema.safeParse({
    tasks: [
      {
        name: "t",
        dispatch_prompt: "d",
        verify_checklist: "check foo",
        agent: "custom-agent",
        task_class: "BOUNDARY",
        task_type: "review_adversarial",
        branch_base: "feature/base",
        branch_type: "feature",
        isolated_install: false,
      },
    ],
  });
  expect(result.success).toBe(true);
});

test("accepts valid task_type values", () => {
  for (const task_type of [
    "plan_refine",
    "implement_small",
    "implement_substantial",
    "review_adversarial",
    "docs_mechanical",
    "debug_diagnose",
    "smoke_test",
    "health_check",
    "unknown",
  ]) {
    const result = inputSchema.safeParse({
      tasks: [{ name: "t", dispatch_prompt: "d", task_type }],
    });
    expect(result.success).toBe(true);
  }
});

test("rejects invalid task_type", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t", dispatch_prompt: "d", task_type: "invalid" }],
  });
  expect(result.success).toBe(false);
});

test("rejects invalid task_class", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t", dispatch_prompt: "d", task_class: "INVALID" }],
  });
  expect(result.success).toBe(false);
});

// ---------------------------------------------------------------------------
// verify_commands validation
// ---------------------------------------------------------------------------

test("accepts known verify commands", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t", dispatch_prompt: "d" }],
    verify_commands: ["typecheck", "test_core", "test_daemon"],
  });
  expect(result.success).toBe(true);
});

test("rejects unknown verify command", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t", dispatch_prompt: "d" }],
    verify_commands: ["typecheck", "arbitrary_command"],
  });
  expect(result.success).toBe(false);
});

test("rejects duplicate verify commands", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t", dispatch_prompt: "d" }],
    verify_commands: ["typecheck", "typecheck"],
  });
  expect(result.success).toBe(false);
});

test("rejects empty verify_commands", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t", dispatch_prompt: "d" }],
    verify_commands: [],
  });
  expect(result.success).toBe(false);
});

test("rejects shell injection in verify_commands", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t", dispatch_prompt: "d" }],
    verify_commands: ["typecheck; rm -rf /"],
  });
  expect(result.success).toBe(false);
});

// ---------------------------------------------------------------------------
// Top-level options
// ---------------------------------------------------------------------------

test("accepts custom verify_agent", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t", dispatch_prompt: "d" }],
    verify_agent: "reviewer",
  });
  expect(result.success).toBe(true);
  if (result.success) expect(result.data.verify_agent).toBe("reviewer");
});

test("accepts project_id, out_dir, timeout_ms", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t", dispatch_prompt: "d" }],
    project_id: "my-project",
    out_dir: "/tmp/reviews",
    timeout_ms: 600_000,
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.project_id).toBe("my-project");
    expect(result.data.out_dir).toBe("/tmp/reviews");
    expect(result.data.timeout_ms).toBe(600_000);
  }
});

test("rejects non-positive timeout_ms", () => {
  const result = inputSchema.safeParse({
    tasks: [{ name: "t", dispatch_prompt: "d" }],
    timeout_ms: -1,
  });
  expect(result.success).toBe(false);
});

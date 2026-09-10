import {
  AgentTaskTypeSchema as ApiAgentTaskTypeSchema,
  ChainStartRequestSchema as ApiChainStartRequestSchema,
  SafeProjectIdSchema as ApiSafeProjectIdSchema,
} from "@penumbra/api-contract";
import { expect, test } from "bun:test";

import { ChainStartRequestSchema } from "@src/schemas/chain.js";

test("ChainStartRequestSchema accepts task_class", () => {
  const parsed = ChainStartRequestSchema.safeParse({
    initial_agent: "planner",
    message: "hi",
    task_class: "STANDARD",
  });

  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.task_class).toBe("STANDARD");
  }
});

test("ChainStartRequestSchema accepts and preserves tool_free", () => {
  const parsed = ChainStartRequestSchema.safeParse({
    initial_agent: "planner",
    message: "hi",
    tool_free: true,
  });

  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.tool_free).toBe(true);
  }
});

test("ChainStartRequestSchema accepts and preserves false tool_free", () => {
  const parsed = ChainStartRequestSchema.safeParse({
    initial_agent: "planner",
    message: "hi",
    tool_free: false,
  });

  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.tool_free).toBe(false);
  }
});

test("ChainStartRequestSchema leaves absent tool_free absent", () => {
  const parsed = ChainStartRequestSchema.safeParse({
    initial_agent: "planner",
    message: "hi",
  });

  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(Object.prototype.hasOwnProperty.call(parsed.data, "tool_free")).toBe(false);
    expect(parsed.data.tool_free).toBeUndefined();
  }
});

test("ChainStartRequestSchema rejects non-boolean tool_free", () => {
  const parsed = ChainStartRequestSchema.safeParse({
    initial_agent: "planner",
    message: "hi",
    tool_free: "true",
  });

  expect(parsed.success).toBe(false);
});

test("ChainStartRequestSchema is the same object as the API contract schema", () => {
  expect(Object.is(ChainStartRequestSchema, ApiChainStartRequestSchema)).toBe(true);
});

test("ChainStartRequestSchema uses the same lifted helper schemas", () => {
  expect(
    Object.is(ChainStartRequestSchema.shape.project_id.unwrap().unwrap(), ApiSafeProjectIdSchema),
  ).toBe(true);
  expect(Object.is(ChainStartRequestSchema.shape.task_type.unwrap(), ApiAgentTaskTypeSchema)).toBe(
    true,
  );
});

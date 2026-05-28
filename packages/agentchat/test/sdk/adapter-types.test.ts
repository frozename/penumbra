import { describe, expect, test } from "bun:test";
import type { ToolCallContext, DispatchInput } from "../../src/sdk/adapter.js";

describe("Phase 1d adapter type extensions", () => {
  test("ToolCallContext requires dispatchId", () => {
    const ctx: ToolCallContext = { toolName: "t", rawInput: {}, dispatchId: "d1" };
    expect(ctx.dispatchId).toBe("d1");
  });
  test("DispatchInput accepts optional executor", () => {
    const input: DispatchInput = {
      prompt: "hello",
      conversation: { id: "c1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      executor: undefined,
    };
    expect(input.executor).toBeUndefined();
  });
});

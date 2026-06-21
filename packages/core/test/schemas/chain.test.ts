import { expect, test } from "bun:test";

import { ChainStartRequestSchema } from "../../src/schemas/chain.js";

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

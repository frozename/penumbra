import { expect, test } from "bun:test";

import { TriggerSchema } from "../src/schema.js";

test("lifecycle trigger accepts tool_name filter", () => {
  const r = TriggerSchema.safeParse({
    kind: "lifecycle",
    event: "post-tool-use",
    filter: { tool_name: ["Edit", "Write"] },
  });
  expect(r.success).toBe(true);
});

test("lifecycle trigger without filter is still valid", () => {
  const r = TriggerSchema.safeParse({ kind: "lifecycle", event: "session-start" });
  expect(r.success).toBe(true);
});

test("rejects empty tool_name array", () => {
  const r = TriggerSchema.safeParse({
    kind: "lifecycle",
    event: "post-tool-use",
    filter: { tool_name: [] },
  });
  expect(r.success).toBe(false);
});

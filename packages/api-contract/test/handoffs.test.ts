import { expect, test } from "bun:test";

import { HandoffsListQuerySchema } from "../src/index.js";

// project_id and project_scope are mutually exclusive at the route (validateProjectScopeQuery, routes/handoffs.ts:541-550 answers 400); the schema does not encode that.

test("HandoffsListQuerySchema accepts agent, project_id and project_scope and rejects unknown keys", () => {
  expect(HandoffsListQuerySchema.safeParse({ agent: "x", project_id: "p" }).success).toBe(true);
  expect(HandoffsListQuerySchema.safeParse({ agent: "x", project_scope: "global" }).success).toBe(
    true,
  );
  expect(HandoffsListQuerySchema.safeParse({ bogus: 1 }).success).toBe(false);
});

// Production mutations that would make these tests fail:
// 1. Remove .strict() from MissionSessionSchema
// 2. Remove SessionBudgetSchema or change .int()/.nonnegative() on current/max_concurrent
// 3. Remove .int()/.nonnegative() from dispatched/resolved/failed
// 4. Remove the budget field or make it optional
// 5. Remove nested project.id/project.name validation
import { describe, expect, test } from "bun:test";

import { MissionSessionSchema } from "../src/index.js";

describe("MissionSessionSchema", () => {
  const validFixture = {
    id: "session-1",
    project: { id: "p-1", name: "test-project" },
    started_at: "2026-01-01T00:00:00Z",
    dispatched: 0,
    resolved: 0,
    failed: 0,
    budget: { current: 0, max_concurrent: 4, soft_warn_pct: 0.8 },
  };

  test("valid fixture parses", () => {
    const parsed = MissionSessionSchema.parse(validFixture);
    expect(parsed.id).toBe("session-1");
    expect(parsed.project.id).toBe("p-1");
    expect(parsed.budget.max_concurrent).toBe(4);
  });

  test("unknown top-level key fails as unrecognized_keys (strict)", () => {
    const result = MissionSessionSchema.safeParse({ ...validFixture, extra_top: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const code = result.error.issues[0]?.code;
      expect(code).toBe("unrecognized_keys");
    }
  });

  test("dispatched/resolved/failed set to -1 fails (nonnegative)", () => {
    expect(MissionSessionSchema.safeParse({ ...validFixture, dispatched: -1 }).success).toBe(false);
    expect(MissionSessionSchema.safeParse({ ...validFixture, resolved: -1 }).success).toBe(false);
    expect(MissionSessionSchema.safeParse({ ...validFixture, failed: -1 }).success).toBe(false);
  });

  test("dispatched/resolved/failed set to 1.5 fails (must be int)", () => {
    expect(MissionSessionSchema.safeParse({ ...validFixture, dispatched: 1.5 }).success).toBe(
      false,
    );
    expect(MissionSessionSchema.safeParse({ ...validFixture, resolved: 1.5 }).success).toBe(false);
    expect(MissionSessionSchema.safeParse({ ...validFixture, failed: 1.5 }).success).toBe(false);
  });

  test("budget.max_concurrent -1 fails (nonnegative)", () => {
    const badBudget = {
      ...validFixture,
      budget: { ...validFixture.budget, max_concurrent: -1 },
    };
    expect(MissionSessionSchema.safeParse(badBudget).success).toBe(false);
  });

  test("budget.max_concurrent 1.5 fails (must be int)", () => {
    const badBudget = {
      ...validFixture,
      budget: { ...validFixture.budget, max_concurrent: 1.5 },
    };
    expect(MissionSessionSchema.safeParse(badBudget).success).toBe(false);
  });

  test("budget.current -1 fails (nonnegative)", () => {
    const badBudget = { ...validFixture, budget: { ...validFixture.budget, current: -1 } };
    expect(MissionSessionSchema.safeParse(badBudget).success).toBe(false);
  });

  test("budget.soft_warn_pct accepts non-integers such as 0.8 and 120", () => {
    const withWarn = { ...validFixture, budget: { ...validFixture.budget, soft_warn_pct: 0.8 } };
    expect(MissionSessionSchema.safeParse(withWarn).success).toBe(true);
    const withHigh = { ...validFixture, budget: { ...validFixture.budget, soft_warn_pct: 120 } };
    expect(MissionSessionSchema.safeParse(withHigh).success).toBe(true);
  });

  test("nested project and budget objects are NOT strict: extra keys parsed and stripped", () => {
    const withExtraBudget = {
      ...validFixture,
      budget: { ...validFixture.budget, extra_budget_key: "ignored" },
    };
    const parsed = MissionSessionSchema.safeParse(withExtraBudget);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.budget).not.toHaveProperty("extra_budget_key");
    }
  });

  test("missing budget fails", () => {
    const noBudget: Record<string, unknown> = { ...validFixture };
    delete noBudget.budget;
    expect(MissionSessionSchema.safeParse(noBudget).success).toBe(false);
  });

  test("project.name missing fails", () => {
    const noName = { ...validFixture, project: { id: "p-1" } };
    expect(MissionSessionSchema.safeParse(noName).success).toBe(false);
  });

  test("project.id mistyped (number) fails", () => {
    const badId = { ...validFixture, project: { id: 1, name: "test-project" } };
    expect(MissionSessionSchema.safeParse(badId).success).toBe(false);
  });
});

import { expect, test } from "bun:test";

import { verifyWorktreeIsolation } from "@src/gates/worktree-isolation.js";

test("passes when use_worktree=true", () => {
  expect(verifyWorktreeIsolation({ spec: { use_worktree: true } }).passed).toBe(true);
});

test("fails when use_worktree=false", () => {
  const r = verifyWorktreeIsolation({ spec: { use_worktree: false } });
  expect(r.passed).toBe(false);
  expect(r.severity).toBe("advisory");
});

test("passes when spec omitted (gate inert)", () => {
  expect(verifyWorktreeIsolation({}).passed).toBe(true);
});

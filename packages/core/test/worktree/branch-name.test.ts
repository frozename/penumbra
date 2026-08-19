import { expect, test } from "bun:test";

import { resolveHandoffBranchName } from "../../src/worktree/branch-name.js";

test("resolveHandoffBranchName falls back for legacy NULL branch_name rows", () => {
  expect(resolveHandoffBranchName({ handoff_id: "h-legacy", branch_name: null })).toBe(
    "agent/h-legacy",
  );
});

test("resolveHandoffBranchName returns the stored branch name when present", () => {
  expect(resolveHandoffBranchName({ handoff_id: "h-custom", branch_name: "feature/custom" })).toBe(
    "feature/custom",
  );
});

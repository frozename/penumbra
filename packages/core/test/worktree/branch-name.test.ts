import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

import {
  buildHandoffBranchName,
  resolveHandoffBranchName,
  slugifyBranchSegment,
} from "../../src/worktree/branch-name.js";

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

test("slugifyBranchSegment normalizes unicode and punctuation runs", () => {
  expect(slugifyBranchSegment("  Café — Full task_pool!!!  ")).toBe("cafe-full-task-pool");
});

test("slugifyBranchSegment caps at a word boundary inside 48 chars when possible", () => {
  expect(
    slugifyBranchSegment("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda"),
  ).toBe("alpha-beta-gamma-delta-epsilon-zeta-eta-theta");
});

test("slugifyBranchSegment cuts at 48 chars when there is no boundary", () => {
  expect(slugifyBranchSegment("a".repeat(80))).toBe("a".repeat(48));
});

test("buildHandoffBranchName maps workload to type and uses task name slug", () => {
  expect(
    buildHandoffBranchName({
      handoff_id: "12345678-1234-4234-9234-123456789abc",
      workload: "implement_substantial",
      task_name: "Full task pool",
    }),
  ).toBe("feat/full-task-pool");
});

test("buildHandoffBranchName falls back to the handoff id prefix when slug is empty", () => {
  expect(
    buildHandoffBranchName({
      handoff_id: "abcdef12-1234-4234-9234-123456789abc",
      task_name: "!!!",
    }),
  ).toBe("task/abcdef12");
});

test("buildHandoffBranchName allows explicit branch_type except reserved agent", () => {
  expect(
    buildHandoffBranchName({
      handoff_id: "abcdef12-1234-4234-9234-123456789abc",
      branch_type: "fixup-1",
      workload: "implement_small",
      task_name: "Investigate queue",
    }),
  ).toBe("fixup-1/investigate-queue");

  expect(() =>
    buildHandoffBranchName({
      handoff_id: "abcdef12-1234-4234-9234-123456789abc",
      branch_type: "agent",
      task_name: "Investigate queue",
    }),
  ).toThrow(/branch_type.*agent/);
});

test("buildHandoffBranchName returns a valid git branch ref", () => {
  const branchName = buildHandoffBranchName({
    handoff_id: "12345678-1234-4234-9234-123456789abc",
    workload: "docs_mechanical",
    task_name: "Docs: API + MCP cleanup",
  });
  expect(() => execFileSync("git", ["check-ref-format", "--branch", branchName])).not.toThrow();
});

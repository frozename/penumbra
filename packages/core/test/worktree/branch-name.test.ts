import {
  buildHandoffBranchName,
  deriveBranchNameFromMessage,
  resolveHandoffBranchName,
  slugifyBranchSegment,
} from "@src/worktree/branch-name.js";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

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

test("buildHandoffBranchName maps workload to type and uses task name slug plus an id suffix", () => {
  expect(
    buildHandoffBranchName({
      handoff_id: "12345678-1234-4234-9234-123456789abc",
      workload: "implement_substantial",
      task_name: "Full task pool",
    }),
  ).toBe("feat/full-task-pool_12345678");
});

test("buildHandoffBranchName falls back to a literal name part when the slug is empty", () => {
  expect(
    buildHandoffBranchName({
      handoff_id: "abcdef12-1234-4234-9234-123456789abc",
      task_name: "!!!",
    }),
  ).toBe("task/handoff_abcdef12");

  expect(
    buildHandoffBranchName({
      handoff_id: "abcdef12-1234-4234-9234-123456789abc",
    }),
  ).toBe("task/handoff_abcdef12");
});

test("buildHandoffBranchName gives the same task_name different handoff_ids different branch names", () => {
  const first = buildHandoffBranchName({
    handoff_id: "11111111-1234-4234-9234-123456789abc",
    task_name: "Investigate queue",
  });
  const second = buildHandoffBranchName({
    handoff_id: "22222222-1234-4234-9234-123456789abc",
    task_name: "Investigate queue",
  });
  expect(first).toBe("task/investigate-queue_11111111");
  expect(second).toBe("task/investigate-queue_22222222");
  expect(first).not.toBe(second);
});

test("buildHandoffBranchName truncates a long task name to 48 chars and still appends the id suffix", () => {
  const branchName = buildHandoffBranchName({
    handoff_id: "12345678-1234-4234-9234-123456789abc",
    task_name: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda",
  });
  expect(branchName).toBe("task/alpha-beta-gamma-delta-epsilon-zeta-eta-theta_12345678");
  expect(() => execFileSync("git", ["check-ref-format", "--branch", branchName])).not.toThrow();
});

test("buildHandoffBranchName allows explicit branch_type except reserved agent", () => {
  expect(
    buildHandoffBranchName({
      handoff_id: "abcdef12-1234-4234-9234-123456789abc",
      branch_type: "fixup-1",
      workload: "implement_small",
      task_name: "Investigate queue",
    }),
  ).toBe("fixup-1/investigate-queue_abcdef12");

  expect(() =>
    buildHandoffBranchName({
      handoff_id: "abcdef12-1234-4234-9234-123456789abc",
      branch_type: "agent",
      task_name: "Investigate queue",
    }),
  ).toThrow(/branch_type.*agent/);
});

test("deriveBranchNameFromMessage slugifies the first non-empty line, capped to ~6 words", () => {
  expect(deriveBranchNameFromMessage("Fix the login redirect loop on mobile Safari please")).toBe(
    "fix-the-login-redirect-loop-on",
  );
});

test("deriveBranchNameFromMessage skips leading blank lines", () => {
  expect(deriveBranchNameFromMessage("\n\n  \nInvestigate queue backlog")).toBe(
    "investigate-queue-backlog",
  );
});

test("deriveBranchNameFromMessage strips a stamped [tag] key=value prefix and falls through", () => {
  expect(
    deriveBranchNameFromMessage(
      "[silent-failure-retry] retry_of=abc123 prior_agent=some-agent\n\nInvestigate queue backlog",
    ),
  ).toBe("investigate-queue-backlog");
});

test("deriveBranchNameFromMessage keeps real text after a plain bracketed tag", () => {
  expect(deriveBranchNameFromMessage("[urgent] fix the login bug")).toBe("fix-the-login-bug");
});

test("deriveBranchNameFromMessage returns empty for blank, whitespace-only, or missing input", () => {
  expect(deriveBranchNameFromMessage("")).toBe("");
  expect(deriveBranchNameFromMessage("   \n  \n")).toBe("");
  expect(deriveBranchNameFromMessage(null)).toBe("");
  expect(deriveBranchNameFromMessage(undefined)).toBe("");
});

test("buildHandoffBranchName derives the name slug from message when task_name is absent", () => {
  expect(
    buildHandoffBranchName({
      handoff_id: "12345678-1234-4234-9234-123456789abc",
      message: "Investigate queue backlog",
    }),
  ).toBe("task/investigate-queue-backlog_12345678");
});

test("buildHandoffBranchName prefers an explicit task_name over a derived message slug", () => {
  expect(
    buildHandoffBranchName({
      handoff_id: "12345678-1234-4234-9234-123456789abc",
      task_name: "Full task pool",
      message: "Investigate queue backlog",
    }),
  ).toBe("task/full-task-pool_12345678");
});

test("buildHandoffBranchName falls back to the literal name part when message yields nothing usable", () => {
  expect(
    buildHandoffBranchName({
      handoff_id: "abcdef12-1234-4234-9234-123456789abc",
      message: "   ",
    }),
  ).toBe("task/handoff_abcdef12");
});

test("buildHandoffBranchName returns a valid git branch ref", () => {
  const branchName = buildHandoffBranchName({
    handoff_id: "12345678-1234-4234-9234-123456789abc",
    workload: "docs_mechanical",
    task_name: "Docs: API + MCP cleanup",
  });
  expect(branchName).toBe("docs/docs-api-mcp-cleanup_12345678");
  expect(() => execFileSync("git", ["check-ref-format", "--branch", branchName])).not.toThrow();
});

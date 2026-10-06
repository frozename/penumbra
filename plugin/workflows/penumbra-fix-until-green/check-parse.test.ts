import { expect, test } from "bun:test";

import {
  bashCheckCommand,
  parseCheck,
  roundMessage,
  shellQuote,
  stripFencedBlocks,
  validateCheckCommand,
} from "./check-parse.js";

// ---------------------------------------------------------------------------
// shellQuote / bashCheckCommand
// ---------------------------------------------------------------------------

test("shellQuote wraps a simple string in single quotes", () => {
  expect(shellQuote("echo hi")).toBe("'echo hi'");
});

test("shellQuote escapes embedded single quotes", () => {
  expect(shellQuote("echo 'hi'")).toBe("'echo '\\''hi'\\'''");
});

test("bashCheckCommand wraps the command in bash -c with shell quoting", () => {
  const cmd = bashCheckCommand("bun run typecheck");
  expect(cmd).toBe("bash -c 'bun run typecheck'");
  const cmd2 = bashCheckCommand("echo 'test'");
  expect(cmd2).toMatch(/^bash -c '/);
  expect(cmd2).toContain("echo");
});

// ---------------------------------------------------------------------------
// stripFencedBlocks
// ---------------------------------------------------------------------------

test("stripFencedBlocks removes content inside backtick fences", () => {
  const text = "before\n```\nhidden\n```\nafter";
  expect(stripFencedBlocks(text)).toBe("before\nafter");
});

test("stripFencedBlocks removes content inside tilde fences", () => {
  const text = "before\n~~~\nhidden\n~~~\nafter";
  expect(stripFencedBlocks(text)).toBe("before\nafter");
});

test("stripFencedBlocks handles nested fences (longer marker closes)", () => {
  const text = "before\n```\ninner\n```\n```\ninner2\n```\nafter";
  expect(stripFencedBlocks(text)).toBe("before\nafter");
});

test("stripFencedBlocks does not strip indented code blocks (>4 spaces)", () => {
  const text = "before\n    indented\nafter";
  expect(stripFencedBlocks(text)).toBe("before\n    indented\nafter");
});

test("stripFencedBlocks handles unclosed fence (rest is hidden)", () => {
  const text = "before\n```\nhidden\nno close";
  expect(stripFencedBlocks(text)).toBe("before");
});

test("stripFencedBlocks handles fence with leading spaces (<=3)", () => {
  const text = "before\n  ```\nhidden\n  ```\nafter";
  expect(stripFencedBlocks(text)).toBe("before\nafter");
});

// ---------------------------------------------------------------------------
// parseCheck
// ---------------------------------------------------------------------------

test("parseCheck returns PASS when check_line has CHECK_RESULT: PASS", () => {
  const verdict = parseCheck({ check_line: "CHECK_RESULT: PASS" }, "first_line");
  expect(verdict.passed).toBe(true);
  expect(verdict.output).toBe("");
});

test("parseCheck returns FAIL when check_line has CHECK_RESULT: FAIL", () => {
  const verdict = parseCheck({ check_line: "CHECK_RESULT: FAIL" }, "first_line");
  expect(verdict.passed).toBe(false);
  expect(verdict.output).toBe("CHECK_RESULT: FAIL");
});

test("parseCheck line-initial marker matches only the first marker on a line", () => {
  const verdict = parseCheck({ check_line: "CHECK_RESULT: PASS CHECK_RESULT: FAIL" }, "first_line");
  expect(verdict.passed).toBe(true);
});

test("parseCheck FAIL beats PASS across multiple lines", () => {
  const text = "CHECK_RESULT: PASS\nCHECK_RESULT: FAIL";
  const verdict = parseCheck({ check_line: text }, "first_line");
  expect(verdict.passed).toBe(false);
});

test("parseCheck missing marker fails (first_line mode)", () => {
  const verdict = parseCheck({ check_line: "no marker here" }, "first_line");
  expect(verdict.passed).toBe(false);
});

test("parseCheck recovers from full response when check_line has no marker", () => {
  const verdict = parseCheck(
    { check_line: "narration first", response: "some text\nCHECK_RESULT: PASS" },
    "first_line",
  );
  expect(verdict.passed).toBe(true);
});

test("parseCheck does not recover from response when response also has FAIL", () => {
  const verdict = parseCheck(
    { check_line: "narration", response: "CHECK_RESULT: FAIL\nCHECK_RESULT: PASS" },
    "first_line",
  );
  expect(verdict.passed).toBe(false);
});

test("parseCheck ignores markers inside fenced blocks", () => {
  const verdict = parseCheck(
    { check_line: "```\nCHECK_RESULT: PASS\n```\nCHECK_RESULT: FAIL" },
    "first_line",
  );
  expect(verdict.passed).toBe(false);
});

test("parseCheck full mode scans the response text", () => {
  const verdict = parseCheck({ response: "blah\nCHECK_RESULT: PASS\nblah" }, "full");
  expect(verdict.passed).toBe(true);
});

test("parseCheck full mode FAIL beats PASS", () => {
  const verdict = parseCheck({ response: "CHECK_RESULT: PASS\nCHECK_RESULT: FAIL" }, "full");
  expect(verdict.passed).toBe(false);
});

test("parseCheck output is bounded to 4000 chars", () => {
  const longOutput = "x".repeat(5000);
  const verdict = parseCheck({ check_line: longOutput }, "first_line");
  expect(verdict.output.length).toBeLessThanOrEqual(4000);
});

test("parseCheck uses failure_tail when available in first_line mode", () => {
  const verdict = parseCheck(
    { check_line: "no marker", failure_tail: "tail output" },
    "first_line",
  );
  expect(verdict.passed).toBe(false);
  expect(verdict.output).toBe("tail output");
});

test("parseCheck handles null result", () => {
  const verdict = parseCheck(null, "full");
  expect(verdict.passed).toBe(false);
});

// ---------------------------------------------------------------------------
// roundMessage
// ---------------------------------------------------------------------------

test("roundMessage round 0 uses the task message directly", () => {
  const msg = roundMessage(0, "fix the bug", "bun run typecheck", null, null);
  expect(msg).toContain("fix the bug");
  expect(msg).not.toContain("A previous attempt");
  expect(msg).toContain("CHECK_RESULT: PASS");
});

test("roundMessage later rounds reference the previous branch and output", () => {
  const msg = roundMessage(1, "fix the bug", "bun run typecheck", "feature/prev", "error here");
  expect(msg).toContain("feature/prev");
  expect(msg).toContain("error here");
  expect(msg).toContain("fix the bug");
});

test("roundMessage handles null prevOutput", () => {
  const msg = roundMessage(1, "fix the bug", "bun run typecheck", "feature/prev", null);
  expect(msg).toContain("(none captured)");
});

test("roundMessage is byte-for-byte unchanged without a parity command", () => {
  expect(roundMessage(0, "fix the bug", "bun run typecheck", null, null)).toBe(
    [
      "fix the bug",
      "",
      "When done, run this check in the repo by spawning bash with the command as a single argument:",
      "    bash -c 'bun run typecheck'",
      "If it fails, fix and re-run until it passes or you cannot make further progress. Commit your work on the worktree branch.",
      "IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`. If FAIL, follow it with the last ~50 lines of the check output inside a fenced ``` block.",
    ].join("\n"),
  );
  expect(roundMessage(1, "fix the bug", "bun run typecheck", "feature/prev", "error here")).toBe(
    [
      "A previous attempt (branch feature/prev) still fails the check. Build on that branch and fix it.",
      "",
      "Original task:",
      "fix the bug",
      "",
      "Last failure output:",
      "error here",
      "",
      "When done, run this check in the repo by spawning bash with the command as a single argument:",
      "    bash -c 'bun run typecheck'",
      "If it fails, fix and re-run until it passes or you cannot make further progress. Commit your work on the worktree branch.",
      "IMPORTANT: BEGIN your FINAL message with a line that is exactly `CHECK_RESULT: PASS` or `CHECK_RESULT: FAIL`. If FAIL, follow it with the last ~50 lines of the check output inside a fenced ``` block.",
    ].join("\n"),
  );
});

test("roundMessage includes the parity command when one is set", () => {
  const msg = roundMessage(0, "fix the bug", "bun run typecheck", null, null, "bun run check:ci");
  expect(msg).toContain("bash -c 'bun run check:ci'");
  expect(msg).toContain("BOTH");
  expect(msg).not.toContain("If it fails, fix and re-run until it passes");
});

test("roundMessage with parity still carries the previous failure output", () => {
  const msg = roundMessage(
    1,
    "fix the bug",
    "bun run typecheck",
    "feature/prev",
    "parity_exit=1 lint:strict failed",
    "bun run check:ci",
  );
  expect(msg).toContain("Last failure output:");
  expect(msg).toContain("parity_exit=1 lint:strict failed");
  expect(msg).toContain("bash -c 'bun run check:ci'");
});

// ---------------------------------------------------------------------------
// validateCheckCommand
// ---------------------------------------------------------------------------

test("validateCheckCommand passes when check includes both lint:strict and check-typecheck-coverage.ts", () => {
  expect(
    validateCheckCommand(
      "bun run lint:strict && bun run scripts/check-typecheck-coverage.ts",
      false,
    ),
  ).toBeNull();
});

test("validateCheckCommand fails when lint:strict is missing", () => {
  const err = validateCheckCommand("bun run scripts/check-typecheck-coverage.ts", false);
  expect(err).toContain("lint:strict");
});

test("validateCheckCommand fails when check-typecheck-coverage.ts is missing", () => {
  const err = validateCheckCommand("bun run lint:strict", false);
  expect(err).toContain("check-typecheck-coverage.ts");
});

test("validateCheckCommand returns null when allowPartialCheck is true", () => {
  expect(validateCheckCommand("bun run test", true)).toBeNull();
});

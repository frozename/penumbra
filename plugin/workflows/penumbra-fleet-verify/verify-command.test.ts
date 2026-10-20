import { expect, test } from "bun:test";

import {
  FIXED_VERIFY_COMMANDS,
  isTestSliceCommand,
  renderVerifyPrompt,
  TEST_SLICE_COMMANDS,
  validateVerifyReport,
  VERIFY_COMMAND_ALLOWLIST,
  type VerifyReport,
  VerifyReportSchema,
} from "./verify-command.js";

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

test("FIXED_VERIFY_COMMANDS contains typecheck, typecheck_ratchet, lint_strict", () => {
  expect([...FIXED_VERIFY_COMMANDS]).toEqual(["typecheck", "typecheck_ratchet", "lint_strict"]);
});

test("TEST_SLICE_COMMANDS covers all package test directories", () => {
  const slices = [...TEST_SLICE_COMMANDS];
  expect(slices).toContain("test_core");
  expect(slices).toContain("test_daemon");
  expect(slices).toContain("test_agentchat_cli");
  expect(slices).toContain("test_workflows");
  expect(slices.length).toBeGreaterThanOrEqual(12);
});

test("VERIFY_COMMAND_ALLOWLIST includes all fixed and test slice commands", () => {
  for (const cmd of FIXED_VERIFY_COMMANDS) {
    expect(VERIFY_COMMAND_ALLOWLIST.has(cmd)).toBe(true);
  }
  for (const cmd of TEST_SLICE_COMMANDS) {
    expect(VERIFY_COMMAND_ALLOWLIST.has(cmd)).toBe(true);
  }
  expect(VERIFY_COMMAND_ALLOWLIST.has("arbitrary_shell_command")).toBe(false);
  expect(VERIFY_COMMAND_ALLOWLIST.has("rm -rf /")).toBe(false);
});

test("isTestSliceCommand distinguishes test slices from fixed commands", () => {
  expect(isTestSliceCommand("test_core")).toBe(true);
  expect(isTestSliceCommand("test_daemon")).toBe(true);
  expect(isTestSliceCommand("typecheck")).toBe(false);
  expect(isTestSliceCommand("lint_strict")).toBe(false);
  expect(isTestSliceCommand("typecheck_ratchet")).toBe(false);
});

// ---------------------------------------------------------------------------
// Report schema
// ---------------------------------------------------------------------------

function validReport(overrides: Partial<VerifyReport> = {}): VerifyReport {
  return {
    verdict: "pass",
    target_identity: "0123456789abcdef0123456789abcdef01234567",
    measured_exits: [
      { command: "typecheck", exit: 0 },
      { command: "typecheck_ratchet", exit: 0 },
      { command: "lint_strict", exit: 0 },
    ],
    test_results: null,
    tests_pass: null,
    tests_fail: null,
    files_changed: 3,
    attribution_lines: 0,
    notes: "all good",
    ...overrides,
  };
}

test("VerifyReportSchema accepts a well-formed report", () => {
  const result = VerifyReportSchema.safeParse(validReport());
  expect(result.success).toBe(true);
});

test("VerifyReportSchema rejects unknown keys", () => {
  const result = VerifyReportSchema.safeParse({
    ...validReport(),
    extra_field: "bad",
  });
  expect(result.success).toBe(false);
});

test("VerifyReportSchema rejects non-integer exit codes", () => {
  const result = VerifyReportSchema.safeParse({
    ...validReport(),
    measured_exits: { typecheck: "0" },
  });
  expect(result.success).toBe(false);
});

test("VerifyReportSchema rejects invalid verdict", () => {
  const result = VerifyReportSchema.safeParse({
    ...validReport(),
    verdict: "maybe",
  });
  expect(result.success).toBe(false);
});

// ---------------------------------------------------------------------------
// validateVerifyReport
// ---------------------------------------------------------------------------

const DEFAULT_COMMANDS = ["typecheck", "typecheck_ratchet", "lint_strict"];
const DEFAULT_IDENTITY = "0123456789abcdef0123456789abcdef01234567";

test("validates a clean pass report", () => {
  const result = validateVerifyReport(validReport(), DEFAULT_COMMANDS, DEFAULT_IDENTITY);
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
});

test("rejects target identity mismatch", () => {
  const result = validateVerifyReport(
    validReport({ target_identity: "wrong-branch" }),
    DEFAULT_COMMANDS,
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(false);
  expect(result.errors).toContain("target_identity_mismatch");
});

test("rejects missing exit for a requested command", () => {
  const result = validateVerifyReport(
    validReport({
      measured_exits: [
        { command: "typecheck", exit: 0 },
        { command: "typecheck_ratchet", exit: 0 },
      ],
    }),
    DEFAULT_COMMANDS,
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(false);
  expect(result.errors.some((e) => e.startsWith("missing_exit:lint_strict"))).toBe(true);
});

test("rejects unknown exit not in requested commands", () => {
  const result = validateVerifyReport(
    validReport({
      measured_exits: [
        { command: "typecheck", exit: 0 },
        { command: "typecheck_ratchet", exit: 0 },
        { command: "lint_strict", exit: 0 },
        { command: "evil_command", exit: 0 },
      ],
    }),
    DEFAULT_COMMANDS,
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(false);
  expect(result.errors.some((e) => e.startsWith("unknown_exit:evil_command"))).toBe(true);
});

test("rejects skipped exit (-1)", () => {
  const result = validateVerifyReport(
    validReport({
      measured_exits: [
        { command: "typecheck", exit: -1 },
        { command: "typecheck_ratchet", exit: 0 },
        { command: "lint_strict", exit: 0 },
      ],
    }),
    DEFAULT_COMMANDS,
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(false);
  expect(result.errors.some((e) => e.startsWith("skipped_exit:typecheck"))).toBe(true);
});

test("rejects nonzero exit", () => {
  const result = validateVerifyReport(
    validReport({
      measured_exits: [
        { command: "typecheck", exit: 1 },
        { command: "typecheck_ratchet", exit: 0 },
        { command: "lint_strict", exit: 0 },
      ],
    }),
    DEFAULT_COMMANDS,
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(false);
  expect(result.errors.some((e) => e.startsWith("nonzero_exit:typecheck:1"))).toBe(true);
});

test("rejects tests_fail > 0 when test commands requested", () => {
  const result = validateVerifyReport(
    validReport({
      measured_exits: [
        { command: "typecheck", exit: 0 },
        { command: "test_core", exit: 0 },
      ],
      test_results: [{ command: "test_core", tests_pass: 5, tests_fail: 1 }],
      tests_pass: 5,
      tests_fail: 1,
    }),
    ["typecheck", "test_core"],
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(false);
  expect(result.errors).toContain("tests_fail_gt_0");
});

test("rejects tests claimed when no test commands requested", () => {
  const result = validateVerifyReport(
    validReport({
      test_results: [{ command: "test_core", tests_pass: 5, tests_fail: 0 }],
      tests_pass: 5,
      tests_fail: 0,
    }),
    DEFAULT_COMMANDS,
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(false);
  expect(result.errors).toContain("tests_claimed_without_test_commands");
});

test("requires null test measurements when no test commands are requested", () => {
  const result = validateVerifyReport(
    validReport({ test_results: null, tests_pass: null, tests_fail: null }),
    DEFAULT_COMMANDS,
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(true);
});

test("rejects attribution_lines > 0", () => {
  const result = validateVerifyReport(
    validReport({ attribution_lines: 2 }),
    DEFAULT_COMMANDS,
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(false);
  expect(result.errors).toContain("attribution_lines_gt_0");
});

test("rejects verdict pass when gates fail (verdict is ignored)", () => {
  const result = validateVerifyReport(
    validReport({
      verdict: "pass",
      measured_exits: [
        { command: "typecheck", exit: 1 },
        { command: "typecheck_ratchet", exit: 0 },
        { command: "lint_strict", exit: 0 },
      ],
    }),
    DEFAULT_COMMANDS,
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(false);
  expect(result.errors.some((e) => e.startsWith("nonzero_exit"))).toBe(true);
});

test("rejects explicit verdict fail even when all measured gates pass", () => {
  const result = validateVerifyReport(
    validReport({ verdict: "fail" }),
    DEFAULT_COMMANDS,
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(false);
  expect(result.errors).toContain("verdict_not_pass");
});

test("accepts test commands with zero failures", () => {
  const result = validateVerifyReport(
    validReport({
      measured_exits: [
        { command: "typecheck", exit: 0 },
        { command: "test_core", exit: 0 },
        { command: "test_daemon", exit: 0 },
      ],
      test_results: [
        { command: "test_core", tests_pass: 20, tests_fail: 0 },
        { command: "test_daemon", tests_pass: 22, tests_fail: 0 },
      ],
      tests_pass: 42,
      tests_fail: 0,
    }),
    ["typecheck", "test_core", "test_daemon"],
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(true);
});

test("rejects duplicate measured exit entries including a hidden nonzero", () => {
  const report = validReport({
    measured_exits: [
      { command: "typecheck", exit: 0 },
      { command: "typecheck", exit: 1 },
      { command: "typecheck_ratchet", exit: 0 },
      { command: "lint_strict", exit: 0 },
    ],
  });
  const result = validateVerifyReport(report, DEFAULT_COMMANDS, DEFAULT_IDENTITY);
  expect(result.ok).toBe(false);
  expect(result.errors).toContain("duplicate_exit:typecheck");
  expect(result.errors).toContain("nonzero_exit:typecheck:1");
});

test("rejects synthetic zero test counts for a requested test command", () => {
  const result = validateVerifyReport(
    validReport({
      measured_exits: [{ command: "test_core", exit: 0 }],
      test_results: [{ command: "test_core", tests_pass: 0, tests_fail: 0 }],
      tests_pass: 0,
      tests_fail: 0,
    }),
    ["test_core"],
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(false);
  expect(result.errors).toContain("tests_not_run:test_core");
});

test("rejects missing per-command test receipt", () => {
  const result = validateVerifyReport(
    validReport({
      measured_exits: [{ command: "test_core", exit: 0 }],
      test_results: [],
      tests_pass: 1,
      tests_fail: 0,
    }),
    ["test_core"],
    DEFAULT_IDENTITY,
  );
  expect(result.ok).toBe(false);
  expect(result.errors).toContain("missing_test_result:test_core");
});

test("VerifyReportSchema bounds notes", () => {
  const result = VerifyReportSchema.safeParse({
    ...validReport(),
    notes: "x".repeat(2_001),
  });
  expect(result.success).toBe(false);
});

// ---------------------------------------------------------------------------
// renderVerifyPrompt
// ---------------------------------------------------------------------------

test("renderVerifyPrompt includes all command descriptions", () => {
  const prompt = renderVerifyPrompt({
    taskName: "task-1",
    candidateBranch: "feature/test",
    expectedTargetIdentity: DEFAULT_IDENTITY,
    verifyCommands: ["typecheck", "lint_strict"],
    verifyChecklist: null,
  });
  expect(prompt).toContain("typecheck");
  expect(prompt).toContain("lint_strict");
  expect(prompt).toContain("bun run typecheck");
  expect(prompt).toContain("ESLint");
  expect(prompt).toContain("verify-report");
});

test("renderVerifyPrompt includes checklist when provided", () => {
  const prompt = renderVerifyPrompt({
    taskName: "task-1",
    candidateBranch: "feature/test",
    expectedTargetIdentity: DEFAULT_IDENTITY,
    verifyCommands: ["typecheck"],
    verifyChecklist: "Check that foo is bar",
  });
  expect(prompt).toContain("Caller checklist");
  expect(prompt).toContain("Check that foo is bar");
});

test("renderVerifyPrompt omits checklist section when null", () => {
  const prompt = renderVerifyPrompt({
    taskName: "task-1",
    candidateBranch: "feature/test",
    expectedTargetIdentity: DEFAULT_IDENTITY,
    verifyCommands: ["typecheck"],
    verifyChecklist: null,
  });
  expect(prompt).not.toContain("Caller checklist");
});

test("renderVerifyPrompt includes test instruction for test commands", () => {
  const prompt = renderVerifyPrompt({
    taskName: "task-1",
    candidateBranch: "feature/test",
    expectedTargetIdentity: DEFAULT_IDENTITY,
    verifyCommands: ["typecheck", "test_core"],
    verifyChecklist: null,
  });
  expect(prompt).toContain("test_core");
  expect(prompt).toContain("Run every requested test slice");
});

test("renderVerifyPrompt includes no-test instruction when no test commands", () => {
  const prompt = renderVerifyPrompt({
    taskName: "task-1",
    candidateBranch: "feature/test",
    expectedTargetIdentity: DEFAULT_IDENTITY,
    verifyCommands: ["typecheck", "lint_strict"],
    verifyChecklist: null,
  });
  expect(prompt).toContain("No test commands were requested");
  expect(prompt).toContain("tests_pass, and tests_fail to null");
});

test("renderVerifyPrompt includes expected target identity", () => {
  const prompt = renderVerifyPrompt({
    taskName: "task-1",
    candidateBranch: "feature/test",
    expectedTargetIdentity: DEFAULT_IDENTITY,
    verifyCommands: ["typecheck"],
    verifyChecklist: null,
  });
  expect(prompt).toContain("feature/test");
});

test("renderVerifyPrompt does not interpolate arbitrary shell commands", () => {
  const prompt = renderVerifyPrompt({
    taskName: "task-1",
    candidateBranch: "feature/test",
    expectedTargetIdentity: DEFAULT_IDENTITY,
    verifyCommands: ["typecheck"],
    verifyChecklist: null,
  });
  expect(prompt).not.toContain("rm -rf");
  expect(prompt).not.toContain("$( ");
  expect(prompt).not.toMatch(/eval\b/);
});

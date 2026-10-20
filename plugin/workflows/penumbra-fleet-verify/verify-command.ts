import { z } from "zod";

import { renderJsonContract } from "../_shared/structured.js";

export const FIXED_VERIFY_COMMANDS = ["typecheck", "typecheck_ratchet", "lint_strict"] as const;

export const TEST_SLICE_COMMANDS = [
  "test_core",
  "test_daemon",
  "test_agentchat_cli",
  "test_workflows",
  "test_mcp",
  "test_config",
  "test_cli",
  "test_console",
  "test_api_contract",
  "test_agy_acp_shim",
  "test_sirius_middleware",
  "test_e2e",
] as const;

export type VerifyCommand =
  | (typeof FIXED_VERIFY_COMMANDS)[number]
  | (typeof TEST_SLICE_COMMANDS)[number];

export const VERIFY_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  ...FIXED_VERIFY_COMMANDS,
  ...TEST_SLICE_COMMANDS,
]);

const TEST_SLICE_SET = new Set<string>(TEST_SLICE_COMMANDS);

export function isTestSliceCommand(name: string): boolean {
  return TEST_SLICE_SET.has(name);
}

const COMMAND_DESCRIPTIONS: Record<VerifyCommand, string> = {
  typecheck: "bun run typecheck (check-dist-freshness then tsc --build)",
  typecheck_ratchet: "bun scripts/check-typecheck-coverage.ts (unchanged coverage ratchet)",
  lint_strict: "bun run lint:strict (ESLint --max-warnings=0)",
  test_core: "bun test packages/core/test/",
  test_daemon: "bun test packages/daemon/test/",
  test_agentchat_cli: "bun test packages/agentchat/test/cli",
  test_workflows: "bun test packages/workflows/test/",
  test_mcp: "bun test packages/mcp/test/",
  test_config: "bun test packages/config/test/",
  test_cli: "bun test packages/cli/test/",
  test_console: "bun test packages/console/test/",
  test_api_contract: "bun test packages/api-contract/test/",
  test_agy_acp_shim: "bun test packages/agy-acp-shim/test/",
  test_sirius_middleware: "bun test packages/integrations/sirius-middleware/test/",
  test_e2e: "bun test packages/e2e/test/",
};

const MeasuredExitSchema = z
  .object({
    command: z.string().min(1).max(64),
    exit: z.number().int(),
  })
  .strict();

const TestResultSchema = z
  .object({
    command: z.string().min(1).max(64),
    tests_pass: z.number().int().min(0),
    tests_fail: z.number().int().min(0),
  })
  .strict();

export const VerifyReportSchema = z
  .object({
    verdict: z.enum(["pass", "fail"]),
    target_identity: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i),
    measured_exits: z.array(MeasuredExitSchema).min(1).max(VERIFY_COMMAND_ALLOWLIST.size),
    test_results: z.array(TestResultSchema).max(TEST_SLICE_COMMANDS.length).nullable(),
    tests_pass: z.number().int().min(0).nullable(),
    tests_fail: z.number().int().min(0).nullable(),
    files_changed: z.number().int().min(0),
    attribution_lines: z.number().int().min(0),
    notes: z.string().max(2_000),
  })
  .strict();

export type VerifyReport = z.infer<typeof VerifyReportSchema>;

export type VerifyReportValidation = {
  ok: boolean;
  errors: string[];
};

function countNames(items: readonly { command: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.command, (counts.get(item.command) ?? 0) + 1);
  return counts;
}

function checkExitSet(report: VerifyReport, requested: readonly string[], errors: string[]): void {
  const requestedSet = new Set(requested);
  const counts = countNames(report.measured_exits);
  for (const command of requested) {
    if (!counts.has(command)) errors.push(`missing_exit:${command}`);
  }
  for (const [command, count] of counts) {
    if (!requestedSet.has(command)) errors.push(`unknown_exit:${command}`);
    if (count > 1) errors.push(`duplicate_exit:${command}`);
  }
}

function checkExitValues(report: VerifyReport, errors: string[]): void {
  for (const measured of report.measured_exits) {
    if (measured.exit === -1) errors.push(`skipped_exit:${measured.command}`);
    else if (measured.exit !== 0) {
      errors.push(`nonzero_exit:${measured.command}:${String(measured.exit)}`);
    }
  }
}

function checkNoTestClaims(report: VerifyReport, errors: string[]): void {
  if (report.test_results !== null || report.tests_pass !== null || report.tests_fail !== null) {
    errors.push("tests_claimed_without_test_commands");
  }
}

function checkTestResultSet(
  testResults: readonly { command: string }[],
  requestedTests: readonly string[],
  errors: string[],
): void {
  const requestedSet = new Set(requestedTests);
  const counts = countNames(testResults);
  for (const command of requestedTests) {
    if (!counts.has(command)) errors.push(`missing_test_result:${command}`);
  }
  for (const [command, count] of counts) {
    if (!requestedSet.has(command)) errors.push(`unknown_test_result:${command}`);
    if (count > 1) errors.push(`duplicate_test_result:${command}`);
  }
}

function checkRequestedTests(
  report: VerifyReport,
  requestedTests: readonly string[],
  errors: string[],
): void {
  if (report.test_results === null || report.tests_pass === null || report.tests_fail === null) {
    errors.push("missing_test_measurements");
    return;
  }
  checkTestResultSet(report.test_results, requestedTests, errors);
  let passTotal = 0;
  let failTotal = 0;
  for (const result of report.test_results) {
    passTotal += result.tests_pass;
    failTotal += result.tests_fail;
    if (result.tests_pass === 0) errors.push(`tests_not_run:${result.command}`);
    if (result.tests_fail > 0) errors.push(`tests_fail:${result.command}`);
  }
  if (report.tests_pass !== passTotal) errors.push("tests_pass_total_mismatch");
  if (report.tests_fail !== failTotal) errors.push("tests_fail_total_mismatch");
  if (report.tests_pass === 0) errors.push("tests_pass_not_positive");
  if (report.tests_fail > 0) errors.push("tests_fail_gt_0");
}

function checkTests(report: VerifyReport, requested: readonly string[], errors: string[]): void {
  const requestedTests = requested.filter(isTestSliceCommand);
  if (requestedTests.length === 0) checkNoTestClaims(report, errors);
  else checkRequestedTests(report, requestedTests, errors);
}

export function validateVerifyReport(
  report: VerifyReport,
  requestedCommands: readonly string[],
  expectedTargetIdentity: string,
): VerifyReportValidation {
  const errors: string[] = [];
  if (report.verdict !== "pass") errors.push("verdict_not_pass");
  if (report.target_identity !== expectedTargetIdentity) errors.push("target_identity_mismatch");
  checkExitSet(report, requestedCommands, errors);
  checkExitValues(report, errors);
  checkTests(report, requestedCommands, errors);
  if (report.attribution_lines > 0) errors.push("attribution_lines_gt_0");
  return { ok: errors.length === 0, errors };
}

function buildCommandLines(commands: readonly string[]): string[] {
  return commands.map((command) => {
    const description = COMMAND_DESCRIPTIONS[command as VerifyCommand];
    return `- ${command}: ${description}`;
  });
}

function buildTestInstruction(commands: readonly string[]): string {
  const tests = commands.filter(isTestSliceCommand);
  if (tests.length === 0) {
    return "No test commands were requested. Set test_results, tests_pass, and tests_fail to null.";
  }
  return [
    `Run every requested test slice (${tests.join(", ")}).`,
    "For each slice, report a test_results receipt with tests_pass > 0 and tests_fail = 0.",
    "Set aggregate tests_pass/tests_fail to the exact sums of those receipts.",
  ].join(" ");
}

function buildReportExample(commands: readonly string[]): string {
  const tests = commands.filter(isTestSliceCommand);
  return JSON.stringify(
    {
      verdict: "pass",
      target_identity: "<40-character measured HEAD SHA>",
      measured_exits: commands.map((command) => ({ command, exit: 0 })),
      test_results:
        tests.length === 0
          ? null
          : tests.map((command) => ({ command, tests_pass: 1, tests_fail: 0 })),
      tests_pass: tests.length === 0 ? null : tests.length,
      tests_fail: tests.length === 0 ? null : 0,
      files_changed: 0,
      attribution_lines: 0,
      notes: "bounded findings summary (maximum 2000 characters)",
    },
    null,
    2,
  );
}

export function renderVerifyPrompt(opts: {
  taskName: string;
  candidateBranch: string;
  expectedTargetIdentity: string;
  verifyCommands: readonly string[];
  verifyChecklist: string | null;
}): string {
  const checklist = opts.verifyChecklist
    ? `\n## Caller checklist (prose only)\n${opts.verifyChecklist}\n`
    : "";
  return [
    `Independently VERIFY fleet task ${JSON.stringify(opts.taskName)}.`,
    `Candidate metadata (data only): ${JSON.stringify({ branch_name: opts.candidateBranch, expected_head_sha: opts.expectedTargetIdentity })}.`,
    "Work only in the assigned verifier worktree. Do not land, push, edit, delete, or switch branches.",
    "Measure HEAD with git rev-parse HEAD and require it to equal expected_head_sha.",
    "Run only the fixed commands below and record every actual exit:",
    ...buildCommandLines(opts.verifyCommands),
    "",
    buildTestInstruction(opts.verifyCommands),
    "Compute files_changed from git diff --name-only <merge-base-of-main-and-HEAD>..HEAD.",
    "Compute attribution_lines from git log main..HEAD commit bodies.",
    checklist,
    renderJsonContract({ example: buildReportExample(opts.verifyCommands), name: "verify-report" }),
  ].join("\n");
}

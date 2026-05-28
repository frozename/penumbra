import type { GateInput, GateResult } from "./index.js";

const PASS_RE = /(\d+)\s+pass\b/i;
const FAIL_RE = /(\d+)\s+fail\b/i;
const BUN_TEST_MARKER = /bun test/i;

export function verifyTdd(input: GateInput): GateResult {
  const stdout = input.dispatchResult?.stdout ?? "";
  if (!input.dispatchResult) {
    return { passed: true, evidence: "no dispatch result; gate inert", severity: "triggers-retry" };
  }
  if (!BUN_TEST_MARKER.test(stdout)) {
    return {
      passed: false,
      evidence: "no `bun test` output found in dispatch stdout",
      severity: "triggers-retry",
    };
  }
  const failMatch = stdout.match(FAIL_RE);
  const failCount = failMatch?.[1] ? Number.parseInt(failMatch[1], 10) : 0;
  if (failCount > 0) {
    return {
      passed: false,
      evidence: `${failCount} fail in test output`,
      severity: "triggers-retry",
    };
  }
  const passMatch = stdout.match(PASS_RE);
  const passCount = passMatch?.[1] ? Number.parseInt(passMatch[1], 10) : 0;
  return {
    passed: passCount > 0,
    evidence: passCount > 0 ? `${passCount} pass, 0 fail` : "no pass count detected",
    severity: "triggers-retry",
  };
}

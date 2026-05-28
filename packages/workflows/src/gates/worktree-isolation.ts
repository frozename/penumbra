import type { GateInput, GateResult } from "./index.js";

export function verifyWorktreeIsolation(input: GateInput): GateResult {
  if (input.spec?.use_worktree === undefined) {
    return {
      passed: true,
      evidence: "no spec.use_worktree provided; gate inert",
      severity: "advisory",
    };
  }
  return {
    passed: input.spec.use_worktree === true,
    evidence: input.spec.use_worktree
      ? "dispatch ran in worktree"
      : "dispatch did not use worktree",
    severity: "advisory",
  };
}

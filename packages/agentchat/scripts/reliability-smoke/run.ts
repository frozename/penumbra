import type { DispatchReliabilityStatus } from "@penumbra/core";

export type ReliabilitySmokeScenario =
  | "success_with_output"
  | "empty_success"
  | "stderr_only"
  | "nonzero_exit"
  | "signal_exit"
  | "cancel_process_group"
  | "implementation_no_diff"
  | "review_no_sources"
  | "watchdog_missing_end";

export interface ReliabilitySmokeResult {
  scenario: ReliabilitySmokeScenario;
  expectedStatus: DispatchReliabilityStatus;
  actualStatus: DispatchReliabilityStatus | null;
}

const EXPECTED: Record<ReliabilitySmokeScenario, DispatchReliabilityStatus> = {
  success_with_output: "complete",
  empty_success: "no_agent_output",
  stderr_only: "no_agent_output",
  nonzero_exit: "complete",
  signal_exit: "complete",
  cancel_process_group: "complete",
  implementation_no_diff: "no_worktree_activity",
  review_no_sources: "agent_declared_done_unverified",
  watchdog_missing_end: "watchdog_only",
};

export async function runReliabilitySmokeScenario(
  scenario: ReliabilitySmokeScenario,
  opts: { dryRun?: boolean } = {},
): Promise<ReliabilitySmokeResult> {
  if (opts.dryRun) {
    return { scenario, expectedStatus: EXPECTED[scenario], actualStatus: null };
  }

  throw new Error("live reliability smoke execution is implemented in the next task");
}

if (import.meta.main) {
  const scenarios = Object.keys(EXPECTED) as ReliabilitySmokeScenario[];
  for (const scenario of scenarios) {
    const result = await runReliabilitySmokeScenario(scenario, { dryRun: true });
    console.log(`${result.scenario}\t${result.expectedStatus}`);
  }
}

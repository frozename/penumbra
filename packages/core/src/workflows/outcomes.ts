export const EXECUTE_OUTCOMES = ["success", "render_error", "run_error", "gated_failure"] as const;
export type ExecuteOutcome = (typeof EXECUTE_OUTCOMES)[number];

export function isExecuteOutcome(value: string): value is ExecuteOutcome {
  return (EXECUTE_OUTCOMES as readonly string[]).includes(value);
}

// Derived, never restated: a fifth member added to EXECUTE_OUTCOMES joins FAILURE_OUTCOMES
// automatically. Two independent literals would reintroduce the drift this module exists to close.
export const FAILURE_OUTCOMES: ReadonlySet<ExecuteOutcome> = new Set(
  EXECUTE_OUTCOMES.filter((outcome) => outcome !== "success"),
);

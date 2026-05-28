import type { TaskRecord } from "../tasks/schema.js";

export interface MaestroPromptBounds {
  wall_clock_budget_ms: number;
  cost_budget_cents: number;
  sub_dispatch_budget: number;
}

function renderOptionalText(value: string | null): string {
  return value && value.length > 0 ? value : "(none specified)";
}

function renderExpectedArtifacts(value: TaskRecord["expected_artifacts"]): string {
  return value && value.length > 0 ? JSON.stringify(value, null, 2) : "(none specified)";
}

export function synthesizeMaestroPrompt(task: TaskRecord, bounds: MaestroPromptBounds): string {
  const wallClockMinutes = Math.round(bounds.wall_clock_budget_ms / 60_000);
  const costDollars = (bounds.cost_budget_cents / 100).toFixed(2);

  return `You are an autonomous orchestrator for task ${task.id}.

ORIGINAL PROMPT:
${task.prompt}

ACCEPTANCE CRITERIA:
${renderOptionalText(task.acceptance_criteria)}

EXPECTED ARTIFACTS:
${renderExpectedArtifacts(task.expected_artifacts)}

YOU HAVE THE FOLLOWING POWERS:
- task.file (kind=work or kind=review) to decompose work onto the board
- task.list / task.get to inspect the board
- chain_start to dispatch sub-agents directly (each call counts toward your sub-dispatch budget)
- All other read-only MCP tools (memory.*, fs.*, dispatch.*, etc.)

YOU HAVE THE FOLLOWING BUDGETS (consumed as you work):
- Wall clock: ${wallClockMinutes} minutes from now
- Cost: $${costDollars}
- Sub-dispatches: ${bounds.sub_dispatch_budget} chain_start calls

When you finish, call task.complete with a result_summary and any expected_artifacts you produced.
If you cannot complete, call task.fail with a reason.

If you receive a "BUDGET WARNING" message during work, you have ~20% of one or more budgets remaining. Wrap up immediately — call task.complete with whatever you have, or task.fail explicitly.`;
}

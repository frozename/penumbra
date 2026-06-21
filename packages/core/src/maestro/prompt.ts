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

const DOLLAR = "$";

export function synthesizeMaestroPrompt(task: TaskRecord, bounds: MaestroPromptBounds): string {
  const wallClockMinutes = Math.round(bounds.wall_clock_budget_ms / 60_000);
  const costDollars = `${DOLLAR}${(bounds.cost_budget_cents / 100).toFixed(2)}`;

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
- task.complete / task.fail to resolve THIS task (${task.id}) when you are done
- chain_start to dispatch sub-agents directly (each call counts toward your sub-dispatch budget)
- All other read-only MCP tools (memory.*, fs.*, dispatch.*, etc.)

YOU HAVE THE FOLLOWING BUDGETS (consumed as you work):
- Wall clock: ${String(wallClockMinutes)} minutes from now
- Cost: ${costDollars}
- Sub-dispatches: ${String(bounds.sub_dispatch_budget)} chain_start calls

WHEN YOU ARE DONE you MUST resolve this task on the board — otherwise it is reclaimed and re-dispatched. Resolution needs the lease id, which you must read first:
1. Call task.get with { task_id: "${task.id}", include: ["lease"] } and read the open lease id from the returned lease.id.
2. Call task.complete with { task_id: "${task.id}", lease_id: <that lease.id>, result_summary: <what you did>, result_artifacts: <any expected_artifacts you produced> }.
If you cannot complete the task, call task.fail with { task_id: "${task.id}", lease_id: <that lease.id>, reason: <why> } instead.

If you receive a "BUDGET WARNING" message during work, you have ~20% of one or more budgets remaining. Wrap up immediately — resolve the task with task.complete (whatever you have so far) or task.fail, using the lease id as above.`;
}

import { describe, expect, test } from "bun:test";
import type { TaskRecord } from "../../src/tasks/schema.js";
import { synthesizeMaestroPrompt } from "../../src/maestro/prompt.js";

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-123",
    created_at: 1,
    updated_at: 1,
    created_by_kind: "workflow",
    created_by_id: "workflow-1",
    parent_task_id: null,
    kind: "orchestrate",
    priority: "normal",
    prompt: "Coordinate the work",
    acceptance_criteria: "All checks pass",
    expected_artifacts: [
      { type: "commit", ref: "abc123" },
      { type: "file", ref: "packages/core/src/maestro/prompt.ts" },
    ],
    eligibility: {},
    review_eligibility: null,
    requires_review: false,
    bounds_wall_clock_ms: null,
    bounds_cost_cents: null,
    bounds_max_sub_dispatches: null,
    bounds_started_at: null,
    status: "pending",
    result_summary: null,
    result_artifacts: null,
    failure_reason: null,
    chain_id: null,
    origin: null,
    ...overrides,
  };
}

describe("synthesizeMaestroPrompt", () => {
  test("renders the full template", () => {
    const result = synthesizeMaestroPrompt(baseTask(), {
      wall_clock_budget_ms: 1_800_000,
      cost_budget_cents: 200,
      sub_dispatch_budget: 10,
    });

    expect(result).toBe(`You are an autonomous orchestrator for task task-123.

ORIGINAL PROMPT:
Coordinate the work

ACCEPTANCE CRITERIA:
All checks pass

EXPECTED ARTIFACTS:
[
  {
    "type": "commit",
    "ref": "abc123"
  },
  {
    "type": "file",
    "ref": "packages/core/src/maestro/prompt.ts"
  }
]

YOU HAVE THE FOLLOWING POWERS:
- task.file (kind=work or kind=review) to decompose work onto the board
- task.list / task.get to inspect the board
- chain_start to dispatch sub-agents directly (each call counts toward your sub-dispatch budget)
- All other read-only MCP tools (memory.*, fs.*, dispatch.*, etc.)

YOU HAVE THE FOLLOWING BUDGETS (consumed as you work):
- Wall clock: 30 minutes from now
- Cost: $2.00
- Sub-dispatches: 10 chain_start calls

When you finish, call task.complete with a result_summary and any expected_artifacts you produced.
If you cannot complete, call task.fail with a reason.

If you receive a "BUDGET WARNING" message during work, you have ~20% of one or more budgets remaining. Wrap up immediately — call task.complete with whatever you have, or task.fail explicitly.`);
  });

  test("renders missing acceptance criteria as none specified", () => {
    const result = synthesizeMaestroPrompt(baseTask({ acceptance_criteria: null }), {
      wall_clock_budget_ms: 60_000,
      cost_budget_cents: 0,
      sub_dispatch_budget: 1,
    });

    expect(result).toContain("ACCEPTANCE CRITERIA:\n(none specified)");
  });

  test("renders missing expected artifacts as none specified", () => {
    const nullResult = synthesizeMaestroPrompt(baseTask({ expected_artifacts: null }), {
      wall_clock_budget_ms: 60_000,
      cost_budget_cents: 0,
      sub_dispatch_budget: 1,
    });
    const emptyResult = synthesizeMaestroPrompt(baseTask({ expected_artifacts: [] }), {
      wall_clock_budget_ms: 60_000,
      cost_budget_cents: 0,
      sub_dispatch_budget: 1,
    });

    expect(nullResult).toContain("EXPECTED ARTIFACTS:\n(none specified)");
    expect(emptyResult).toContain("EXPECTED ARTIFACTS:\n(none specified)");
  });

  test("formats numeric budgets", () => {
    const result = synthesizeMaestroPrompt(baseTask(), {
      wall_clock_budget_ms: 90_000,
      cost_budget_cents: 50,
      sub_dispatch_budget: 3,
    });

    expect(result).toContain("- Wall clock: 2 minutes from now");
    expect(result).toContain("- Cost: $0.50");
    expect(result).toContain("- Sub-dispatches: 3 chain_start calls");
  });

  test("formats cost edge cases", () => {
    const cases = [
      { cents: 0, dollars: "$0.00" },
      { cents: 1, dollars: "$0.01" },
      { cents: 99, dollars: "$0.99" },
      { cents: 100, dollars: "$1.00" },
      { cents: 12_345, dollars: "$123.45" },
    ];

    for (const c of cases) {
      const result = synthesizeMaestroPrompt(baseTask(), {
        wall_clock_budget_ms: 60_000,
        cost_budget_cents: c.cents,
        sub_dispatch_budget: 1,
      });

      expect(result).toContain(`- Cost: ${c.dollars}`);
    }
  });
});

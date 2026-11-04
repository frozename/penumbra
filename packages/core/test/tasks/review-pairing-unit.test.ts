import { describe, expect, test } from "bun:test";

import { mergeDeny, synthesizeReviewTask } from "@src/tasks/review-pairing.js";
import type { TaskPriority, TaskRecord } from "@src/tasks/schema.js";
import { FileTaskInputSchema } from "@src/tasks/schema.js";

function parentRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-parent-1",
    created_at: 1000,
    updated_at: 2000,
    created_by_kind: "human",
    created_by_id: "cli",
    project_id: null,
    parent_task_id: null,
    kind: "work",
    priority: "normal",
    prompt: "implement feature X",
    acceptance_criteria: "criterion A\ncriterion B",
    expected_artifacts: [{ type: "commit" }],
    eligibility: { min_tier: "standard" },
    review_eligibility: null,
    requires_review: true,
    status: "done_pending_review",
    result_summary: "implemented A and B",
    result_artifacts: [{ type: "commit", ref: "abc123" }],
    failure_reason: null,
    chain_id: null,
    origin: "task-board/v1",
    ...overrides,
  };
}

describe("mergeDeny", () => {
  test("returns the additional agent alone when existing is undefined", () => {
    expect(mergeDeny(undefined, "solo")).toEqual(["solo"]);
    expect(mergeDeny([], "solo")).toEqual(["solo"]);
  });

  test("sorts the merged set lexicographically", () => {
    expect(mergeDeny(["beta", "gamma"], "alpha")).toEqual(["alpha", "beta", "gamma"]);
  });

  test("dedupes when the additional agent is already present", () => {
    expect(mergeDeny(["a", "b"], "a")).toEqual(["a", "b"]);
  });

  test("sorts with the default comparator, uppercase before lowercase", () => {
    expect(mergeDeny(["b"], "A")).toEqual(["A", "b"]);
  });

  test("does not mutate the existing array", () => {
    const existing = ["b"];
    const merged = mergeDeny(existing, "a");
    expect(merged).toEqual(["a", "b"]);
    expect(existing).toEqual(["b"]);
  });
});

describe("synthesizeReviewTask", () => {
  test("renders the fixed review scaffold around the parent fields", () => {
    const input = synthesizeReviewTask(parentRecord(), "agent-doer");

    expect(input.kind).toBe("review");
    expect(input.parent_task_id).toBe("task-parent-1");
    expect(input.acceptance_criteria).toBe(
      "Each parent criterion is met or explicitly rejected with reason.",
    );
    expect(input.expected_artifacts).toEqual([{ type: "review_verdict" }]);
    expect(input.requires_review).toBe(false);
    expect(input.created_by_kind).toBe("agent");
    expect(input.created_by_id).toBe("system:review-pairing");

    expect(input.prompt.startsWith("Review task task-parent-1.\n\n")).toBe(true);
    expect(input.prompt).toContain(
      "**Original prompt:**\nimplement feature X\n\n**Acceptance criteria:**",
    );
    expect(input.prompt).toContain(
      "**Acceptance criteria:**\ncriterion A\ncriterion B\n\n**Reported result:**",
    );
    expect(input.prompt).toContain("**Reported result:**\nimplemented A and B\n\n**Artifacts:**");
    expect(input.prompt).toContain(
      `**Artifacts:**
[
  {
    "type": "commit",
    "ref": "abc123"
  }
]

Verify each criterion`,
    );
    expect(input.prompt).toContain(
      "Call `task.complete` with `review_verdict: { passed: true|false, notes }`.",
    );
    expect(input.prompt.endsWith("Do NOT modify the parent's artifacts.\n")).toBe(true);
  });

  test("returns a file input that validates against the strict file schema", () => {
    const input = synthesizeReviewTask(parentRecord(), "agent-doer");
    expect(() => FileTaskInputSchema.parse(input)).not.toThrow();
  });

  test("falls back to (none provided) for null acceptance criteria", () => {
    const input = synthesizeReviewTask(parentRecord({ acceptance_criteria: null }), "agent-doer");
    expect(input.prompt).toContain(
      "**Acceptance criteria:**\n(none provided)\n\n**Reported result:**",
    );
  });

  test("falls back to (no summary) for null result summary", () => {
    const input = synthesizeReviewTask(parentRecord({ result_summary: null }), "agent-doer");
    expect(input.prompt).toContain("**Reported result:**\n(no summary)\n\n**Artifacts:**");
  });

  test("falls back to an empty JSON array for null result artifacts", () => {
    const input = synthesizeReviewTask(parentRecord({ result_artifacts: null }), "agent-doer");
    expect(input.prompt).toContain("**Artifacts:**\n[]\n\nVerify each criterion");
  });

  test("synthesizes premium eligibility denying only the doer when parent has none", () => {
    const input = synthesizeReviewTask(parentRecord({ review_eligibility: null }), "agent-doer");
    expect(input.eligibility).toEqual({ min_tier: "premium", deny_agents: ["agent-doer"] });
  });

  test("preserves parent review eligibility fields while merging deny agents", () => {
    const input = synthesizeReviewTask(
      parentRecord({
        review_eligibility: {
          min_tier: "standard",
          required_tags: ["rust"],
          max_cost_cents: 50,
          deny_agents: ["z"],
        },
      }),
      "doer",
    );
    expect(input.eligibility).toEqual({
      min_tier: "standard",
      required_tags: ["rust"],
      max_cost_cents: 50,
      deny_agents: ["doer", "z"],
    });
  });

  test("merges parent deny agents, doer and additional agents deduped and sorted", () => {
    const input = synthesizeReviewTask(
      parentRecord({ review_eligibility: { min_tier: "standard", deny_agents: ["z", "doer"] } }),
      "doer",
      ["doer", "a"],
    );
    expect(input.eligibility?.deny_agents).toEqual(["a", "doer", "z"]);
  });

  test("bumps parent priority one bucket capped at urgent", () => {
    const cases: { parent: TaskPriority; child: TaskPriority }[] = [
      { parent: "low", child: "normal" },
      { parent: "normal", child: "high" },
      { parent: "high", child: "urgent" },
      { parent: "urgent", child: "urgent" },
    ];
    for (const c of cases) {
      const input = synthesizeReviewTask(parentRecord({ priority: c.parent }), "agent-doer");
      expect(input.priority).toBe(c.child);
    }
  });

  test("passes origin through and maps null origin to undefined", () => {
    const withOrigin = synthesizeReviewTask(parentRecord({ origin: "task-board/v1" }), "doer");
    expect(withOrigin.origin).toBe("task-board/v1");

    const withoutOrigin = synthesizeReviewTask(parentRecord({ origin: null }), "doer");
    expect(withoutOrigin.origin).toBeUndefined();
  });
});

import type { FileTaskInput, TaskPriority, TaskRecord } from "./schema.js";

export const REVIEW_PROMPT_TEMPLATE = `Review task {{parent_id}}.

**Original prompt:**
{{parent_prompt}}

**Acceptance criteria:**
{{acceptance_criteria}}

**Reported result:**
{{result_summary}}

**Artifacts:**
{{result_artifacts}}

Verify each criterion against the actual artifacts. Call \`task.complete\` with \`review_verdict: { passed: true|false, notes }\`. On failure, the parent task transitions to \`failed\` with your \`notes\` as the failure_reason. Do NOT modify the parent's artifacts.
`;

export function mergeDeny(existing: string[] | undefined, additional: string): string[] {
  return [...new Set([...(existing ?? []), additional])].sort();
}

function bumpPriority(priority: TaskPriority): TaskPriority {
  if (priority === "low") return "normal";
  if (priority === "normal") return "high";
  if (priority === "high") return "urgent";
  return "urgent";
}

export function synthesizeReviewTask(
  parent: TaskRecord,
  doer_agent_id: string,
  additional_deny_agents: string[] = [],
): FileTaskInput {
  const denyAgents = [
    ...(parent.review_eligibility?.deny_agents ?? []),
    doer_agent_id,
    ...additional_deny_agents,
  ];
  const eligibility = parent.review_eligibility
    ? {
        ...parent.review_eligibility,
        deny_agents: [...new Set(denyAgents)].sort(),
      }
    : {
        min_tier: "premium",
        deny_agents: [...new Set(denyAgents)].sort(),
      };

  const prompt = REVIEW_PROMPT_TEMPLATE.replace("{{parent_id}}", parent.id)
    .replace("{{parent_prompt}}", parent.prompt)
    .replace("{{acceptance_criteria}}", parent.acceptance_criteria ?? "(none provided)")
    .replace("{{result_summary}}", parent.result_summary ?? "(no summary)")
    .replace("{{result_artifacts}}", JSON.stringify(parent.result_artifacts ?? [], null, 2));

  return {
    kind: "review",
    parent_task_id: parent.id,
    prompt,
    acceptance_criteria: "Each parent criterion is met or explicitly rejected with reason.",
    expected_artifacts: [{ type: "review_verdict" }],
    eligibility,
    priority: bumpPriority(parent.priority),
    requires_review: false,
    // This board-generated producer is intentional and should not be subject to emit caps.
    created_by_kind: "agent",
    created_by_id: "system:review-pairing",
    origin: parent.origin ?? undefined,
  };
}

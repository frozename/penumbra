import { expect, test } from "bun:test";

import { HandoffRowSchema as CoreHandoffRowSchema } from "@src/schemas/handoff.js";

import { HandoffRowSchema as ApiHandoffRowSchema } from "../../../api-contract/src/handoffs.js";

test("api-contract and core handoff schemas parse isolated_install sqlite rows compatibly", () => {
  const row = {
    handoff_id: "h-compat",
    ts: "2026-06-12T00:00:00.000Z",
    project_id: null,
    conversation_id: "conv-compat",
    from_agent: "user",
    to_agent: "codex",
    to_role: null,
    message: "hello",
    status: "approved",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: 1,
    isolated_install: 1,
    open_pr_on_review: null,
    branch_base: null,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
  };

  expect(ApiHandoffRowSchema.parse(row).isolated_install).toBe(true);
  expect(CoreHandoffRowSchema.parse(row).isolated_install).toBe(true);
});

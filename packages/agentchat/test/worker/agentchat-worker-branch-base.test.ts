import { type HandoffRow } from "@penumbra/core";
import { expect, test } from "bun:test";

import { buildDispatchHandoffInput } from "@src/worker/dispatch-handoff-input.js";

const baseSource = {
  handoff_id: "h-source",
  ts: "2026-09-01T12:00:00.000Z",
  project_id: null,
  conversation_id: "conv-source",
  from_agent: "planner",
  to_agent: "executor",
  to_role: null,
  requested_agent: null,
  routing_resolution_reason: null,
  message: "source message",
  status: "dispatched",
  resolved_by: "worker",
  resolved_at: "2026-09-01T12:00:10.000Z",
  redirected_to: null,
  resolution_reason: null,
  triggered_by_event_id: "evt-source",
  chain_max_hops: null,
  chain_trust_mode: "all",
  chain_task_type: "implement_small",
  dispatch_kind: null,
  long_lived_agent_id: null,
  long_lived_tick_id: null,
  use_worktree: true,
  isolated_install: null,
  open_pr_on_review: null,
  branch_base: null,
  branch_name: null,
  error_message: null,
  cancel_requested_at: null,
  worker_id: "worker-a",
  parent_handoff_id: null,
  dispatch_attempts: 1,
  max_dispatch_attempts: 3,
  last_dispatch_started_at: "2026-09-01T12:00:05.000Z",
  workflow_run_id: null,
} satisfies HandoffRow;

const baseDispatched = {
  ...baseSource,
  handoff_id: "h-dispatched",
  conversation_id: "conv-dispatched",
  message: "rewritten message",
  branch_base: "main",
  branch_name: "feat/dispatched",
  chain_max_hops: 9,
  parent_handoff_id: "h-parent-from-dispatch",
} satisfies HandoffRow;

test("root mention inherits the materialized parent worktree branch", () => {
  const input = buildDispatchHandoffInput(
    { ...baseSource, branch_base: null, branch_name: null, chain_max_hops: 4 },
    { ...baseDispatched, branch_name: "feat/x_abc" },
  );

  expect(input).toMatchObject({
    handoff_id: "h-source",
    message: "rewritten message",
    branch_base: "feat/x_abc",
    chain_max_hops: 9,
  });
});

test("custom branch base is preserved when no materialized branch was recorded", () => {
  const input = buildDispatchHandoffInput(
    { ...baseSource, branch_base: "main", branch_name: null },
    { ...baseDispatched, branch_name: null },
  );

  expect(input.branch_base).toBe("main");
});

test("chained hop keeps source identity while using dispatched config", () => {
  const input = buildDispatchHandoffInput(
    {
      ...baseSource,
      handoff_id: "h-claimed",
      conversation_id: "conv-chain",
      branch_base: "feat/round-one",
      branch_name: "feat/claimed",
      chain_max_hops: 5,
      parent_handoff_id: "h-parent",
    },
    {
      ...baseDispatched,
      handoff_id: "h-rewritten",
      conversation_id: "conv-other",
      branch_base: "feat/rewrite-base",
      branch_name: "feat/rewrite-branch",
      chain_max_hops: 7,
      parent_handoff_id: "h-parent-from-rewrite",
    },
  );

  expect(input).toMatchObject({
    handoff_id: "h-claimed",
    conversation_id: "conv-other",
    branch_base: "feat/rewrite-branch",
    branch_name: "feat/rewrite-branch",
    chain_max_hops: 7,
    parent_handoff_id: "h-parent-from-rewrite",
  });
});

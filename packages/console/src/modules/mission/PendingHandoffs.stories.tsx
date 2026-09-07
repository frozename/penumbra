import type { HandoffRow } from "@penumbra/api-contract";
import type { Meta, StoryObj } from "@storybook/react";

import { handoffsPending } from "@src/lib/query-keys";

import { PendingHandoffs } from "./PendingHandoffs";

const meta: Meta<typeof PendingHandoffs> = {
  title: "Mission/PendingHandoffs",
  component: PendingHandoffs,
};

export default meta;
type Story = StoryObj;

function makeHandoff(id: string, overrides: Partial<HandoffRow> = {}): HandoffRow {
  return {
    handoff_id: `h-${id}`,
    ts: "2026-05-09T05:00:00.000Z",
    project_id: null,
    conversation_id: `c-${id}`,
    from_agent: "claude",
    to_agent: "codex",
    to_role: null,
    message: `Investigate mission panel issue ${id}`,
    status: "pending",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: "investigation",
    use_worktree: true,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
    ...overrides,
  };
}

export const Empty: Story = {
  render: () => <PendingHandoffs />,
  parameters: {
    queryCache: [{ key: handoffsPending(), data: { handoffs: [] } }],
  },
};

export const TwoRows: Story = {
  render: () => <PendingHandoffs />,
  parameters: {
    queryCache: [
      {
        key: handoffsPending(),
        data: {
          handoffs: [
            makeHandoff("1", {
              to_agent: "gemini",
              use_worktree: false,
              chain_task_type: "triage",
            }),
            makeHandoff("2", { to_agent: "codex", to_role: "reviewer", use_worktree: true }),
          ],
        },
      },
    ],
  },
};

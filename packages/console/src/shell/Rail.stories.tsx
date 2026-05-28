import type { HandoffRow } from "@penumbra/api-contract";
import type { Meta, StoryObj } from "@storybook/react";
import { handoffsPending } from "../lib/query-keys";
import { Rail } from "./Rail";

const meta: Meta<typeof Rail> = {
  title: "Shell/Rail",
  component: Rail,
};

export default meta;
type Story = StoryObj<typeof meta>;

function makeHandoff(id: string): HandoffRow {
  return {
    handoff_id: `h-${id}`,
    ts: "2026-05-09T05:00:00.000Z",
    project_id: null,
    conversation_id: `c-${id}`,
    from_agent: "claude",
    to_agent: "codex",
    to_role: null,
    message: `handoff ${id}`,
    status: "pending",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: true,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
  };
}

export const NoBadge: Story = {
  parameters: {
    queryCache: [{ key: handoffsPending(), data: { handoffs: [] } }],
    initialRoute: "/mission",
  },
};

export const WithBadge3: Story = {
  parameters: {
    queryCache: [
      {
        key: handoffsPending(),
        data: { handoffs: [makeHandoff("1"), makeHandoff("2"), makeHandoff("3")] },
      },
    ],
    initialRoute: "/mission",
  },
};

import type { ChainSummary } from "@penumbra/api-contract";
import type { Meta, StoryObj } from "@storybook/react";
import { chainsByStatus } from "../../lib/query-keys";
import { RecentResolved } from "./RecentResolved";

const meta: Meta<typeof RecentResolved> = {
  title: "Mission/RecentResolved",
  component: RecentResolved,
};

export default meta;
type Story = StoryObj<typeof meta>;

function makeChain(overrides: Partial<ChainSummary> = {}): ChainSummary {
  return {
    conversation_id: "c-1",
    project_id: null,
    latest_status: "completed",
    latest_ts: "2026-05-09T05:00:00Z",
    earliest_ts: "2026-05-09T04:00:00Z",
    handoff_count: 3,
    root_handoff_id: "h-aabbccdd",
    to_agent: "codex-acp-deep",
    to_role: null,
    worktree_path: null,
    worktree_root: null,
    ...overrides,
  };
}

export const Empty: Story = {
  parameters: {
    queryCache: [{ key: chainsByStatus("completed", { limit: 4 }), data: { chains: [] } }],
  },
};

export const TwoChains: Story = {
  parameters: {
    queryCache: [
      {
        key: chainsByStatus("completed", { limit: 4 }),
        data: {
          chains: [
            makeChain({ latest_status: "completed", root_handoff_id: "h-11223344" }),
            makeChain({
              conversation_id: "c-2",
              latest_status: "failed",
              root_handoff_id: "h-55667788",
              handoff_count: 5,
            }),
          ],
        },
      },
    ],
  },
};

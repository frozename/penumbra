import type { Meta, StoryObj } from "@storybook/react";

import { handoffsByStatus } from "@src/lib/query-keys";

import { makeHandoffRow } from "./fixtures";
import { HandoffList } from "./HandoffList";

const meta: Meta<typeof HandoffList> = {
  component: HandoffList,
  title: "Handoffs/HandoffList",
};

export default meta;

type Story = StoryObj;

const NOW = 1_756_200_000_000;

export const Empty: Story = {
  parameters: {
    queryCache: [{ key: handoffsByStatus("pending"), data: [] }],
    initialRoute: "/handoffs",
  },
};

export const PendingHandoffs: Story = {
  parameters: {
    queryCache: [
      {
        key: handoffsByStatus("pending"),
        data: [
          makeHandoffRow({
            handoff_id: "h-story1",
            message: "fix the flaky test",
            status: "pending",
            from_agent: "claude",
            to_agent: "codex",
            ts: new Date(NOW).toISOString(),
          }),
          makeHandoffRow({
            handoff_id: "h-story2",
            message: "review the PR",
            status: "pending",
            from_agent: "codex",
            to_agent: "gemini",
            ts: new Date(NOW + 300_000).toISOString(),
          }),
        ],
      },
    ],
    initialRoute: "/handoffs",
  },
};

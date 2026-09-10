import type { Meta, StoryObj } from "@storybook/react";

import { makeReliabilityReport } from "./fixtures";
import { ReliabilityChip } from "./ReliabilityChip";

const meta: Meta<typeof ReliabilityChip> = {
  component: ReliabilityChip,
  title: "Handoffs/ReliabilityChip",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Complete: Story = {
  args: {
    report: makeReliabilityReport({ status: "complete", recommended_action: "accept" }),
  },
};

export const Stale: Story = {
  args: {
    report: makeReliabilityReport({
      status: "non_terminal_stale",
      recommended_action: "wait",
      summary: "agent has been idle",
    }),
  },
};

export const Cancel: Story = {
  args: {
    report: makeReliabilityReport({
      status: "cancel_completed",
      recommended_action: "accept",
    }),
  },
};

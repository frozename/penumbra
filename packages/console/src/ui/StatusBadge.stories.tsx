import type { Meta, StoryObj } from "@storybook/react";

import { StatusBadge } from "./StatusBadge";

const meta: Meta<typeof StatusBadge> = {
  title: "UI/StatusBadge",
  component: StatusBadge,
  tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof meta>;

export const InProgress: Story = { args: { status: "in-progress" } };
export const Claimed: Story = { args: { status: "claimed" } };
export const Completed: Story = { args: { status: "completed" } };
export const Failed: Story = { args: { status: "failed" } };
export const Rejected: Story = { args: { status: "rejected" } };
export const Filed: Story = { args: { status: "filed" } };
export const Ok: Story = { args: { status: "ok" } };
export const Concerns: Story = { args: { status: "concerns" } };

export const MonoLabelOverride: Story = {
  args: { status: "completed", monoLabel: "all green" },
};

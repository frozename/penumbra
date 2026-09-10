import type { Meta, StoryObj } from "@storybook/react";

import { type TabItem, Tabs } from "./Tabs";

const meta: Meta<typeof Tabs> = {
  component: Tabs,
  title: "UI/Tabs",
};

export default meta;

type Story = StoryObj<typeof meta>;

const items: readonly TabItem[] = [
  { id: "pending", label: "Pending" },
  { id: "dispatched", label: "Dispatched" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
];

export const PendingActive: Story = {
  args: { items, activeId: "pending", onSelect: () => {} },
};

export const DispatchedActive: Story = {
  args: { items, activeId: "dispatched", onSelect: () => {} },
};

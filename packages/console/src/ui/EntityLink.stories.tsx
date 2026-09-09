import type { Meta, StoryObj } from "@storybook/react";

import type { ModuleSpec } from "@src/modules/manifest";

import { EntityLink } from "./EntityLink";

const meta: Meta<typeof EntityLink> = {
  component: EntityLink,
  tags: ["autodocs"],
  title: "UI/EntityLink",
};

export default meta;

type Story = StoryObj<typeof meta>;

const handoffsModule = {
  available: true,
  icon: "h",
  id: "handoffs",
  label: "Handoffs",
  path: "/handoffs",
} as const satisfies ModuleSpec;

const chainsModule = {
  available: true,
  icon: "≋",
  id: "chains",
  label: "Chains",
  path: "/chains",
} as const satisfies ModuleSpec;

export const HandoffLink: Story = {
  args: { id: "h-1", kind: "handoff", modules: [handoffsModule] },
};

export const TaskCopy: Story = {
  args: { id: "t-1", kind: "task" },
};

export const ConversationLink: Story = {
  args: { id: "c-1", kind: "conversation", modules: [chainsModule] },
};

export const LaneCopy: Story = {
  args: { id: "l-1", kind: "lane" },
};

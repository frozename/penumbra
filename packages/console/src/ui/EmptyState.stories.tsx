import type { Meta, StoryObj } from "@storybook/react";

import { EmptyState } from "./EmptyState";

const meta: Meta<typeof EmptyState> = {
  title: "UI/EmptyState",
  component: EmptyState,
  tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { title: "registrar disabled", body: "PENUMBRA_REGISTRAR=0" },
};

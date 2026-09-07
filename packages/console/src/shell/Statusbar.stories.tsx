import type { Meta, StoryObj } from "@storybook/react";

import { Statusbar } from "./Statusbar";

const meta: Meta<typeof Statusbar> = {
  title: "Shell/Statusbar",
  component: Statusbar,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Healthy: Story = {
  parameters: {
    daemonStore: { health: "ok" },
  },
};

export const Unknown: Story = {
  parameters: {
    daemonStore: { health: "unknown" },
  },
};

export const Down: Story = {
  parameters: {
    daemonStore: { health: "down" },
  },
};

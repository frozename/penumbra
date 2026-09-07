import type { Meta, StoryObj } from "@storybook/react";

import { SessionInvalidBanner } from "./SessionInvalidBanner";

const meta: Meta<typeof SessionInvalidBanner> = {
  title: "Shell/SessionInvalidBanner",
  component: SessionInvalidBanner,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Visible: Story = {
  parameters: {
    daemonStore: { sessionInvalid: true },
  },
};

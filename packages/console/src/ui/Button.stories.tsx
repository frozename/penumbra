import type { Meta, StoryObj } from "@storybook/react";

import { Button } from "./Button";

const meta: Meta<typeof Button> = {
  title: "UI/Button",
  component: Button,
  tags: ["autodocs"],
  args: { children: "click me" },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: "primary", children: "primary" } };
export const Secondary: Story = { args: { variant: "secondary", children: "secondary" } };
export const Ghost: Story = { args: { variant: "ghost", children: "ghost" } };
export const Danger: Story = { args: { variant: "danger", children: "danger" } };
export const Ok: Story = { args: { variant: "ok", children: "ok" } };
export const Disabled: Story = {
  args: { variant: "primary", children: "disabled", disabled: true },
};

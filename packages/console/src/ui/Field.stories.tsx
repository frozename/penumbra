import type { Meta, StoryObj } from "@storybook/react";

import { Field } from "./Field";

const meta: Meta<typeof Field> = {
  title: "UI/Field",
  component: Field,
  tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof meta>;

const inputStyle = {
  height: 32,
  padding: "0 10px",
  borderRadius: 6,
  background: "var(--color-surface-0)",
  border: "1px solid var(--color-border)",
  color: "var(--color-text)",
};

export const Default: Story = {
  render: () => (
    <Field label="Name" htmlFor="story-name">
      <input style={inputStyle} />
    </Field>
  ),
};

export const WithError: Story = {
  render: () => (
    <Field label="Name" htmlFor="story-name" error="Required">
      <input style={inputStyle} />
    </Field>
  ),
};

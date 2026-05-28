import type { Meta, StoryObj } from "@storybook/react";
import { PressureOrb, providerLabel } from "./PressureOrb";

const meta: Meta<typeof PressureOrb> = {
  title: "UI/PressureOrb",
  component: PressureOrb,
  tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof meta>;

const baseThresholds = {
  warn_pct: 0.8,
  refuse_pct: 0.95,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  window_label: "5h",
};

export const Ok: Story = {
  args: { p: { ...baseThresholds, used_pct: 0.5 } },
};

export const Warn: Story = {
  args: { p: { ...baseThresholds, used_pct: 0.85 } },
};

export const Crit: Story = {
  args: { p: { ...baseThresholds, used_pct: 0.97 } },
};

export const OpenCodeProvider: Story = {
  args: {
    p: {
      ...baseThresholds,
      used_pct: 0.3,
      provider: "opencode-go",
      model: "deepseek-v4-pro",
    },
  },
  render: (args) => {
    const p = args.p;
    const label = providerLabel(p.provider);
    return (
      <div>
        <PressureOrb p={p} />
        <div style={{ marginTop: 8, fontSize: 12, fontFamily: "monospace" }}>
          providerLabel('opencode-go') = {JSON.stringify(label)}
        </div>
      </div>
    );
  },
};

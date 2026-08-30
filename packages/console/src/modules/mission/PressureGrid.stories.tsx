import type { Meta, StoryObj } from "@storybook/react";
import { usageSubscriptionPressure } from "@src/lib/query-keys";
import { PressureGrid } from "./PressureGrid";

const meta: Meta<typeof PressureGrid> = {
  title: "Mission/PressureGrid",
  component: PressureGrid,
};

export default meta;
type Story = StoryObj<typeof meta>;

const makeWindow = (usedPct: number, windowLabel: string) => ({
  used_pct: usedPct,
  warn_pct: 0.8,
  refuse_pct: 0.95,
  provider: "anthropic",
  model: "sonnet",
  window_label: windowLabel,
});

export const Empty: Story = {
  parameters: {
    queryCache: [{ key: usageSubscriptionPressure(), data: { windows: [] } }],
  },
};

export const ThreeWindows: Story = {
  parameters: {
    queryCache: [
      {
        key: usageSubscriptionPressure(),
        data: {
          windows: [makeWindow(0.5, "5h"), makeWindow(0.85, "24h"), makeWindow(0.97, "7d")],
        },
      },
    ],
  },
};

export const EightWindows: Story = {
  parameters: {
    queryCache: [
      {
        key: usageSubscriptionPressure(),
        data: {
          windows: Array.from({ length: 8 }, (_, i) =>
            makeWindow(Math.min(0.99, 0.1 + i * 0.1), `${i + 1}h`),
          ),
        },
      },
    ],
  },
};

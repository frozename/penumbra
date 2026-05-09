import type { Meta, StoryObj } from '@storybook/react';
import { usageSubscriptionPressure } from '../lib/query-keys';
import { Titlebar } from './Titlebar';

const meta: Meta<typeof Titlebar> = {
  title: 'Shell/Titlebar',
  component: Titlebar,
};

export default meta;
type Story = StoryObj<typeof meta>;

const pressureBase = {
  warn_pct: 0.8,
  refuse_pct: 0.95,
  provider: 'anthropic',
  model: 'sonnet',
  window_label: '5h',
};

export const Default: Story = {
  parameters: {
    queryCache: [{ key: usageSubscriptionPressure(), data: { windows: [{ ...pressureBase, used_pct: 0.4 }] } }],
  },
};

export const PressureWarn: Story = {
  parameters: {
    queryCache: [{ key: usageSubscriptionPressure(), data: { windows: [{ ...pressureBase, used_pct: 0.85 }] } }],
  },
};

export const PressureCrit: Story = {
  parameters: {
    queryCache: [{ key: usageSubscriptionPressure(), data: { windows: [{ ...pressureBase, used_pct: 0.97 }] } }],
  },
};

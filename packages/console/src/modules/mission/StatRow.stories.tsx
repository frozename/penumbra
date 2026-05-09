import type { Meta, StoryObj } from '@storybook/react';
import { usageQuotaStatus } from '../../lib/query-keys';
import { StatRow } from './StatRow';

const meta: Meta<typeof StatRow> = {
  title: 'Mission/StatRow',
  component: StatRow,
};

export default meta;
type Story = StoryObj;

export const Empty: Story = {
  render: () => <StatRow />,
  parameters: {
    queryCache: [
      {
        key: usageQuotaStatus(),
        data: { dispatched_count: 0, cap: 6, subscription: { synth_total: 0 } },
      },
    ],
  },
};

export const Loaded: Story = {
  render: () => <StatRow />,
  parameters: {
    queryCache: [
      {
        key: usageQuotaStatus(),
        data: { dispatched_count: 4, cap: 6, subscription: { synth_total: 12.34 } },
      },
    ],
  },
};

export const Pressured: Story = {
  render: () => <StatRow />,
  parameters: {
    queryCache: [
      {
        key: usageQuotaStatus(),
        data: { dispatched_count: 6, cap: 6, subscription: { synth_total: 47.9 } },
      },
    ],
  },
};

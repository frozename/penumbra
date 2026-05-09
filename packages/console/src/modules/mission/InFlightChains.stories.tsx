import type { ChainSummary } from '@penumbra/api-contract';
import type { Meta, StoryObj } from '@storybook/react';
import { chainsByStatus } from '../../lib/query-keys';
import { InFlightChains } from './InFlightChains';

const meta: Meta<typeof InFlightChains> = {
  title: 'Mission/InFlightChains',
  component: InFlightChains,
};

export default meta;
type Story = StoryObj<typeof meta>;

function makeChain(overrides: Partial<ChainSummary> = {}): ChainSummary {
  return {
    conversation_id: 'c-1',
    project_id: null,
    latest_status: 'dispatched',
    latest_ts: '2026-05-09T05:00:00Z',
    earliest_ts: '2026-05-09T04:00:00Z',
    handoff_count: 3,
    root_handoff_id: 'h-aabbccdd',
    to_agent: 'codex-acp-deep',
    to_role: null,
    worktree_path: null,
    worktree_root: null,
    ...overrides,
  };
}

export const Empty: Story = {
  parameters: {
    queryCache: [{ key: chainsByStatus('dispatched'), data: { chains: [] } }],
  },
};

export const TwoChains: Story = {
  parameters: {
    queryCache: [
      {
        key: chainsByStatus('dispatched'),
        data: {
          chains: [
            makeChain(),
            makeChain({
              conversation_id: 'c-2',
              root_handoff_id: 'h-eeff0011',
              handoff_count: 5,
              to_agent: 'gemini-3.1-pro',
              worktree_path: '/tmp/wt-2',
            }),
          ],
        },
      },
    ],
  },
};

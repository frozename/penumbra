import type { Meta, StoryObj } from '@storybook/react';
import { EventTypeChip } from './EventTypeChip';

const meta: Meta<typeof EventTypeChip> = {
  title: 'UI/EventTypeChip',
  component: EventTypeChip,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<typeof meta>;

export const AgentPrompt:           Story = { args: { type: 'agent-prompt' } };
export const AgentResponse:         Story = { args: { type: 'agent-response' } };
export const AgentToolUse:          Story = { args: { type: 'agent-tool-use' } };
export const AgentThought:          Story = { args: { type: 'agent-thought' } };
export const AgentHandoff:          Story = { args: { type: 'agent-handoff' } };
export const UserPrompt:            Story = { args: { type: 'user-prompt' } };
export const UsageUpdate:           Story = { args: { type: 'usage-update' } };
export const RateLimitSnapshot:     Story = { args: { type: 'rate-limit-snapshot' } };
export const SubscriptionCapTrip:   Story = { args: { type: 'subscription-pressure-cap-trip' } };
export const WorkflowOutcome:       Story = { args: { type: 'workflow.outcome' } };
export const OrchestrateFiled:      Story = { args: { type: 'orchestrate_filed' } };
export const Claim:                 Story = { args: { type: 'claim' } };
export const Watchdog:              Story = { args: { type: 'watchdog' } };
export const Unknown:               Story = { args: { type: 'something-not-in-map' } };

import type { Meta, StoryObj } from "@storybook/react";

import { makeStoryPhases } from "./fixtures";
import { PhaseTimeline } from "./PhaseTimeline";

const meta: Meta<typeof PhaseTimeline> = {
  title: "Registrar/PhaseTimeline",
  component: PhaseTimeline,
};

export default meta;
type Story = StoryObj;

export const Mixed: Story = {
  render: () => (
    <PhaseTimeline
      phases={makeStoryPhases("reg-story-1", ["complete", "active", "blocked", "pending"])}
    />
  ),
};

export const AllPhasesComplete: Story = {
  render: () => (
    <PhaseTimeline phases={makeStoryPhases("reg-story-1", ["complete", "complete", "complete"])} />
  ),
};

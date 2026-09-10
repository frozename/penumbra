import type { Meta, StoryObj } from "@storybook/react";

import { DispatchTimeline } from "./DispatchTimeline";
import { makeDispatchEvent } from "./fixtures";

const meta: Meta<typeof DispatchTimeline> = {
  component: DispatchTimeline,
  title: "Handoffs/DispatchTimeline",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const ThreeEvents: Story = {
  args: {
    events: [
      makeDispatchEvent({ kind: "dispatch.start", ts: "2026-09-07T10:00:00.000Z" }),
      makeDispatchEvent({ kind: "agent.heartbeat", ts: "2026-09-07T10:05:00.000Z" }),
      makeDispatchEvent({ kind: "dispatch.end", ts: "2026-09-07T10:10:00.000Z" }),
    ],
  },
};

export const Empty: Story = {
  args: { events: [] },
};

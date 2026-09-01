import type { Meta, StoryObj } from "@storybook/react";
import type { DaemonClient } from "@src/api/client";
import { sessionEvents } from "@src/lib/query-keys";
import { SessionTimeline } from "./SessionTimeline";
import { makeStoryChain, makeStoryEvent, parsedStoryEvents } from "./fixtures";

const NOW = Date.parse("2026-09-01T18:00:00.000Z");

const meta: Meta<typeof SessionTimeline> = {
  title: "Sessions/SessionTimeline",
  component: SessionTimeline,
};

export default meta;
type Story = StoryObj;

export const Populated: Story = {
  render: () => <SessionTimeline now={() => NOW} />,
  parameters: {
    queryCache: [{ key: sessionEvents(), data: { events: parsedStoryEvents(makeStoryChain()) } }],
  },
};

export const Empty: Story = {
  render: () => <SessionTimeline now={() => NOW} />,
  parameters: {
    queryCache: [{ key: sessionEvents(), data: { events: [] } }],
  },
};

export const ErrorState: Story = {
  render: () => <SessionTimeline client={errorClient()} now={() => NOW} />,
};

export const Stale: Story = {
  render: () => <SessionTimeline now={() => NOW} />,
  parameters: {
    queryCache: [
      {
        key: sessionEvents(),
        data: {
          events: parsedStoryEvents([
            makeStoryEvent({
              id: 10,
              kind: "continuity.skeleton_generated",
              ts: "2026-09-01T09:00:00.000Z",
            }),
          ]),
        },
      },
    ],
  },
};

export const MalformedRow: Story = {
  render: () => <SessionTimeline now={() => NOW} />,
  parameters: {
    queryCache: [
      {
        key: sessionEvents(),
        data: {
          events: [
            ...parsedStoryEvents(makeStoryChain()),
            {
              ok: false,
              raw: { kind: "continuity.future_kind", ts: "2026-09-01T10:50:00.000Z" },
              reason: "Invalid enum value",
            },
          ],
        },
      },
    ],
  },
};

function errorClient(): DaemonClient {
  return {
    listSessionEvents: async () => {
      throw new Error("daemon offline");
    },
  } as unknown as DaemonClient;
}

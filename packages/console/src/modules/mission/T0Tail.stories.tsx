import type { Meta, StoryObj } from "@storybook/react";

import type { StreamMessage, StreamTopic, Subscription } from "@src/api/streams";

import { T0Tail } from "./T0Tail";

type SubscribeImpl = <T>(
  topic: StreamTopic,
  onMessage: (msg: StreamMessage<T>) => void,
  opts?: { params?: Record<string, string> },
) => Subscription;

const inertSubscribe: SubscribeImpl = (_topic, _onMessage, _opts) => ({
  tail: () => [],
  unsubscribe: () => {},
});

const meta: Meta<typeof T0Tail> = {
  title: "Mission/T0Tail",
  component: T0Tail,
};

export default meta;
type Story = StoryObj;

export const Empty: Story = {
  render: () => <T0Tail subscribeImpl={inertSubscribe} />,
  parameters: {
    missionStore: { pausedTail: false, tailFilter: null },
  },
};

export const Paused: Story = {
  render: () => <T0Tail subscribeImpl={inertSubscribe} />,
  parameters: {
    missionStore: { pausedTail: true, tailFilter: null },
  },
};

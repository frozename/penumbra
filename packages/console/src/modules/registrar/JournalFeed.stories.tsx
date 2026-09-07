import type { Meta, StoryObj } from "@storybook/react";

import { makeStoryEvents } from "./fixtures";
import { JournalFeed } from "./JournalFeed";

const meta: Meta<typeof JournalFeed> = {
  title: "Registrar/JournalFeed",
  component: JournalFeed,
};

export default meta;
type Story = StoryObj;

export const EmptyJournal: Story = {
  render: () => <JournalFeed events={[]} />,
};

export const OneOpenBlocker: Story = {
  render: () => <JournalFeed events={makeStoryEvents("reg-story-1")} />,
};

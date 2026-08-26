import type { Meta, StoryObj } from "@storybook/react";
import { JournalFeed } from "./JournalFeed";
import { makeStoryEvents } from "./fixtures";

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

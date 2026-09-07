import type { Meta, StoryObj } from "@storybook/react";

import { sessionNoteDrafts } from "@src/lib/query-keys";

import { makeStoryDraft } from "./fixtures";
import { PendingDraft } from "./PendingDraft";

const NOW = Date.parse("2026-09-01T13:35:00.000Z");

const meta: Meta<typeof PendingDraft> = {
  title: "Sessions/PendingDraft",
  component: PendingDraft,
};

export default meta;
type Story = StoryObj;

export const Awaiting: Story = {
  render: () => <PendingDraft now={() => NOW} />,
  parameters: {
    queryCache: [{ key: sessionNoteDrafts(), data: { drafts: [makeStoryDraft()] } }],
  },
};

export const Empty: Story = {
  render: () => <PendingDraft now={() => NOW} />,
  parameters: {
    queryCache: [{ key: sessionNoteDrafts(), data: { drafts: [] } }],
  },
};

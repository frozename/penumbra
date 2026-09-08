import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";

import { sessionNoteDrafts } from "@src/lib/query-keys";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

import { makeStoryDraft } from "./fixtures";
import { PendingDraft } from "./PendingDraft";

const NOW = Date.parse("2026-09-01T13:35:00.000Z");

const meta: Meta<typeof PendingDraft> = {
  title: "Sessions/PendingDraft",
  component: PendingDraft,
};

export default meta;
type Story = StoryObj;

function Wrapper({ children }: { children: ReactNode }): ReactNode {
  return (
    <ToastProvider>
      <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
    </ToastProvider>
  );
}

export const Awaiting: Story = {
  render: () => (
    <Wrapper>
      <PendingDraft now={() => NOW} />
    </Wrapper>
  ),
  parameters: {
    queryCache: [{ key: sessionNoteDrafts(), data: { drafts: [makeStoryDraft()] } }],
  },
};

export const Empty: Story = {
  render: () => (
    <Wrapper>
      <PendingDraft now={() => NOW} />
    </Wrapper>
  ),
  parameters: {
    queryCache: [{ key: sessionNoteDrafts(), data: { drafts: [] } }],
  },
};

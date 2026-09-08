import type { Meta, StoryObj } from "@storybook/react";

import { approvalsDrafts, approvalsHandoffs, approvalsPermissions } from "@src/lib/query-keys";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

import { ApprovalsInbox } from "./ApprovalsInbox";

const meta: Meta<typeof ApprovalsInbox> = {
  title: "Approvals/ApprovalsInbox",
  component: ApprovalsInbox,
};

export default meta;
type Story = StoryObj;

const NOW = 1_756_200_000_000;

export const Empty: Story = {
  render: () => (
    <ToastProvider>
      <ConfirmDialogProvider>
        <ApprovalsInbox />
      </ConfirmDialogProvider>
    </ToastProvider>
  ),
  parameters: {
    queryCache: [
      { key: approvalsHandoffs(), data: [] },
      { key: approvalsPermissions(), data: [] },
      { key: approvalsDrafts(), data: [] },
    ],
    initialRoute: "/approvals",
  },
};

export const ThreeQueues: Story = {
  render: () => (
    <ToastProvider>
      <ConfirmDialogProvider>
        <ApprovalsInbox />
      </ConfirmDialogProvider>
    </ToastProvider>
  ),
  parameters: {
    queryCache: [
      {
        key: approvalsHandoffs(),
        data: [
          {
            id: "h-1",
            ts: new Date(NOW).toISOString(),
            title: "story handoff",
            subtitle: "claude → codex",
          },
        ],
      },
      {
        key: approvalsPermissions(),
        data: [
          {
            id: "p-1",
            ts: new Date(NOW + 300_000).toISOString(),
            title: "shell.run",
            subtitle: "claude",
          },
        ],
      },
      {
        key: approvalsDrafts(),
        data: [
          {
            id: "d-1",
            ts: new Date(NOW + 600_000).toISOString(),
            title: "2026-09-01-am",
            subtitle: "/notes/draft.md",
          },
        ],
      },
    ],
    initialRoute: "/approvals",
  },
};

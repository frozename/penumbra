import type { Meta, StoryObj } from "@storybook/react";

import { dispatchAudit } from "@src/lib/query-keys";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

import { makeDispatchAuditResponse } from "./fixtures";
import { LandPanel } from "./LandPanel";
import { useHandoffStoryClient } from "./story-client";

const meta: Meta<typeof LandPanel> = {
  title: "Handoffs/LandPanel",
  component: LandPanel,
};

export default meta;
type Story = StoryObj;

function PanelStory({ handoffId }: { handoffId: string }): JSX.Element {
  const client = useHandoffStoryClient();
  return <LandPanel handoffId={handoffId} client={client} />;
}

export const AcceptEnabled: Story = {
  render: () => (
    <ToastProvider>
      <ConfirmDialogProvider>
        <PanelStory handoffId="h-abc12345" />
      </ConfirmDialogProvider>
    </ToastProvider>
  ),
  parameters: {
    queryCache: [
      {
        key: dispatchAudit("h-abc12345"),
        data: makeDispatchAuditResponse({
          status: "complete",
          recommended_action: "accept",
          summary: "all events present",
        }),
      },
    ],
  },
};

export const NonAuditDisabled: Story = {
  render: () => (
    <ToastProvider>
      <ConfirmDialogProvider>
        <PanelStory handoffId="h-stale1234" />
      </ConfirmDialogProvider>
    </ToastProvider>
  ),
  parameters: {
    queryCache: [
      {
        key: dispatchAudit("h-stale1234"),
        data: makeDispatchAuditResponse({
          handoff_id: "h-stale1234",
          status: "non_terminal_stale",
          recommended_action: "wait",
          summary: "agent has been idle for 45 minutes",
        }),
      },
    ],
  },
};

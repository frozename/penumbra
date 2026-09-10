import type { Meta, StoryObj } from "@storybook/react";

import { useEffect } from "react";

import { lanesRecent } from "@src/lib/query-keys";
import { useUIStore } from "@src/stores/ui-store";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

import { makeLaneRow } from "./fixtures";
import { LanesTab } from "./LanesTab";
import { useHandoffStoryClient } from "./story-client";
const meta: Meta<typeof LanesTab> = { title: "Handoffs/LanesTab", component: LanesTab };
export default meta;
function StoryPanel(): JSX.Element {
  const client = useHandoffStoryClient();
  useEffect(() => {
    useUIStore.getState().setActiveModule("handoffs");
  }, []);
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <LanesTab client={client} />
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}
export const Recent: StoryObj = {
  render: () => <StoryPanel />,
  parameters: {
    queryCache: [
      {
        key: lanesRecent(),
        data: {
          lanes: [
            makeLaneRow(),
            makeLaneRow({
              lane_id: "lane-reviewed",
              gate_status: "passed",
              reviewer_handoff: "h-reviewer-full-id",
              ts_closed: "2026-09-10T11:00:00Z",
            }),
          ],
        },
      },
    ],
  },
};
export const Empty: StoryObj = {
  render: () => <StoryPanel />,
  parameters: { queryCache: [{ key: lanesRecent(), data: { lanes: [] } }] },
};

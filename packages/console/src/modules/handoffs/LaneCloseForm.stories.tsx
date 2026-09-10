import type { Meta, StoryObj } from "@storybook/react";

import { useState } from "react";

import { lanesRecent } from "@src/lib/query-keys";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

import { makeLaneRow } from "./fixtures";
import { LaneCloseForm } from "./LaneCloseForm";
import { useHandoffStoryClient } from "./story-client";
const meta: Meta<typeof LaneCloseForm> = {
  title: "Handoffs/LaneCloseForm",
  component: LaneCloseForm,
};
export default meta;
function StoryForm(): JSX.Element {
  const client = useHandoffStoryClient();
  const [closed, setClosed] = useState(false);
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        {closed ? (
          <p>Lane closed.</p>
        ) : (
          <LaneCloseForm
            lane={makeLaneRow()}
            client={client}
            onDone={() => {
              setClosed(true);
            }}
          />
        )}
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}
export const Open: StoryObj = {
  render: () => <StoryForm />,
  parameters: { queryCache: [{ key: lanesRecent(), data: { lanes: [makeLaneRow()] } }] },
};

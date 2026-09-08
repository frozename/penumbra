import type { Meta, StoryObj } from "@storybook/react";

import { Route, Routes } from "react-router-dom";

import { registrarDetail, registrarEvents } from "@src/lib/query-keys";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

import { makeStoryDetail } from "./fixtures";
import { RegistrarDetail } from "./RegistrarDetail";

const meta: Meta<typeof RegistrarDetail> = {
  title: "Registrar/RegistrarDetail",
  component: RegistrarDetail,
};

export default meta;
type Story = StoryObj;

function renderDetail(): JSX.Element {
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <Routes>
          <Route path="/registrar/:registrarId" element={<RegistrarDetail />} />
        </Routes>
      </ConfirmDialogProvider>
    </ToastProvider>
  );
}

export const EmptyJournal: Story = {
  render: renderDetail,
  parameters: {
    initialRoute: "/registrar/reg-story-1",
    queryCache: [
      {
        key: registrarDetail("reg-story-1"),
        data: makeStoryDetail({ events: [] }),
      },
      {
        key: registrarEvents("reg-story-1"),
        data: { events: [] },
      },
    ],
  },
};

export const OneOpenBlocker: Story = {
  render: renderDetail,
  parameters: {
    initialRoute: "/registrar/reg-story-1",
    queryCache: [
      {
        key: registrarDetail("reg-story-1"),
        data: makeStoryDetail({ rollup: { open_blockers: 1, open_follow_ups: 1 } }),
      },
      {
        key: registrarEvents("reg-story-1"),
        data: { events: makeStoryDetail({}).events },
      },
    ],
  },
};

export const AllPhasesComplete: Story = {
  render: renderDetail,
  parameters: {
    initialRoute: "/registrar/reg-story-2",
    queryCache: [
      {
        key: registrarDetail("reg-story-2"),
        data: makeStoryDetail({
          entry: { registrar_id: "reg-story-2", status: "complete" },
          phaseStatuses: ["complete", "complete", "complete"],
          events: [],
          rollup: { open_blockers: 0, open_follow_ups: 0 },
        }),
      },
      {
        key: registrarEvents("reg-story-2"),
        data: { events: [] },
      },
    ],
  },
};

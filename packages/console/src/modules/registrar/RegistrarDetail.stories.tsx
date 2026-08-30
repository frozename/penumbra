import type { Meta, StoryObj } from "@storybook/react";
import { Route, Routes } from "react-router-dom";
import { registrarDetail } from "@src/lib/query-keys";
import { RegistrarDetail } from "./RegistrarDetail";
import { makeStoryDetail } from "./fixtures";

const meta: Meta<typeof RegistrarDetail> = {
  title: "Registrar/RegistrarDetail",
  component: RegistrarDetail,
};

export default meta;
type Story = StoryObj;

export const EmptyJournal: Story = {
  render: () => (
    <Routes>
      <Route path="/registrar/:registrarId" element={<RegistrarDetail />} />
    </Routes>
  ),
  parameters: {
    initialRoute: "/registrar/reg-story-1",
    queryCache: [
      {
        key: registrarDetail("reg-story-1"),
        data: makeStoryDetail({ events: [] }),
      },
      {
        key: [...registrarDetail("reg-story-1"), "events"],
        data: { events: [] },
      },
    ],
  },
};

export const OneOpenBlocker: Story = {
  render: () => (
    <Routes>
      <Route path="/registrar/:registrarId" element={<RegistrarDetail />} />
    </Routes>
  ),
  parameters: {
    initialRoute: "/registrar/reg-story-1",
    queryCache: [
      {
        key: registrarDetail("reg-story-1"),
        data: makeStoryDetail({ rollup: { open_blockers: 1, open_follow_ups: 1 } }),
      },
      {
        key: [...registrarDetail("reg-story-1"), "events"],
        data: { events: makeStoryDetail({}).events },
      },
    ],
  },
};

export const AllPhasesComplete: Story = {
  render: () => (
    <Routes>
      <Route path="/registrar/:registrarId" element={<RegistrarDetail />} />
    </Routes>
  ),
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
        key: [...registrarDetail("reg-story-2"), "events"],
        data: { events: [] },
      },
    ],
  },
};

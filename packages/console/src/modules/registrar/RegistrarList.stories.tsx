import type { Meta, StoryObj } from "@storybook/react";
import { registrarDetail, registrarList } from "@src/lib/query-keys";
import { RegistrarList } from "./RegistrarList";
import { makeStoryDetail, makeStoryEntry } from "./fixtures";

const meta: Meta<typeof RegistrarList> = {
  title: "Registrar/RegistrarList",
  component: RegistrarList,
};

export default meta;
type Story = StoryObj;

export const Empty: Story = {
  render: () => <RegistrarList />,
  parameters: {
    queryCache: [{ key: registrarList(), data: { entries: [] } }],
  },
};

export const OneOpenBlocker: Story = {
  render: () => <RegistrarList />,
  parameters: {
    queryCache: [
      {
        key: registrarList(),
        data: { entries: [makeStoryEntry({ registrar_id: "reg-story-1", title: "Blocked rollout" })] },
      },
      {
        key: registrarDetail("reg-story-1"),
        data: makeStoryDetail({
          entry: { registrar_id: "reg-story-1", title: "Blocked rollout" },
          rollup: { open_blockers: 1, open_follow_ups: 0 },
        }),
      },
    ],
  },
};

export const AllPhasesComplete: Story = {
  render: () => <RegistrarList />,
  parameters: {
    queryCache: [
      {
        key: registrarList(),
        data: {
          entries: [
            makeStoryEntry({
              registrar_id: "reg-story-2",
              slug: "plan-done",
              title: "Shipped initiative",
              status: "complete",
            }),
          ],
        },
      },
      {
        key: registrarDetail("reg-story-2"),
        data: makeStoryDetail({
          entry: {
            registrar_id: "reg-story-2",
            slug: "plan-done",
            title: "Shipped initiative",
            status: "complete",
          },
          phaseStatuses: ["complete", "complete", "complete", "complete", "complete"],
          events: [],
          rollup: { open_blockers: 0, open_follow_ups: 0 },
        }),
      },
    ],
  },
};

import type { Meta, StoryObj } from "@storybook/react";

import { registrarList } from "@src/lib/query-keys";

import { makeStoryEntry } from "./fixtures";
import { RegistrarList } from "./RegistrarList";

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
        data: {
          entries: [
            makeStoryEntry({
              registrar_id: "reg-story-1",
              title: "Blocked rollout",
              rollup: { open_blockers: 1, open_follow_ups: 0 },
              phase_progress: { complete: 1, total: 3 },
            }),
          ],
        },
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
              rollup: { open_blockers: 0, open_follow_ups: 0 },
              phase_progress: { complete: 5, total: 5 },
            }),
          ],
        },
      },
    ],
  },
};

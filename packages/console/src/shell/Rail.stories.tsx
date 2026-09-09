import type { Meta, StoryObj } from "@storybook/react";

import { approvalsDrafts, approvalsHandoffs, approvalsPermissions } from "../lib/query-keys";
import { Rail } from "./Rail";

const meta: Meta<typeof Rail> = {
  title: "Shell/Rail",
  component: Rail,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const NoBadge: Story = {
  parameters: {
    queryCache: [
      { key: approvalsHandoffs(), data: [] },
      { key: approvalsPermissions(), data: [] },
      { key: approvalsDrafts(), data: [] },
    ],
    initialRoute: "/mission",
  },
};

export const WithBadge3: Story = {
  parameters: {
    queryCache: [
      {
        key: approvalsHandoffs(),
        data: [
          { id: "h-1", ts: "2026-05-09T05:00:00.000Z", title: "handoff 1" },
          { id: "h-2", ts: "2026-05-09T05:00:00.000Z", title: "handoff 2" },
          { id: "h-3", ts: "2026-05-09T05:00:00.000Z", title: "handoff 3" },
        ],
      },
      { key: approvalsPermissions(), data: [] },
      { key: approvalsDrafts(), data: [] },
    ],
    initialRoute: "/mission",
  },
};

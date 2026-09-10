import type { Meta, StoryObj } from "@storybook/react";

import { Route, Routes } from "react-router-dom";

import { dispatchAudit, dispatchEvents, handoffDetail } from "@src/lib/query-keys";

import { makeDispatchAuditResponse, makeDispatchEvent, makeHandoffDetail } from "./fixtures";
import { HandoffDetail } from "./HandoffDetail";

const meta: Meta<typeof HandoffDetail> = {
  component: HandoffDetail,
  title: "Handoffs/HandoffDetail",
};

export default meta;

type Story = StoryObj;

const TS = "2026-09-07T10:00:00.000Z";

export const Complete: Story = {
  render: () => (
    <Routes>
      <Route path="/handoffs/:handoffId" element={<HandoffDetail />} />
    </Routes>
  ),
  parameters: {
    initialRoute: "/handoffs/h-abc12345",
    queryCache: [
      {
        key: handoffDetail("h-abc12345"),
        data: makeHandoffDetail({
          message: "implement the handoffs module",
          to_agent: "codex",
          branch_name: "feat/handoffs",
          use_worktree: true,
          status: "completed",
        }),
      },
      {
        key: dispatchEvents("h-abc12345"),
        data: {
          events: [
            makeDispatchEvent({ kind: "dispatch.start", ts: TS }),
            makeDispatchEvent({ kind: "agent.heartbeat", ts: "2026-09-07T10:05:00.000Z" }),
            makeDispatchEvent({ kind: "dispatch.end", ts: "2026-09-07T10:10:00.000Z" }),
          ],
        },
      },
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

export const Stale: Story = {
  render: () => (
    <Routes>
      <Route path="/handoffs/:handoffId" element={<HandoffDetail />} />
    </Routes>
  ),
  parameters: {
    initialRoute: "/handoffs/h-stale1234",
    queryCache: [
      {
        key: handoffDetail("h-stale1234"),
        data: makeHandoffDetail({
          handoff_id: "h-stale1234",
          message: "long-running dispatch",
          to_agent: "gemini",
          status: "dispatched",
        }),
      },
      {
        key: dispatchEvents("h-stale1234"),
        data: {
          events: [
            makeDispatchEvent({
              handoff_id: "h-stale1234",
              kind: "dispatch.start",
              ts: TS,
            }),
          ],
        },
      },
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

import type { DaemonClient } from "@src/daemon-client.js";

import { workflowHistoryHandler } from "@src/tools/workflow-history.js";
import { expect, mock, test } from "bun:test";

import { fakeDaemon } from "../helpers.js";

type WorkflowHistoryFn = DaemonClient["workflowHistory"];

test("passes name to daemon.workflowHistory and returns wrapped text content", async () => {
  const workflowHistory = mock<WorkflowHistoryFn>(() =>
    Promise.resolve({
      history: [{ ran_at: "2026-05-04T00:00:00.000Z", outcome: "success" }],
    }),
  );
  const handler = workflowHistoryHandler(fakeDaemon({ workflowHistory }));
  const r = await handler({ name: "demo" });
  expect(workflowHistory).toHaveBeenCalledWith({ name: "demo" });
  const block = r.content[0];
  if (!block) {
    throw new Error("expected content[0]");
  }
  expect(JSON.parse(block.text)).toEqual({
    history: [{ ran_at: "2026-05-04T00:00:00.000Z", outcome: "success" }],
  });
});

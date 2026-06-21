import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { workflowListHandler } from "../../src/tools/workflow-list.js";
import { fakeDaemon } from "../helpers.js";

type WorkflowListFn = DaemonClient["workflowList"];

test("calls daemon.workflowList and returns wrapped text content", async () => {
  const workflowList = mock<WorkflowListFn>(() =>
    Promise.resolve({
      workflows: [{ name: "a", description: "D", triggers: [] }],
    }),
  );
  const handler = workflowListHandler(fakeDaemon({ workflowList }));
  const r = await handler();
  expect(workflowList).toHaveBeenCalled();
  const block = r.content[0];
  if (!block) {
    throw new Error("expected content[0]");
  }
  expect(JSON.parse(block.text)).toEqual({
    workflows: [{ name: "a", description: "D", triggers: [] }],
  });
});
